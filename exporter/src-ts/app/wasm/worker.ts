// app.wasm.worker: render worker entry point.
//
// Owns one render-wasm module and renders one export request at a time. The
// Skia calls are synchronous, so running them here is what lets several exports
// progress at once: the main thread keeps serving http, zipping and uploading
// while this thread is blocked inside a render.
//
// Messages in:  {type: "render", params: <transit>, cancel: SharedArrayBuffer}
// Messages out: {type: "ready"}
//               {type: "object", payload: <transit>}   one per rendered object
//               {type: "done"} | {type: "error", message, code}
//
// Mirrors `exporter/src/app/wasm/worker.cljs`.

import { parentPort } from "node:worker_threads";
import { errorData, errorMessage, raise } from "../errors.js";
import { createLogger, setLevel } from "../logging.js";
import { decode, encode } from "../transit.js";
import { render as renderScene } from "./render.js";

const log = createLogger("app.wasm.worker");
setLevel("app.wasm.worker", "info");

export interface WorkerPortLike {
  postMessage(message: unknown): void;
  on(event: "message", listener: (data: unknown) => void): unknown;
}

export type Renderer = (
  params: Record<string, unknown>,
  onObject: (object: unknown) => unknown,
) => Promise<unknown>;

let port: WorkerPortLike | undefined;
let renderer: Renderer = renderScene as unknown as Renderer;
let installed = false;

export function setParentPort(next: WorkerPortLike | undefined): void {
  port = next;
}

export function setRenderer(next: Renderer | undefined): void {
  renderer = next ?? (renderScene as unknown as Renderer);
}

// Test hook: forget the installed listener and the injected port.
export function reset(): void {
  port = undefined;
  installed = false;
  renderer = renderScene as unknown as Renderer;
}

function parent(): WorkerPortLike {
  if (port !== undefined) return port;
  if (parentPort === null) {
    return raise({
      type: "internal",
      code: "worker-not-ready",
      hint: "render worker has no parent port",
    });
  }
  return parentPort as unknown as WorkerPortLike;
}

function post(message: unknown): void {
  parent().postMessage(message);
}

// The cancel flag is a shared int32; a missing buffer means the render cannot
// be cancelled cooperatively (the caller can still terminate the thread).
export function cancelledFn(buffer: unknown): () => boolean {
  if (buffer instanceof SharedArrayBuffer || buffer instanceof ArrayBuffer) {
    const signal = new Int32Array(buffer);
    return () => Atomics.load(signal, 0) > 0;
  }
  return () => false;
}

interface RenderMessage {
  type?: unknown;
  params?: unknown;
  cancel?: unknown;
}

export async function handleRender(message: RenderMessage): Promise<void> {
  const params = {
    ...decode<Record<string, unknown>>(String(message.params)),
    "cancelled?": cancelledFn(message.cancel),
  };

  try {
    await renderer(params, (object) => {
      post({ type: "object", payload: encode(object) });
    });
    post({ type: "done" });
  } catch (cause) {
    log.warn({ hint: "render worker: request failed", cause });
    post({
      type: "error",
      message: errorMessage(cause) ?? String(cause),
      code: errorData(cause).code,
    });
  }
}

export function onMessage(data: unknown): void {
  const message = (data ?? {}) as RenderMessage;

  switch (message.type) {
    case "render":
      // The drain happens on the event loop; the message handler itself must
      // not await, or a second message could start while the first renders.
      void handleRender(message);
      return;
    default:
      log.warn({ hint: "render worker: unknown message", type: message.type });
  }
}

function install(): void {
  if (installed) return;
  installed = true;
  parent().on("message", (data) => onMessage(data));
}

export function main(): void {
  install();
  post({ type: "ready" });
  log.info({ hint: "render worker ready" });
}