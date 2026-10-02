// Transit RPC transport for the Next.js shell. Faithful port of the request shape
// in frontend/src/app/main/repo.cljs (send!/cmd!): endpoint, method selection,
// headers, cookie credentials, retry-on-GET, and typed errors.
//
// The Clojure backend is UNCHANGED: this client speaks the exact protocol the
// CLJS frontend already speaks, which is what makes the Strangler Fig migration
// safe and lets pages be migrated one route at a time.

import { config } from "./config";
import { decodeTransit, encodeParams } from "./transit";
import { RpcError, isRetryable, type RpcErrorData } from "./errors";

const METHODS_BASE = "api/main/methods/";

export interface RpcOptions {
  // Force the HTTP method. Defaults to GET for "get-*" commands, POST otherwise.
  method?: "get" | "post";
  signal?: AbortSignal;
}

const defaultRetry = { maxRetries: 3, baseDelayMs: 1000 };

function joinUrl(base: string, path: string): string {
  const b = base.endsWith("/") ? base.slice(0, -1) : base;
  const p = path.startsWith("/") ? path.slice(1) : path;
  return b.length > 0 ? b + "/" + p : "/" + p;
}

function toQuery(params: Record<string, unknown>): string {
  const usp = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    usp.append(key, String(value));
  }
  const s = usp.toString();
  return s.length > 0 ? "?" + s : "";
}

async function classifyAndThrow(res: Response, uri: string): Promise<never> {
  const status = res.status;
  const text = await res.text();
  let body: unknown = null;
  if (text.length > 0) {
    try {
      body = decodeTransit(text);
    } catch {
      body = text;
    }
  }
  if (status === 502) throw new RpcError("http error", { type: "bad-gateway", status, uri });
  if (status === 503) throw new RpcError("http error", { type: "service-unavailable", status, uri });
  if (status === 413) {
    throw new RpcError("http error", { type: "validation", code: "request-body-too-large", status, uri });
  }
  const server = res.headers.get("server");
  const cfMitigated = res.headers.get("cf-mitigated");
  if (status === 403 && (server === "cloudflare" || cfMitigated === "challenge")) {
    throw new RpcError("http error", { type: "authorization", code: "challenge-required", status, uri });
  }
  if (status >= 400 && body && typeof body === "object") {
    throw new RpcError("http error", { ...(body as RpcErrorData), uri, status });
  }
  throw new RpcError("unable to process repository response", {
    type: "internal",
    code: "unable-to-process-repository-response",
    status,
    uri,
  });
}

async function once<T>(
  method: "get" | "post",
  uri: string,
  params: Record<string, unknown>,
  opts: RpcOptions,
): Promise<T> {
  const headers: Record<string, string> = {
    accept: "application/transit+json,text/event-stream,*/*",
    "x-session-id": config.sessionId,
  };
  const init: RequestInit = {
    method: method.toUpperCase(),
    credentials: "include",
    headers,
    signal: opts.signal,
  };
  let url = uri;
  if (method === "post") {
    headers["content-type"] = "application/transit+json";
    init.body = encodeParams(params);
  } else {
    url = uri + toQuery(params);
  }

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // fetch network-level failure -> :network (retryable), matching repo.cljs.
    const message = err instanceof Error ? err.message : "network error";
    throw new RpcError(message, { type: "network", uri });
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.startsWith("text/event-stream")) {
    // SSE commands (the ::sse/* set in repo.cljs) are not implemented yet.
    throw new RpcError("sse stream not supported by this transport yet", {
      type: "internal",
      code: "unexpected-response",
      status: res.status,
      uri,
    });
  }
  if (res.status === 204) return undefined as T;
  if (!res.ok) await classifyAndThrow(res, uri);
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return decodeTransit<T>(text);
}

async function withRetry<T>(run: () => Promise<T>): Promise<T> {
  let attempt = 0;
  for (;;) {
    try {
      return await run();
    } catch (err) {
      if (attempt < defaultRetry.maxRetries && isRetryable(err)) {
        const delay = defaultRetry.baseDelayMs * Math.pow(2, attempt);
        attempt += 1;
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      throw err;
    }
  }
}

// cmd! equivalent: GET (idempotent, retried) for "get-*", POST otherwise.
export async function cmd<T = unknown>(
  id: string,
  params: object = {},
  opts: RpcOptions = {},
): Promise<T> {
  const method: "get" | "post" = opts.method ?? (id.startsWith("get-") ? "get" : "post");
  const uri = joinUrl(config.publicUri, METHODS_BASE + id);
  const record = params as unknown as Record<string, unknown>;
  const run = () => once<T>(method, uri, record, opts);
  return method === "get" ? withRetry(run) : run();
}