// Shared primitives of the viewer's offscreen render pipeline (F6.5), the
// pieces app.main.render-viewer-wasm keeps private: the global render queue,
// the offscreen-to-visible blit and the two api entry points the optimizer
// inlined away.
//
// The F6.5 probe verified against the compiled bundle and at runtime:
// - set-viewer-viewport! is NOT on $APP (Closure inlined it); its body is
//   `_set_view(zoom, -x, -y)` + `_set_view_end()` guarded by initialized?
//   (= wasm/ready?), and setViewerViewport (below) replicates exactly that.
// - resize-offscreen-canvas! is likewise inlined; its body sets the canvas
//   physical size, then `_set_render_options(dpr)` + `_resize_viewbox(css-w,
//   css-h)` behind the wasm/live? guard. resizeOffscreenCanvas replicates it.
// Both were verified in a live pass: the fresh pass, the reuse pass and the
// pass after a resize all painted pixels onto the blit target.

import { arrayMap, call, keyword, KEY, type RendererApp } from "./interop";

// The four big-endian u32 words of a uuid string, the shape the wasm ABI
// takes. Mirrors uuid/get-u32 (getUnsignedParts in
// common/src/app/common/uuid_impl.js): every 8 hex digits of the dashless
// string read as one big-endian u32.
export function uuidToU32(id: string): [number, number, number, number] {
  const hex = id.replace(/-/g, "");
  return [
    Number.parseInt(hex.slice(0, 8), 16),
    Number.parseInt(hex.slice(8, 16), 16),
    Number.parseInt(hex.slice(16, 24), 16),
    Number.parseInt(hex.slice(24, 32), 16),
  ];
}

// enqueue-wasm-render!: one offscreen render starts only when the previous
// finished. The chain itself never stays rejected.
let queue: Promise<unknown> = Promise.resolve();

export function enqueueRender<T>(task: () => Promise<T>): Promise<T> {
  const result = queue.then(task, task);
  queue = result.catch(() => undefined);
  return result;
}

// render-sync-shape (app.render-wasm.api): push the final render of `id`
// synchronously, so the offscreen canvas holds the frame when the blit
// reads it. This is the step that actually paints the pass — the
// initialize-viewport render-callback contract expects the caller to
// render (without a callback the compiler falls back to request-render).
export function renderSyncShape(app: RendererApp, id: string): void {
  const [a, b, c, d] = uuidToU32(id);
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._render_sync_shape(a, b, c, d);
  // The compiled render-sync-shape ends with set! wasm/internal-frame-id
  // nil; every access to that var compiles to a $APP property read/write,
  // so the assignment here is the exact equivalent.
  app[KEY.internalFrameId] = null;
}

// draw-bitmap!: GPU-side blit of the offscreen canvas through an
// ImageBitmap (correct orientation, no CPU readback) plus the canvas id
// the handlers look for. `finish` always runs, also when the blit fails —
// the compiled original catches and continues in a scheduled task, the
// port reports the failure instead of raising.
export async function drawBitmap(
  canvas: HTMLCanvasElement,
  osCanvas: OffscreenCanvas,
  id: string,
  width: number,
  height: number,
  finish: () => void,
): Promise<void> {
  try {
    const bitmap = await createImageBitmap(osCanvas);
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const ctx = canvas.getContext("2d");
        ctx?.clearRect(0, 0, width, height);
        ctx?.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();
        canvas.id = `screenshot-${id}`;
        resolve();
      });
    });
    finish();
  } catch (cause) {
    // Match the compiled catch: the pass completes, the error is reported.
    console.error("[render-wasm] viewer canvas blit failed:", cause);
    finish();
  }
}

// The soft teardown options shared by every clear-canvas call site:
// lose-browser-context? false keeps the context resumable.
export function softClearOptions(app: RendererApp): unknown {
  return arrayMap(app, [[keyword(app, "lose-browser-context?"), false]]);
}

// set-viewer-viewport! (inlined by the optimizer, see the module comment).
// `vbox` is the design-space top-left corner of the view.
export function setViewerViewport(
  app: RendererApp,
  zoom: number,
  vbox: { x: number; y: number },
): void {
  if (call(app, KEY.wasmReady) !== true) return;
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._set_view(zoom, -vbox.x, -vbox.y);
  internal._set_view_end();
}

// resize-offscreen-canvas! (inlined by the optimizer, see the module
// comment). The caller passes the physical canvas size; the viewbox takes
// the css size, hence the dpr division.
export function resizeOffscreenCanvas(
  app: RendererApp,
  canvas: OffscreenCanvas,
  physicalW: number,
  physicalH: number,
): void {
  if (call(app, KEY.wasmLive) !== true) return;
  const dpr = readDpr(app);
  canvas.width = physicalW;
  canvas.height = physicalH;
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._set_render_options(dpr);
  internal._resize_viewbox(physicalW / dpr, physicalH / dpr);
}

// get-dpr answers the wasm-set dpr or window.devicePixelRatio; guard
// against anything else (the CLJS falls back to 1.0).
export function readDpr(app: RendererApp): number {
  const dpr = call(app, KEY.getDpr);
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

// clear-render-include-filter! of the viewer's fixed-scroll layer. Its
// $APP entry point was inlined away too (runtime-verified: undefined), so
// this replicates the body: one internal call behind the initialized?
// guard (= wasm/ready?).
export function clearRenderIncludeFilter(app: RendererApp): void {
  if (call(app, KEY.wasmReady) !== true) return;
  const internal = app[KEY.internalModule] as Record<string, (...args: number[]) => unknown>;
  internal._clear_render_include_filter();
}

// viewer-apply-layer-mask! / viewer-restore-layer-mask!. The F6.5 viewer
// runs with empty masks, which reduces both to the unconditional reset; the
// id paths (set-render-include-filter!, use-shape plus the fills
// serializer) need their own slice and throw here until it lands.
export function applyLayerMask(
  app: RendererApp,
  includeIds: readonly string[],
  clearFillsIds: readonly string[],
): void {
  clearRenderIncludeFilter(app);
  if (includeIds.length > 0 || clearFillsIds.length > 0) {
    throw new Error("render-wasm: layer masks with ids need the fixed-layer slice");
  }
}

export function restoreLayerMask(
  app: RendererApp,
  clearFillsIds: readonly string[],
): void {
  clearRenderIncludeFilter(app);
  if (clearFillsIds.length > 0) {
    throw new Error("render-wasm: layer masks with ids need the fixed-layer slice");
  }
}
