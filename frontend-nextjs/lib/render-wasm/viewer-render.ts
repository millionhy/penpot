// The viewer's shared offscreen render pass (F6.5), the port of
// app.main.render-viewer-wasm (render-viewer-frame* / viewer-do-render!).
//
// The compiled viewer does not draw straight onto the visible canvas. One
// module-level snapshot holds an OffscreenCanvas with the live GL context;
// every pass re-renders one frame into it through render-sync-shape and
// blits the pixels onto the visible 2D canvas. The snapshot is reused
// across passes (frame and zoom changes) as long as the page, the canvas
// physical size and the dpr all match and the wasm context is still live.
//
// The one-shot render (lib/render-wasm/frame-render.ts, thumbnails and
// exports) shares the same wasm context; it ends with clear-canvas and
// resets this snapshot, so the next viewer pass rebuilds from scratch —
// that is what the compiled original does, too.
//
// Probe-verified against the compiled bundle: set-viewer-viewport! and
// resize-offscreen-canvas! are inlined and absent from $APP; the port
// reaches the same wasm entries through lib/render-wasm/pass-common.ts.
//
// Differences from the compiled original, documented:
// - The compiled pass flips wasm/disable-request-render? true around each
//   pass; that atom is closure-private in this build (not on $APP, verified
//   in the artifact), so the port cannot flip it. The probe ran the same
//   pass chain without it and every pass painted fully: a stray scheduled
//   request-render only re-draws the same view into the offscreen context
//   (no blit), and once the context is torn down wasm/live? answers false
//   and request-render becomes a no-op.

import { KEY, arrayMap, call, keyword, type RendererApp } from "./interop";
import {
  applyLayerMask,
  drawBitmap,
  enqueueRender,
  readDpr,
  renderSyncShape,
  resizeOffscreenCanvas,
  restoreLayerMask,
  setViewerViewport,
  softClearOptions,
} from "./pass-common";
import type { Point } from "../viewer-interactions";

// viewer-snapshot: the reusable offscreen surface plus the key of its
// current content. undefined os-canvas means nothing to reuse.
export interface ViewerSnapshot {
  osCanvas: OffscreenCanvas | undefined;
  pageKey: unknown;
  canvasW: number;
  canvasH: number;
  dpr: number;
}

let snapshot: ViewerSnapshot = {
  osCanvas: undefined,
  pageKey: null,
  canvasW: 0,
  canvasH: 0,
  dpr: 1,
};

// reset-viewer-snapshot!: the compiled one-shot render calls it after its
// clear-canvas; without it a later viewer pass would match the snapshot
// size and reuse an offscreen canvas whose GL context was handed back.
export function resetViewerSnapshot(): void {
  snapshot = { osCanvas: undefined, pageKey: null, canvasW: 0, canvasH: 0, dpr: 1 };
}

export interface ViewerFrameOptions {
  pageKey: unknown;
  // The page objects (the raw decoded map, untouched: the reuse path never
  // re-loads them, exactly like the compiled pass).
  pageObjects: unknown;
  // The padded bounds origin; callers add the viewport delta to x/y
  // (viewer.cljs use-viewer-wasm-layers! bakes it into :render-size).
  size: Point;
  scale: number;
  frameId: string;
  includeIds?: readonly string[];
  clearFillsIds?: readonly string[];
  onRender?: () => void;
}

// viewer-do-render!: one blit pass on an established offscreen canvas.
// Applies the fixed-scroll layer mask around the render (an empty mask is
// a no-op; the fixed layer arrives with a later slice).
function viewerDoRender(
  app: RendererApp,
  osCanvas: OffscreenCanvas,
  canvas: HTMLCanvasElement,
  size: Point,
  scale: number,
  frameId: string,
  options: ViewerFrameOptions,
  finish: () => void,
): void {
  const includeIds = options.includeIds ?? [];
  const clearFillsIds = options.clearFillsIds ?? [];
  const visW = canvas.width;
  const visH = canvas.height;

  try {
    // The workspace chrome (ticks and the rounded viewport frame) is
    // composited by default; the viewer shows the frame alone.
    call(app, KEY.setRulersFrameVisible, false);
    call(app, KEY.setRulersVisible, false);
    applyLayerMask(app, includeIds, clearFillsIds);
    setViewerViewport(app, scale, size);
    renderSyncShape(app, frameId);
    restoreLayerMask(app, clearFillsIds);
    void drawBitmap(canvas, osCanvas, frameId, visW, visH, finish);
  } catch (cause) {
    console.error("[render-wasm] viewer-snapshot: render error", cause);
    finish();
  }
}

// render-viewer-frame*: pick the offscreen canvas (reuse the snapshot or
// rebuild it), render one frame into it and blit.
function renderViewerFramePass(
  app: RendererApp,
  canvas: HTMLCanvasElement,
  options: ViewerFrameOptions,
): Promise<void> {
  return new Promise<void>((resolve) => {
    let finished = false;
    const finish = (): void => {
      if (finished) return;
      finished = true;
      options.onRender?.();
      resolve();
    };

    const visW = canvas.width;
    const visH = canvas.height;
    const dpr = readDpr(app);
    const samePage = options.pageKey !== null && options.pageKey === snapshot.pageKey;
    const sameSize =
      visW === snapshot.canvasW && visH === snapshot.canvasH && dpr === snapshot.dpr;
    const os = snapshot.osCanvas;
    let passStarted = false;
    const startPass = (osCanvas: OffscreenCanvas): void => {
      if (passStarted) return;
      passStarted = true;
      viewerDoRender(app, osCanvas, canvas, options.size, options.scale, options.frameId, options, finish);
    };

    try {
      if (samePage && call(app, KEY.wasmReady) === true && os !== undefined) {
        if (!sameSize) {
          resizeOffscreenCanvas(app, os, visW, visH);
          snapshot.canvasW = visW;
          snapshot.canvasH = visH;
          snapshot.dpr = dpr;
        }
        startPass(os);
        return;
      }

      const osCanvas = new OffscreenCanvas(visW, visH);
      if (call(app, KEY.wasmReady) === true) {
        // Mirror the compiled guard (wasm.api/initialized? = wasm/ready?):
        // an old context is handed back before init-canvas-context builds
        // the new one.
        call(app, KEY.clearCanvas, softClearOptions(app));
      }
      if (call(app, KEY.initCanvasContext, osCanvas) === true) {
        snapshot = {
          osCanvas,
          pageKey: options.pageKey,
          canvasW: visW,
          canvasH: visH,
          dpr,
        };
        call(
          app,
          KEY.initializeViewport,
          options.pageObjects,
          options.scale,
          options.size,
          arrayMap(app, [
            [keyword(app, "background-opacity"), 0],
            [keyword(app, "force-sync"), true],
            [keyword(app, "on-render"), () => startPass(osCanvas)],
          ]),
        );
      } else {
        console.error("[render-wasm] viewer-snapshot: init-canvas-context refused");
        finish();
      }
    } catch (cause) {
      console.error("[render-wasm] viewer-snapshot: render error", cause);
      finish();
    }
  });
}

// render-viewer-frame: the queued entry point, one pass at a time across
// the whole app (thumbnails and the viewer share the wasm context).
export function renderViewerFrame(
  app: RendererApp,
  canvas: HTMLCanvasElement,
  options: ViewerFrameOptions,
): Promise<void> {
  return enqueueRender(() => {
    // The wasm context may have died while this pass waited in the queue
    // (a one-shot render tears it down and resets the snapshot); the
    // dead-context path inside the pass rebuilds it, so the only cost is
    // the wasted snapshot comparison.
    return renderViewerFramePass(app, canvas, options);
  });
}
