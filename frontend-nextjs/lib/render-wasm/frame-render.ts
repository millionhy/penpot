// One-shot frame-to-bitmap render: the shell-side port of the compiled
// frontend's app.main.render-viewer-wasm/render-to-canvas. Since G4.5b the
// pass drives the TypeScript engine directly, in the same order the
// compiled code runs it:
//
//   initCanvasContext(offscreen) → initializeViewport(force-sync,
//   render) → [render] wasm UI overlay off → renderSyncShape
//   (the actual final render) → blit through createImageBitmap →
//   clearCanvas → resetViewerSnapshot!
//
// The queue, the blit and the snapshot live in lib/render-wasm/render-queue
// and lib/render-wasm/viewer-render, shared with the viewer pass. The
// snapshot reset keeps the compiled contract: after a one-shot render the
// viewer's shared offscreen canvas is gone, so the next viewer pass
// rebuilds its context instead of reusing a torn-down one.
//
// Differences from the compiled original, documented:
// - The original also flips wasm/disable-request-render? around the pass;
//   the engine keeps that flag internal. The pass is short and runs on the
//   shared queue, so no interleaved request-render can observe the mid-pass
//   state.
// - The compiled `on-render` reached the pass only after process-pending
//   awaited the image and font work. The engine calls `render` right after
//   the upload, so the port awaits ViewerHost#settle first.
// - The original blits via draw-bitmap! (createImageBitmap + rAF, because
//   Firefox+NVIDIA cannot drawImage a managed OffscreenCanvas directly);
//   the same steps live in drawBitmap, including the "#screenshot-<id>"
//   marker the CLJS original sets on the canvas.

import {
  clearCanvas,
  initCanvasContext,
  initializeViewport,
  renderSyncShape,
  setObjects,
  setRulersFrameVisible,
  setRulersVisible,
  type Point,
  type RenderWasmModule,
  type ShapeObjects,
} from "./engine";
import { drawBitmap, enqueueRender } from "./render-queue";
import { resetViewerSnapshot } from "./viewer-render";
import type { ViewerHost } from "./viewer-host";

export interface FrameRenderOptions {
  // The image/font half of the upload (see ViewerHost).
  host?: ViewerHost;
}

async function renderFrame(
  module: RenderWasmModule,
  objects: ShapeObjects,
  frameId: string,
  canvas: HTMLCanvasElement,
  origin: Point,
  scale: number,
  options: FrameRenderOptions,
): Promise<void> {
  const width = canvas.width;
  const height = canvas.height;
  const osCanvas = new OffscreenCanvas(width, height);
  if (initCanvasContext(module, osCanvas) === undefined) {
    throw new Error("render-wasm: frame render could not create a GL context");
  }

  await new Promise<void>((resolve, reject) => {
    // The render callback fires exactly once (setObjects' completion); the
    // latch guards a double fire all the same.
    let fired = false;
    const onRender = (): void => {
      if (fired) return;
      fired = true;
      void (async () => {
        try {
          await options.host?.settle();
          setRulersFrameVisible(module, false);
          setRulersVisible(module, false);
          renderSyncShape(module, frameId);
          await new Promise<void>((blitDone) => {
            void drawBitmap(canvas, osCanvas, frameId, width, height, blitDone);
          });
          // The compiled pass ends with clearCanvas (context kept:
          // loseBrowserContext false) plus a snapshot reset, handing the
          // shared wasm runtime back; the viewer rebuilds on the next pass.
          clearCanvas(module, { loseBrowserContext: false });
          resetViewerSnapshot();
          resolve();
        } catch (cause) {
          reject(cause);
        }
      })();
    };

    const started = initializeViewport(module, objects, scale, origin, {
      backgroundOpacity: 0,
      setObjects: (pageObjects) => {
        setObjects(module, pageObjects, {
          forceSync: true,
          onShape: (shape) => options.host?.hostAttrs(shape),
          render: onRender,
        });
      },
    });
    if (!started) {
      reject(new Error("render-wasm: frame render could not initialize the viewport"));
    }
  });
}

// The one-shot wasm render of a frame into `canvas` (whose physical size
// the caller must set first). Serialized globally; resolves once the
// bitmap landed and the shared context was torn down.
export function renderFrameToCanvas(
  module: RenderWasmModule,
  objects: ShapeObjects,
  frameId: string,
  canvas: HTMLCanvasElement,
  origin: Point,
  scale: number,
  options: FrameRenderOptions = {},
): Promise<void> {
  return enqueueRender(() => renderFrame(module, objects, frameId, canvas, origin, scale, options));
}
