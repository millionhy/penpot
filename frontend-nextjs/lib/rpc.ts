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
    // SSE commands (the ::sse/* set in repo.cljs) go through cmdSse below; a
    // stream landing here means the caller picked the wrong transport.
    throw new RpcError("sse stream needs cmdSse, not cmd", {
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

// --- Server-sent events (F5.3) -----------------------------------------------
//
// The ::sse/* commands of app.main.repo (restore-deleted-team-files,
// permanently-delete-team-files, clone-template, ...) POST a transit body and
// answer text/event-stream instead of one transit document. The CLJS client
// pipes that body through eventsource-parser (app.util.sse); the shell has no
// such dependency, so the block parser lives here as a pure function and
// cmdSse drives the reader.

// One complete SSE block, still undecoded: `data` is the joined payload of
// every "data:" field.
export interface SseBlock {
  type: string;
  data: string;
}

export interface SseParseResult {
  blocks: SseBlock[];
  // Trailing text of an incomplete block; prepend it to the next chunk.
  rest: string;
}

// Split raw stream text into complete blocks. Blocks end on a blank line,
// "event:" defaults to "message", repeated "data:" fields join with "\n" and
// comment lines (a leading ":") are dropped, per the EventStream parsing
// rules eventsource-parser implements. A block that carries neither a named
// event nor data is a keep-alive and is skipped.
export function parseSseBlocks(buffer: string): SseParseResult {
  const blocks: SseBlock[] = [];
  const parts = buffer.split(/\r\n\r\n|\n\n|\r\r/);
  const rest = parts.pop() ?? "";
  for (const part of parts) {
    let type = "message";
    const data: string[] = [];
    for (const line of part.split(/\r\n|\n|\r/)) {
      if (line.length === 0 || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") type = value;
      else if (field === "data") data.push(value);
    }
    if (data.length === 0 && type === "message") continue;
    blocks.push({ type, data: data.join("\n") });
  }
  return { blocks, rest };
}

// A decoded stream message: `payload` is the transit-decoded data field, or
// undefined when the block carried none.
export interface SseMessage {
  type: string;
  payload: unknown;
}

export interface SseOptions {
  signal?: AbortSignal;
  // Every block that is neither "end" nor "error": the "progress" blocks of
  // the bulk file operations, the per-file blocks of clone-template.
  onMessage?: (message: SseMessage) => void;
}

async function drainSse(res: Response, onBlock: (block: SseBlock) => void): Promise<void> {
  const body = res.body;
  if (body === null || body === undefined) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done === true) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      const parsed = parseSseBlocks(buffer);
      buffer = parsed.rest;
      for (const block of parsed.blocks) onBlock(block);
    }
    // A server that closes without the trailing blank line still ends on a
    // complete block.
    buffer += decoder.decode();
    const tail = parseSseBlocks(buffer + "\n\n");
    for (const block of tail.blocks) onBlock(block);
  } finally {
    // read-stream in app.util.sse cancels the reader on unsubscribe; an
    // "error" block throws out of onBlock and must not leave the body open.
    await reader.cancel().catch(() => undefined);
  }
}

// The ::sse/* branch of cmd!. "error" blocks throw with the server error map
// (read-stream in app.util.sse), the "end" block resolves the promise with its
// payload, and every other block is reported through onMessage as it arrives.
// There is no retry: these commands mutate.
export async function cmdSse<T = unknown>(
  id: string,
  params: Record<string, unknown> = {},
  opts: SseOptions = {},
): Promise<T> {
  const uri = joinUrl(config.publicUri, METHODS_BASE + id);

  let res: Response;
  try {
    res = await fetch(uri, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/transit+json,text/event-stream,*/*",
        "content-type": "application/transit+json",
        "x-session-id": config.sessionId,
      },
      body: encodeParams(params),
      signal: opts.signal,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new RpcError(message, { type: "network", uri });
  }

  const ctype = res.headers.get("content-type") ?? "";
  if (!ctype.startsWith("text/event-stream")) {
    // The backend answers plain transit when the command is not behind the
    // ::sse/ wrapper (or when it rejected the request outright).
    if (res.status === 204) return undefined as T;
    if (!res.ok) await classifyAndThrow(res, uri);
    const text = await res.text();
    if (text.length === 0) return undefined as T;
    return decodeTransit<T>(text);
  }
  if (!res.ok) await classifyAndThrow(res, uri);

  let result: T | undefined;
  await drainSse(res, (block) => {
    const payload = block.data.length > 0 ? decodeTransit<T>(block.data) : undefined;
    if (block.type === "error") {
      const data = (payload ?? {}) as Partial<RpcErrorData>;
      throw new RpcError("sse stream exception", {
        ...data,
        type: data.type ?? "internal",
        uri,
        status: res.status,
      });
    }
    if (block.type === "end") {
      result = payload;
      return;
    }
    opts.onMessage?.({ type: block.type, payload });
  });
  return result as T;
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

// multipart-upload in repo.cljs: the four commands that carry a Blob
// (update-profile-photo, update-team-photo, upload-file-media-object,
// upload-chunk) POST a FormData body instead of transit, but the response is
// still transit-encoded. The content-type header must be left to the browser so
// the multipart boundary is correct.
//
// A value that is a [Blob, filename] tuple appends as a named file part,
// which is how upload-chunk sends its chunks ((list chunk "chunk-N") in
// app.main.data.uploads).
function isBlobFileTuple(value: unknown): value is [Blob, string] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value[0] instanceof Blob &&
    typeof value[1] === "string"
  );
}

export async function cmdUpload<T = unknown>(
  id: string,
  params: Record<string, unknown>,
  opts: RpcOptions = {},
): Promise<T> {
  const uri = joinUrl(config.publicUri, METHODS_BASE + id);
  const body = new FormData();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined || value === null) continue;
    if (isBlobFileTuple(value)) body.append(key, value[0], value[1]);
    else if (typeof value === "string" || value instanceof Blob) body.append(key, value);
    else body.append(key, String(value));
  }

  let res: Response;
  try {
    res = await fetch(uri, {
      method: "POST",
      credentials: "include",
      headers: {
        accept: "application/transit+json,*/*",
        "x-session-id": config.sessionId,
      },
      signal: opts.signal,
      body,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "network error";
    throw new RpcError(message, { type: "network", uri });
  }

  if (res.status === 204) return undefined as T;
  if (!res.ok) await classifyAndThrow(res, uri);
  const text = await res.text();
  if (text.length === 0) return undefined as T;
  return decodeTransit<T>(text);
}
