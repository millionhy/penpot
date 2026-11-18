// app.http: the node adapter and the middleware chain.
//
// A request walks in through the outermost error mapper, then the body reader,
// the query reader, the param merge, the response encoder, the cookie reader,
// the health shortcut and the router. The order mirrors the `->` thread in the
// CLJS namespace, because each wrapper sees the exchange the previous one
// left.
//
// The CLJS chain reads bodies with `raw-body` behind `inflation` and cookies
// with the `cookies` package. The port keeps the same contract (60mb, gzip /
// deflate / br, utf8, transit only when the content type matches exactly) on
// top of node:zlib and a cookie parser, which drops two runtime dependencies
// and leaves the wire behaviour alone.

import { createServer as createNodeServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { createExchange, type Exchange, type Handler } from "./exchange.js";
import { raise } from "./errors.js";
import { onError as defaultOnError } from "./handlers.js";
import { createLogger, setLevel } from "./logging.js";
import { createRouter, type JobHandlers } from "./router.js";
import { decode, encodeVerbose } from "./transit.js";
import { queryStringToMap } from "./uri.js";
import { get } from "./config.js";
import { version } from "./version.js";

const log = createLogger("app.http");
setLevel("app.http", "info");

const BODY_LIMIT = 60 * 1024 * 1024;
const TRANSIT = "application/transit+json";

type Middleware = (next: Handler) => Handler;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function parseHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}

// The cookies package answers `get(name)`; the adapter only ever reads one
// cookie, so a parser is enough. Values stay url-decoded, like the original.
export function parseCookies(header: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (header === undefined) return out;

  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index < 0) continue;

    const name = part.slice(0, index).trim();
    if (name === "") continue;

    const raw = part.slice(index + 1).trim();
    try {
      out.set(name, decodeURIComponent(raw));
    } catch {
      out.set(name, raw);
    }
  }

  return out;
}

function decodeStream(req: IncomingMessage): Readable {
  const encoding = String(req.headers["content-encoding"] ?? "identity").toLowerCase();

  if (encoding === "identity" || encoding === "") return req;
  if (encoding === "gzip" || encoding === "x-gzip") return req.pipe(createGunzip());
  if (encoding === "deflate" || encoding === "x-deflate") return req.pipe(createInflate());
  if (encoding === "br") return req.pipe(createBrotliDecompress());

  // inflation answers 415 here; the exporter only maps known errors, so this
  // lands as an internal one either way.
  return raise({ type: "internal", code: "unsupported-content-encoding", hint: `unsupported content-encoding: ${encoding}` });
}

// read-body: the whole request as utf8 text, up to the 60mb limit.
export async function readBody(req: IncomingMessage, limit = BODY_LIMIT): Promise<string> {
  const stream = decodeStream(req);
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > limit) {
      return raise({ type: "internal", code: "entity-too-large", hint: `request body exceeds ${limit} bytes` });
    }
    chunks.push(buffer);
  }

  return Buffer.concat(chunks).toString("utf8");
}

const withBodyParams: Middleware = (next) => async (exchange) => {
  if (exchange.request.method !== "post") return next(exchange);

  const req = exchange.request.http?.req;
  if (req === undefined) {
    return raise({ type: "internal", code: "missing-http-request", hint: "the http adapter must build the exchange" });
  }

  const raw = await readBody(req);
  const body = exchange.request.headers["content-type"] === TRANSIT ? decode(raw) : raw;

  return next({ ...exchange, request: { ...exchange.request, body } });
};

const withQueryParams: Middleware = (next) => (exchange) =>
  next({
    ...exchange,
    request: { ...exchange.request, queryParams: queryStringToMap(exchange.request.url.search) },
  });

const withParams: Middleware = (next) => (exchange) => {
  const body = isPlainObject(exchange.request.body) ? exchange.request.body : {};
  return next({
    ...exchange,
    request: { ...exchange.request, params: { ...exchange.request.queryParams, ...body } },
  });
};

const withResponseFormat: Middleware = (next) => async (exchange) => {
  const result = await next(exchange);
  const body = result.response.body;
  const status = result.response.status;

  if (isPlainObject(body)) {
    const text = encodeVerbose(body);
    return {
      ...result,
      response: {
        ...result.response,
        body: text,
        status: status ?? 200,
        headers: {
          ...result.response.headers,
          "content-type": TRANSIT,
          "content-length": String(Buffer.byteLength(text, "utf8")),
        },
      },
    };
  }

  if (body === undefined && status === 200) {
    return { ...result, response: { body: "", status: 204, headers: { "content-length": "0" } } };
  }

  return result;
};

const withAuth = (cookieName: string): Middleware => (next) => (exchange) => {
  const token = exchange.request.cookies.get(cookieName);
  if (token === undefined) return next(exchange);
  return next({ ...exchange, request: { ...exchange.request, authToken: token } });
};

const withHealth: Middleware = (next) => (exchange) => {
  if (exchange.request.path === "/readyz") {
    return { ...exchange, response: { ...exchange.response, status: 200, body: "OK" } };
  }
  return next(exchange);
};

export function withError(next: Handler, onError: (cause: unknown, exchange: Exchange) => Exchange = defaultOnError): Handler {
  return async (exchange) => {
    try {
      return await next(exchange);
    } catch (cause) {
      return onError(cause, exchange);
    }
  };
}

function compose(...middlewares: Middleware[]): Middleware {
  return (next) => middlewares.reduceRight((handler, middleware) => middleware(handler), next);
}

// The same chain app.http/init builds, as a value.
export function createHandler(
  legacy: Handler,
  jobs: JobHandlers,
  onError: (cause: unknown, exchange: Exchange) => Exchange = defaultOnError,
): Handler {
  return compose(
    (next) => withError(next, onError),
    withBodyParams,
    withQueryParams,
    withParams,
    withResponseFormat,
    withAuth("auth-token"),
    withHealth,
  )(createRouter(legacy, jobs));
}

function writeBody(body: unknown, res: ServerResponse): void {
  if (typeof body === "string" || Buffer.isBuffer(body)) {
    res.write(body);
    res.end();
    return;
  }

  const stream = body as Readable;
  stream.pipe(res);
  stream.on("error", (cause) => {
    console.error(cause);
    res.end();
  });
}

function handleResponse(exchange: Exchange, res: ServerResponse): void {
  res.writeHead(exchange.response.status ?? 200, exchange.response.headers);
  writeBody(exchange.response.body ?? "", res);
}

export function createAdapter(handler: Handler): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const exchange = createExchange({
      method: (req.method ?? "get").toLowerCase(),
      path: url.pathname,
      url,
      headers: parseHeaders(req),
      queryParams: {},
      params: {},
      cookies: parseCookies(req.headers.cookie),
      http: { req, res },
    });

    Promise.resolve(handler(exchange))
      .then((result) => handleResponse(result, res))
      .catch((cause) => {
        log.error({ hint: "unable to write the response", cause });
        if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
        res.end();
      });
  };
}

export function createHttpServer(handler: Handler): Server {
  return createNodeServer(createAdapter(handler));
}

let instance: Server | undefined;

export async function init(legacy: Handler, jobs: JobHandlers): Promise<Server> {
  const server = createHttpServer(createHandler(legacy, jobs));
  const port = get("http-server-port", 6061);

  await new Promise<void>((resolve) => server.listen(port, () => resolve()));

  log.info({
    hint: "welcome to penpot",
    module: "exporter",
    flags: Array.from(get("flags")),
    version: version.full,
  });
  log.info({ hint: "starting http server", port });

  instance = server;
  return server;
}

export async function stop(): Promise<void> {
  const server = instance;
  if (server === undefined) return;

  await new Promise<void>((resolve) => {
    server.close(() => {
      log.info({ hint: "shutdown http server" });
      resolve();
    });
  });

  instance = undefined;
}