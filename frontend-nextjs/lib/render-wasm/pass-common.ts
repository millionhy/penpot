// Shared $APP primitives of the compiled renderer, kept for the paths that
// still run on it (the workspace canvas and the dashboard thumbnail worker).
//
// The viewer and the one-shot frame render moved to the TypeScript engine
// (G4.5b); their queue and blit live in lib/render-wasm/render-queue.ts. What
// remains here are the two render-sync entry points and the dpr read the
// workspace canvas needs, all through $APP.
//
// The F6.5 probe verified against the compiled bundle and at runtime:
// - set-viewer-viewport! and resize-offscreen-canvas! are NOT on $APP
//   (Closure inlined them); the engine owns their ports now.
// - render-sync-shape ends with `set! wasm/internal-frame-id nil`; every
//   access to that var compiles to a $APP property read/write, so the
//   assignment below is the exact equivalent.

import { call, KEY, uuidToU32, type RendererApp } from "./interop";

// render-sync-shape (app.render-wasm.api): push the final render of `id`
// synchronously, so the offscreen canvas holds the frame when the blit
// reads it. The compiled render-callback contract expects the caller to
// render (without a callback the compiler falls back to request-render).
export function renderSyncShape(app: RendererApp, id: string): void {
  const [a, b, c, d] = uuidToU32(id);
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._render_sync_shape(a, b, c, d);
  app[KEY.internalFrameId] = null;
}

// render-sync (app.render-wasm.api): the whole-viewport counterpart of
// renderSyncShape, used by the thumbnail pass when the page has no frame
// marked use-for-thumbnail. Same ending: the internal call paints, then the
// scheduled-render handle is cleared.
export function renderSync(app: RendererApp): void {
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._render_sync();
  app[KEY.internalFrameId] = null;
}

// get-dpr answers the wasm-set dpr or window.devicePixelRatio; guard
// against anything else (the CLJS falls back to 1.0).
export function readDpr(app: RendererApp): number {
  const dpr = call(app, KEY.getDpr);
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}
