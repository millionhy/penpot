// The dashboard thumbnail worker (F9.14, engine port G4.6a): the off-thread
// half of the reference's :worker build
// (frontend/src/app/worker/thumbnails.cljs, render-thumbnail-with-wasm).
//
// Since G4.6a the worker boots the TypeScript renderer
// (lib/render-wasm/engine) instead of the compiled shared.js: no page globals,
// no $APP, and no transit read handler registered here. The worker must still
// be served from an http URL, not a blob URL: the engine resolves
// js/render-wasm.js against the worker origin and the glue fetches the .wasm
// payload from the same base. new Worker(new URL("./thumbnail.worker.ts",
// import.meta.url)) gives exactly that.

import { loadEngineModule } from "@/lib/render-wasm/engine-boot";
import type { RenderWasmModule } from "@/lib/render-wasm/engine";
import { renderThumbnailFromRaw } from "@/lib/thumbnail-render";
import { THUMBNAIL_WIDTH } from "@/lib/thumbnail";

interface RenderRequest {
  id: number;
  // The undecoded get-file-data-for-thumbnail answer (cmdRaw), decoded here
  // by lib/transit.
  raw: string;
  width?: number;
  // Same-origin base the engine and the media URLs resolve against; the
  // cf/public-uri of the page. Empty means location.origin.
  publicUri?: string;
}

interface RenderResponse {
  id: number;
  blob?: Blob;
  error?: string;
}

// A structural cast instead of DedicatedWorkerGlobalScope: the project's
// tsconfig also loads the DOM lib, whose `self`/postMessage would conflict.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<RenderRequest>) => void) | null;
  postMessage: (message: RenderResponse) => void;
  location: { origin: string };
};

// One boot per worker; a failed boot stays failed so the card pass does not
// retry the whole wasm fetch for every file.
let modulePromise: Promise<RenderWasmModule> | null = null;

// The reference serializes with an rx subject + mapcat; the worker needs the
// same because one wasm context cannot run two passes at once.
let queue: Promise<void> = Promise.resolve();

async function handle(request: RenderRequest): Promise<void> {
  try {
    modulePromise ??= loadEngineModule();
    const module = await modulePromise;
    const publicUri =
      typeof request.publicUri === "string" && request.publicUri.length > 0
        ? request.publicUri
        : scope.location.origin;
    const blob = await renderThumbnailFromRaw(
      module,
      request.raw,
      request.width ?? THUMBNAIL_WIDTH,
      { publicUri },
    );
    scope.postMessage({ id: request.id, blob });
  } catch (cause) {
    scope.postMessage({
      id: request.id,
      error: cause instanceof Error ? cause.message : String(cause),
    });
  }
}

scope.onmessage = (event: MessageEvent<RenderRequest>): void => {
  const request = event.data;
  queue = queue.then(
    () => handle(request),
    () => handle(request),
  );
};