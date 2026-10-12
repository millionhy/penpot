// One-shot frame-to-bitmap render: the shell-side rebuild of the compiled
// frontend's app.main.render-viewer-wasm/render-to-canvas. Closure inlined
// that whole namespace (nothing of it lands on $APP, verified against the
// compiled artifact and at runtime), so this drives the same flow through
// the public app.render-wasm.api primitives, in the same order the compiled
// code runs them:
//
//   init-canvas-context(offscreen) → initialize-viewport(force-sync,
//   on-render) → [on-render] wasm UI overlay off → render-sync-shape
//   (the actual final render) → blit through createImageBitmap →
//   clear-canvas → reset-viewer-snapshot!
//
// The queue, the blit and render-sync-shape live in
// lib/render-wasm/pass-common.ts, shared with the viewer pass
// (lib/render-wasm/viewer-render.ts). The snapshot reset keeps the compiled
// contract: after a one-shot render the viewer's shared offscreen canvas is
// gone, so the next viewer pass rebuilds its context instead of reusing a
// torn-down one.
//
// Differences from the compiled original, documented:
// - The original also flips wasm/disable-request-render? around the pass;
//   that atom is closure-private. The pass is short and runs on the shared
//   queue, so no interleaved request-render can observe the mid-pass state.
// - The original blits via draw-bitmap! (createImageBitmap + rAF, because
//   Firefox+NVIDIA cannot drawImage a managed OffscreenCanvas directly);
//   the same steps live in drawBitmap, including the "#screenshot-<id>"
//   marker the CLJS original sets on the canvas.

import { arrayMap, call, keyword, KEY, type RendererApp } from "./interop";
import {
  drawBitmap,
  enqueueRender,
  renderSyncShape,
  softClearOptions,
  uuidToU32,
} from "./pass-common";
import { resetViewerSnapshot } from "./viewer-render";

// Kept exported for the unit tests (the F6.4 suite covers the uuid split).
export { uuidToU32 };

async function renderFrame(
  app: RendererApp,
  objects: unknown,
  frameId: string,
  canvas: HTMLCanvasElement,
  origin: { x: number; y: number },
  scale: number,
): Promise<void> {
  const width = canvas.width;
  const height = canvas.height;
  const osCanvas = new OffscreenCanvas(width, height);
  if (!call(app, KEY.initCanvasContext, osCanvas)) {
    throw new Error("render-wasm: frame render could not create a GL context");
  }

  await new Promise<void>((resolve, reject) => {
    // on-render fires exactly once (set-objects-sync's process-pending
    // completion callback); the latch guards a double fire all the same.
    let fired = false;
    const onRender = (): void => {
      if (fired) return;
      fired = true;
      void (async () => {
        try {
          call(app, KEY.setRulersFrameVisible, false);
          call(app, KEY.setRulersVisible, false);
          renderSyncShape(app, frameId);
          await new Promise<void>((blitDone) => {
            void drawBitmap(canvas, osCanvas, frameId, width, height, blitDone);
          });
          // The compiled pass ends with clear-canvas (context kept:
          // lose-browser-context? false) plus a snapshot reset, handing the
          // shared wasm runtime back; the viewer rebuilds on the next pass.
          call(app, KEY.clearCanvas, softClearOptions(app));
          resetViewerSnapshot();
          resolve();
        } catch (cause) {
          reject(cause);
        }
      })();
    };

    // initialize-viewport reads only :x/:y from the bounds (the padded
    // origin lands in _set_view).
    const bounds = arrayMap(app, [
      [keyword(app, "x"), origin.x],
      [keyword(app, "y"), origin.y],
    ]);
    call(
      app,
      KEY.initializeViewport,
      objects,
      scale,
      bounds,
      arrayMap(app, [
        [keyword(app, "background-opacity"), 0],
        [keyword(app, "force-sync"), true],
        [keyword(app, "on-render"), onRender],
      ]),
    );
  });
}

// The one-shot wasm render of a frame into `canvas` (whose physical size
// the caller must set first). Serialized globally; resolves once the
// bitmap landed and the shared context was torn down.
export function renderFrameToCanvas(
  app: RendererApp,
  objects: unknown,
  frameId: string,
  canvas: HTMLCanvasElement,
  origin: { x: number; y: number },
  scale: number,
): Promise<void> {
  return enqueueRender(() => renderFrame(app, objects, frameId, canvas, origin, scale));
}
