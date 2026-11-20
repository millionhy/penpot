// The viewer's shared offscreen render pass (F6.5, engine port of G4.5b),
// the port of app.main.render-viewer-wasm (render-viewer-frame* /
// viewer-do-render!).
//
// The viewer does not draw straight onto the visible canvas. One
// module-level snapshot holds an OffscreenCanvas with the live GL context;
// every pass re-renders one frame into it through renderSyncShape and blits
// the pixels onto the visible 2D canvas. The snapshot is reused across
// passes (frame and zoom changes) as long as the page, the canvas physical
// size and the dpr all match and the wasm context is still live.
//
// The one-shot render (lib/render-wasm/frame-render.ts, thumbnails and
// exports) shares the same wasm context; it ends with clearCanvas and
// resets this snapshot, so the next viewer pass rebuilds from scratch —
// that is what the compiled original does, too.
//
// Unmounting a viewport does not clear that context while another one is
// still mounted (acquireViewerContext / releaseViewerContext); the last
// release hands it back. The compiled viewer never clears on unmount at
// all, so the count is the narrower, still-safe version of that rule.
//
// Differences from the compiled original, documented:
// - The compiled pass flips wasm/disable-request-render? true around each
//   pass; the engine keeps that flag internal, so the port cannot flip it.
//   Every pass runs on the shared queue, and a stray scheduled render only
//   re-draws the same view into the offscreen context (no blit).
// - The fixed-scroll layer mask (include-ids / clear-fills-ids) has no
//   engine counterpart yet: the compiled pass calls set-render-include-
//   filter! and clear-shape-fills!, and the engine does not export either.
//   The viewer therefore paints the whole page in one pass until that slice
//   lands.
// - The on-render callback arrives from setObjects right after the upload;
//   the compiled initialize-viewport reached it through process-pending,
//   which had already awaited the image and font work. The port awaits
//   ViewerHost#settle here instead, in the same place in the chain.
// - pageKey is the page id here; the compiled call site passed the same id
//   (`render-viewer-frame* page-id ...`).

import {
  clearCanvas,
  initCanvasContext,
  initializeViewport,
  readDpr,
  ready,
  renderSyncShape,
  resizeOffscreenCanvas,
  setObjects,
  setRulersFrameVisible,
  setRulersVisible,
  setViewerViewport,
  type Point,
  type RenderWasmModule,
  type ShapeObjects,
} from "./engine";
import { drawBitmap, enqueueRender } from "./render-queue";
import type { ViewerHost } from "./viewer-host";

// viewer-snapshot: the reusable offscreen surface plus the key of its
// current content. undefined osCanvas means nothing to reuse.
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

// reset-viewer-snapshot!: the one-shot render calls it after its
// clearCanvas; without it a later viewer pass would match the snapshot
// size and reuse an offscreen canvas whose GL context was handed back.
export function resetViewerSnapshot(): void {
  snapshot = { osCanvas: undefined, pageKey: null, canvasW: 0, canvasH: 0, dpr: 1 };
}

// How many viewer viewports hold the shared context: the main viewport plus
// every open overlay, since all of them run their passes on it (viewer.cljs
// mounts one viewport per overlay). A closing overlay must not hand the
// context back under the viewport behind it, so the holders count decides
// when the context is really free.
let holders = 0;

export function acquireViewerContext(): void {
  holders += 1;
}

// True when this release leaves no holder: only then does the caller clear
// the shared context and reset the snapshot.
export function releaseViewerContext(): boolean {
  if (holders > 0) holders -= 1;
  return holders === 0;
}

export interface ViewerFrameOptions {
  // The page id: two passes with the same id may reuse the snapshot.
  pageKey: unknown;
  // The page objects (the decoded map, untouched: the reuse path never
  // re-loads them, exactly like the compiled pass).
  pageObjects: ShapeObjects;
  // The padded bounds origin; callers add the viewport delta to x/y
  // (viewer.cljs use-viewer-wasm-layers! bakes it into :render-size).
  size: Point;
  scale: number;
  frameId: string;
  // The image/font half of the upload. Without it the pass paints with
  // whatever the wasm store already holds.
  host?: ViewerHost;
  onRender?: () => void;
}

// viewer-do-render!: one blit pass on an established offscreen canvas.
function viewerDoRender(
  module: RenderWasmModule,
  osCanvas: OffscreenCanvas,
  canvas: HTMLCanvasElement,
  options: ViewerFrameOptions,
  finish: () => void,
): void {
  try {
    // The workspace chrome (ticks and the rounded viewport frame) is
    // composited by default; the viewer shows the frame alone.
    setRulersFrameVisible(module, false);
    setRulersVisible(module, false);
    setViewerViewport(module, options.scale, options.size);
    renderSyncShape(module, options.frameId);
    void drawBitmap(canvas, osCanvas, options.frameId, canvas.width, canvas.height, finish);
  } catch (cause) {
    console.error("[render-wasm] viewer-snapshot: render error", cause);
    finish();
  }
}

// render-viewer-frame*: pick the offscreen canvas (reuse the snapshot or
// rebuild it), render one frame into it and blit.
function renderViewerFramePass(
  module: RenderWasmModule,
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
    const dpr = readDpr();
    const isReady = ready();
    const samePage = options.pageKey !== null && options.pageKey === snapshot.pageKey;
    const sameSize =
      visW === snapshot.canvasW && visH === snapshot.canvasH && dpr === snapshot.dpr;
    const os = snapshot.osCanvas;
    let passStarted = false;

    // The upload already ran; wait for the host work (images and fonts) and
    // then paint once.
    const startPass = (osCanvas: OffscreenCanvas): void => {
      if (passStarted || finished) return;
      passStarted = true;
      void (async () => {
        try {
          await options.host?.settle();
          viewerDoRender(module, osCanvas, canvas, options, finish);
        } catch (cause) {
          console.error("[render-wasm] viewer-snapshot: host settle failed", cause);
          finish();
        }
      })();
    };

    try {
      if (samePage && isReady && os !== undefined) {
        if (!sameSize) {
          resizeOffscreenCanvas(module, os, visW, visH);
          snapshot.canvasW = visW;
          snapshot.canvasH = visH;
          snapshot.dpr = dpr;
        }
        startPass(os);
        return;
      }

      const osCanvas = new OffscreenCanvas(visW, visH);
      if (isReady) {
        // An old context is handed back before initCanvasContext builds
        // the new one (wasm.api/initialized? = ready?).
        clearCanvas(module, { loseBrowserContext: false });
      }
      if (initCanvasContext(module, osCanvas) !== undefined) {
        snapshot = {
          osCanvas,
          pageKey: options.pageKey,
          canvasW: visW,
          canvasH: visH,
          dpr,
        };
        const started = initializeViewport(module, options.pageObjects, options.scale, options.size, {
          // Only the opacity travels: the compiled call had no background
          // color either, so the canvas keeps its transparent clear.
          backgroundOpacity: 0,
          setObjects: (objects) => {
            setObjects(module, objects, {
              forceSync: true,
              onShape: (shape) => options.host?.hostAttrs(shape),
              render: () => startPass(osCanvas),
            });
          },
        });
        if (!started) {
          console.error("[render-wasm] viewer-snapshot: initialize-viewport refused");
          finish();
        }
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
  module: RenderWasmModule,
  canvas: HTMLCanvasElement,
  options: ViewerFrameOptions,
): Promise<void> {
  return enqueueRender(() => {
    // The wasm context may have died while this pass waited in the queue
    // (a one-shot render tears it down and resets the snapshot); the
    // dead-context path inside the pass rebuilds it.
    return renderViewerFramePass(module, canvas, options);
  });
}
