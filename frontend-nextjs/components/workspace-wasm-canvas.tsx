"use client";

// The workspace canvas (F9.1): the read-only direct-to-canvas viewport of
// the /workspace route. Unlike the viewer (an offscreen blit pipeline),
// the workspace draws straight onto its visible canvas and lets the
// compiled progressive tile renderer run. The load sequence ports the
// workspace branch of app.main.ui.workspace.viewport-wasm:
//
//   loadRenderer -> ensureWasmModule
//   -> init-canvas-context (try-init: one attempt plus three retries,
//      200 ms apart; init also syncs the drawing buffer, since the canvas
//      already has a positive client size)
//   -> loadDecodedWorkspaceFile + workspacePageObjects (the wasm-side
//      resolved model)
//   -> initialize-viewport, once, with the zoom/vbox of
//      lib/workspace-viewport's initialViewport over the page objects of
//      lib/workspace, the page background and an on-shapes-ready marker
//
// The wheel interaction ports ui/workspace/viewport/actions.cljs:
// normalizeWheel, then either the compound-zoom accumulator (ctrl/meta:
// scale multiplies, the pivot is the latest cursor point, one rAF flush
// calls zoomBy) or the scroll accumulator (deltas sum in world units, one
// rAF flush calls scrollBy). Both flushes push the new zoom/vbox into the
// renderer through set-view-box and write the slice back to the store.
// A ResizeObserver ports the [vport] effect pair: resize-canvas! plus
// resize-viewport (center) plus set-view-box.
//
// Deviations from the compiled original, documented:
// - No page-transition blur lifecycle, no focus mode, no dpr-change
//   watcher, no position-data pass, no webgl-unavailable modal and no
//   pixel-overlay / comments-layer wheel branches: this slice renders one
//   page read-only.
// - The wheel listener binds to the canvas itself, so the
//   inside-viewport? guard collapses to always-true and the handlers
//   always prevent-default / stop-propagation.
// - Unmount defers clear-canvas (hard teardown) one task and a remount
//   cancels it: a StrictMode replay must not destroy the context under
//   the live run, and losing the context right before a re-init can fail
//   on some browsers (see clear-canvas in render_wasm/api.cljs).
// - The JS-side file (lib/workspace, for the fit math) and the wasm-side
//   file (workspace-data, for the render model) are two independent
//   get-file reads of the same revision.

import { useEffect, useRef, useState } from "react";

import { ensureWasmModule, loadRenderer } from "@/lib/render-wasm/bridge";
import { KEY, call, sleep, type RendererApp } from "@/lib/render-wasm/interop";
import {
  clearWorkspaceCanvas,
  initializeWorkspaceViewport,
  initWorkspaceCanvas,
  resizeWorkspaceCanvas,
  setWorkspaceViewBox,
} from "@/lib/render-wasm/workspace-render";
import {
  loadDecodedWorkspaceFile,
  workspacePageObjects,
} from "@/lib/render-wasm/workspace-data";
import { isMacos } from "@/lib/shortcuts";
import { pageObjects, type WorkspaceFile } from "@/lib/workspace";
import { setWorkspaceViewport } from "@/lib/workspace-store";
import {
  initialViewport,
  normalizeWheel,
  pointToViewport,
  resizeViewport,
  scrollBy,
  wheelScrollDeltas,
  wheelZoomFactor,
  zoomBy,
  type ViewportPoint,
  type ViewportState,
} from "@/lib/workspace-viewport";

// clr/canvas, the background of a page without one.
const DEFAULT_BACKGROUND = "#E8E9EA";

// The wheel accumulator of actions.cljs (one mutable ref): the scroll
// deltas and the compound zoom scale, each with its own rAF id.
interface WheelAccumulator {
  dx: number;
  dy: number;
  rafId: number;
  scale: number;
  zoomPt: ViewportPoint | null;
  zoomRafId: number;
}

export interface WorkspaceWasmCanvasProps {
  fileId: string;
  pageId: string;
  // The resolved file of lib/workspace (the store's file): the initial fit
  // reads its page objects, the background its pages-index.
  file: WorkspaceFile;
}

export function WorkspaceWasmCanvas({ fileId, pageId, file }: WorkspaceWasmCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  // Monotonic run id: each load takes one, and only the current run may
  // touch the canvas (StrictMode replays effects on the same refs).
  const runIdRef = useRef(0);
  const appRef = useRef<RendererApp | null>(null);
  // The latest {zoom, vbox, vport}; the wheel flush reads it, since events
  // arrive between renders.
  const stateRef = useRef<ViewportState | null>(null);
  // The deferred unmount teardown; a remount cancels it.
  const teardownTimerRef = useRef<number | null>(null);

  const [error, setError] = useState<string | null>(null);

  // Completion signals for tests and diagnosis: data-rendered flips on the
  // wasm tiles event (the progressive render finished a pass), data-shapes
  // when initialize-viewport reports the shapes loaded.
  useEffect(() => {
    const onTiles = (): void => {
      if (canvasRef.current !== null) canvasRef.current.dataset.rendered = "true";
    };
    document.addEventListener("penpot:wasm:tiles-complete", onTiles);
    return () => {
      document.removeEventListener("penpot:wasm:tiles-complete", onTiles);
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    const run = ++runIdRef.current;
    let disposed = false;
    const alive = (): boolean => !disposed && runIdRef.current === run;

    if (canvas === null) {
      return () => {
        disposed = true;
      };
    }

    // A remount (StrictMode replay) keeps the context: cancel the teardown
    // the previous run deferred.
    if (teardownTimerRef.current !== null) {
      window.clearTimeout(teardownTimerRef.current);
      teardownTimerRef.current = null;
    }

    setError(null);
    canvas.dataset.rendered = "false";
    delete canvas.dataset.shapes;
    stateRef.current = null;

    void (async () => {
      try {
        const app = await loadRenderer();
        if (!alive()) return;
        await ensureWasmModule(app);
        if (!alive()) return;

        // try-init of viewport-wasm.cljs: one attempt plus three retries
        // 200 ms apart; a persistent failure surfaces as the error state.
        let init = false;
        for (let attempt = 0; attempt < 4; attempt++) {
          if (!alive()) return;
          try {
            init = initWorkspaceCanvas(app, canvas);
          } catch (cause: unknown) {
            console.error("[render-wasm] canvas context init failed:", cause);
            init = false;
          }
          if (init) break;
          await sleep(200);
        }
        if (!init) {
          throw new Error("render-wasm: could not initialize the WebGL2 canvas context");
        }
        if (!alive()) return;
        appRef.current = app;

        const decoded = await loadDecodedWorkspaceFile(app, fileId);
        if (!alive()) return;
        const wasmObjects = workspacePageObjects(app, decoded.fileData, pageId);
        if (wasmObjects === null || wasmObjects === undefined) {
          throw new Error(`render-wasm: page ${pageId} has no objects`);
        }

        // The page objects of the JS-side file (the fit math) and the page
        // background; both come from the store's file.
        const objects = pageObjects(file, pageId);
        const page = (file.data["pages-index"] ?? {})[pageId];
        const background =
          typeof page?.background === "string" ? page.background : DEFAULT_BACKGROUND;

        // The initial fit over the JS-side objects; the canvas was already
        // laid out when the effect ran.
        const size = {
          width: Math.max(1, canvas.clientWidth),
          height: Math.max(1, canvas.clientHeight),
        };
        const fitted = initialViewport({ x: 0, y: 0, ...size }, objects);
        if (!alive()) return;
        stateRef.current = fitted;

        // init-canvas-context already ran resize-canvas! (positive client
        // size), so the drawing buffer matches the CSS size; this installs
        // the background, the view and the shape load. Without an
        // :on-render callback the compiled set-objects falls back to
        // request-render, which drives the progressive chain.
        initializeWorkspaceViewport(app, wasmObjects, fitted.zoom, fitted.vbox, {
          background,
          onShapesReady: () => {
            canvas.dataset.shapes = "true";
          },
        });

        setWorkspaceViewport(fitted);
      } catch (cause: unknown) {
        if (!alive()) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error("[render-wasm] workspace canvas failed:", cause);
        setError(message);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [fileId, pageId, file]);

  // The wheel handlers of actions.cljs, bound to the canvas. React's
  // onWheel is passive, so the listener is attached by hand to keep
  // prevent-default effective.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const acc: WheelAccumulator = {
      dx: 0,
      dy: 0,
      rafId: 0,
      scale: 1,
      zoomPt: null,
      zoomRafId: 0,
    };

    // schedule-zoom!: one flush per frame, the compound scale applied
    // around the latest cursor point.
    const flushZoom = (): void => {
      const scale = acc.scale;
      const pt = acc.zoomPt;
      acc.scale = 1;
      acc.zoomPt = null;
      acc.zoomRafId = 0;
      const app = appRef.current;
      const state = stateRef.current;
      if (app === null || state === null) return;
      const next = zoomBy(state, pt, scale);
      stateRef.current = next;
      setWorkspaceViewBox(app, next.zoom, next.vbox);
      setWorkspaceViewport(next);
    };

    // schedule-scroll!: one flush per frame, the summed world deltas.
    const flushScroll = (): void => {
      const dx = acc.dx;
      const dy = acc.dy;
      acc.dx = 0;
      acc.dy = 0;
      acc.rafId = 0;
      const app = appRef.current;
      const state = stateRef.current;
      if (app === null || state === null) return;
      const next = scrollBy(state, dx, dy);
      stateRef.current = next;
      setWorkspaceViewBox(app, next.zoom, next.vbox);
      setWorkspaceViewport(next);
    };

    const onWheel = (event: WheelEvent): void => {
      // (or ctrl? mod?): mod is meta on macOS, ctrl elsewhere.
      const macos = isMacos();
      const zooming = event.ctrlKey || (macos ? event.metaKey : event.ctrlKey);

      // The handler covers the canvas, so inside-viewport? is always true.
      event.preventDefault();
      event.stopPropagation();

      const state = stateRef.current;
      if (state === null) return;

      const norm = normalizeWheel(event);
      const scale = wheelZoomFactor(norm.pixelY + norm.pixelX);

      if (zooming) {
        acc.scale *= scale;
        const bbox = canvas.getBoundingClientRect();
        acc.zoomPt = pointToViewport(
          { x: event.clientX, y: event.clientY },
          { x: bbox.left, y: bbox.top },
          state.zoom,
          state.vbox,
        );
        if (acc.zoomRafId === 0) {
          acc.zoomRafId = window.requestAnimationFrame(flushZoom);
        }
      } else {
        const deltas = wheelScrollDeltas(
          norm.pixelX,
          norm.pixelY,
          state.zoom,
          event.shiftKey,
          macos,
        );
        acc.dx += deltas.x;
        acc.dy += deltas.y;
        if (acc.rafId === 0) {
          acc.rafId = window.requestAnimationFrame(flushScroll);
        }
      }
    };

    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      canvas.removeEventListener("wheel", onWheel);
      if (acc.rafId !== 0) window.cancelAnimationFrame(acc.rafId);
      if (acc.zoomRafId !== 0) window.cancelAnimationFrame(acc.zoomRafId);
    };
  }, []);

  // The [vport] effect of viewport-wasm.cljs: resize-canvas! plus the
  // centered update-viewport-size plus set-view-box.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;

    const observer = new ResizeObserver(() => {
      const app = appRef.current;
      const state = stateRef.current;
      if (app === null || state === null) return;
      const size = { width: canvas.clientWidth, height: canvas.clientHeight };
      if (size.width === state.vport.width && size.height === state.vport.height) return;
      const next = resizeViewport(state, size, "center");
      if (next === state) return;
      resizeWorkspaceCanvas(app, canvas);
      stateRef.current = next;
      setWorkspaceViewBox(app, next.zoom, next.vbox);
      setWorkspaceViewport(next);
    });
    observer.observe(canvas);
    return () => {
      observer.disconnect();
    };
  }, []);

  // Real unmount: hard teardown (clear-canvas defaults to
  // lose-browser-context? true), deferred one task so a StrictMode replay
  // cancels it from the remounting effect above.
  useEffect(() => {
    return () => {
      if (teardownTimerRef.current !== null) {
        window.clearTimeout(teardownTimerRef.current);
      }
      teardownTimerRef.current = window.setTimeout(() => {
        teardownTimerRef.current = null;
        void (async () => {
          try {
            const app = await loadRenderer();
            if (call(app, KEY.wasmLive) === true) {
              clearWorkspaceCanvas(app);
            }
            appRef.current = null;
            stateRef.current = null;
          } catch {
            // The module never loaded; nothing to hand back.
          }
        })();
      }, 0);
    };
  }, []);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pp-workspace-canvas"
        data-rendered="false"
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      {error !== null ? (
        <div className="pp-viewport-placeholder" title={error}>
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
