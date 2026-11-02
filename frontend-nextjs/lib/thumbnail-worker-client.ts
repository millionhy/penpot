// The main-thread half of the dashboard thumbnail worker (F9.14).
//
// A card without a stored thumbnail asks generateFileThumbnail for one. The
// RPC stays here (the worker has no session helpers and the raw transit body
// is what the compiled decoder needs), the pixels come back as a PNG Blob
// and lib/thumbnail-persist.ts uploads it as create-file-thumbnail.
//
// A null answer means "no thumbnail this time" — no Worker (the node test
// environment, an old browser), a failed spawn, a worker pass that threw, or
// an RPC error. The card keeps its background and loader; nothing throws at
// the dashboard.
//
// A crashed worker settles every pending request with null, drops the
// instance and lets the next request respawn it, like
// lib/import-analyze-worker-client.ts.

import { config } from "@/lib/config";
import { cmdRaw } from "@/lib/rpc";
import { THUMBNAIL_WIDTH } from "@/lib/thumbnail";

interface RenderResponse {
  id: number;
  blob?: Blob;
  error?: string;
}

type Settle = (blob: Blob | null) => void;

let worker: Worker | null = null;
let nextId = 0;
const pending = new Map<number, Settle>();

function settleAll(): void {
  for (const settle of pending.values()) settle(null);
  pending.clear();
}

function report(message: RenderResponse): void {
  const settle = pending.get(message.id);
  if (settle === undefined) return;
  pending.delete(message.id);
  // The render legs fail quietly for the card, but a worker-side throw is a
  // bug: name it once in the console instead of swallowing it.
  if (typeof message.error === "string" && message.error.length > 0) {
    console.warn("[thumbnail] the worker could not render the thumbnail:", message.error);
  }
  settle(message.blob instanceof Blob ? message.blob : null);
}

function spawn(): Worker | null {
  // The node test environment has no window and no browser Worker.
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  try {
    const created = new Worker(new URL("./thumbnail.worker.ts", import.meta.url), {
      type: "module",
    });
    created.addEventListener("message", (event: MessageEvent<RenderResponse>) => {
      report(event.data);
    });
    created.addEventListener("error", () => {
      settleAll();
      created.terminate();
      if (worker === created) worker = null;
    });
    return created;
  } catch {
    return null;
  }
}

// One wasm render of the raw get-file-data-for-thumbnail answer. The worker
// serializes requests internally, so callers may ask for several at once.
export function renderThumbnailOffThread(
  raw: string,
  width: number = THUMBNAIL_WIDTH,
): Promise<Blob | null> {
  if (worker === null) worker = spawn();
  const running = worker;
  if (running === null) return Promise.resolve(null);
  const id = (nextId += 1);
  return new Promise<Blob | null>((resolve) => {
    pending.set(id, resolve);
    try {
      running.postMessage({ id, raw, width, publicUri: config.publicUri });
    } catch {
      pending.delete(id);
      resolve(null);
    }
  });
}

// The card-facing entry: fetch the page data, then render it off-thread.
// Both legs fail silently (a console warning and a null answer).
export async function generateFileThumbnail(
  fileId: string,
  revn: number,
): Promise<Blob | null> {
  if (typeof window === "undefined" || typeof Worker === "undefined") return null;
  try {
    // strip-frames-with-thumbnails false: the wasm pass wants the real frame
    // contents, not the pruned tree the legacy SVG renderer works with.
    const raw = await cmdRaw("get-file-data-for-thumbnail", {
      "file-id": fileId,
      revn,
      "strip-frames-with-thumbnails": false,
    });
    return await renderThumbnailOffThread(raw);
  } catch (cause) {
    console.warn("[thumbnail] could not generate a thumbnail:", cause);
    return null;
  }
}

// Drop the worker when nobody holds it any more; a StrictMode replay
// respawns it on the next card. Pending requests settle null so their
// effects end.
export function disposeThumbnailRenderer(): void {
  if (worker === null) return;
  worker.terminate();
  worker = null;
  settleAll();
}

// The grids hold the page-scoped worker while they are mounted. Several can
// be mounted at once (the recent view renders one line-grid per project), so
// the worker goes only when the last holder releases it.
let holders = 0;

export function retainThumbnailRenderer(): () => void {
  holders += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders -= 1;
    if (holders === 0) disposeThumbnailRenderer();
  };
}