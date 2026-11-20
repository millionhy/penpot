"use client";

// The WASM frame viewport (F6.4, blit pipeline with F6.5): a live canvas
// that draws the viewer's current frame with render-wasm. The pipeline is
// the compiled viewer's (app.main.render-viewer-wasm): one shared
// OffscreenCanvas holds the live GL context, each pass re-renders the frame
// through renderSyncShape and blits the pixels onto this visible 2D canvas.
// Since G4.5b the pass runs on the TypeScript engine instead of the
// compiled $APP; the load sequence ports render-viewer-frame*:
//
//   loadEngineModule -> loadDecodedBundle -> calculateSize
//   -> set the canvas physical size (viewport-wasm's canvas-dimensions:
//      css = round(zoom * base), physical = round(css * dpr); assigned
//      only when it changed, since resizing clears the surface)
//   -> renderViewerFrame (reuse the snapshot, or rebuild the context with
//      initializeViewport {backgroundOpacity: 0, force-sync})
//
// The component instance survives frame and zoom changes: the snapshot is
// reused while page, size and dpr match, and the setObjects pipeline
// rebuilds the tile index (_set_view_end), so navigation needs no teardown.
// The wrapper cannot know the padded bounds (calculate-size over
// object-bounds) before the bundle is decoded, so the child reports them
// to the parent through onBounds; the parent sizes the wrapper from them.
//
// The hotspot layer (F6.5) mirrors viewport-wasm* + frame-hotspots*: the
// page objects are prepared into vbox space with the engine
// preparePageObjects (prepareAllObjects), one transparent SVG rect per
// interactive shape sits over the canvas, and the pointer handlers run the
// activate/deactivate math of lib/viewer-interactions.ts and report the
// resulting viewer actions up through onAction.
//
// One instance is the main viewport or one open overlay (viewer.cljs
// viewer-wrapper / viewer-overlay). An overlay passes its snap-to (the
// viewport computes the alignment delta and bakes it into the render origin
// and the prepared objects), its position as the frame offset, the
// top-level frame as the base frame of the interaction math, and the open
// overlay ids; the main viewport leaves them undefined, and its delta is
// (0, 0).
//
// The wasm module has one global GL context; a one-shot render (the
// thumbnails panel, render-to-canvas) initializes its own, tears it down
// when it finishes (clear-canvas) and resets the shared snapshot, so the
// viewport's next pass rebuilds its context. The completion events of the
// thumbnails are debounced into a reset that re-runs this effect once per
// burst.
//
// The on-render callback also drives the position-data pass
// (update-page-position-data, see lib/render-wasm/position-data): it runs
// on the viewport's own loaded model, the CLJS counterpart uses a dedicated
// offscreen context this bundle predates. The canvas carries the pass state
// on data-position-data for diagnosis.
//
// Unmount releases the shared context holder taken at mount. The main
// viewport and every open overlay run their passes on that one context, so
// only the last release hands it back: the clear runs on the render queue
// (a thumbnail pass may hold the context at that moment) and the snapshot
// resets, so the next mount rebuilds from scratch.

import { memo, useCallback, useEffect, useRef, useState } from "react";

import { clearCanvas, moduleReady, readDpr } from "@/lib/render-wasm/engine";
import { loadEngineModule } from "@/lib/render-wasm/engine-boot";
import {
  loadDecodedBundle,
  pageObjects as readPageObjects,
  shapeById,
} from "@/lib/render-wasm/bundle";
import { updatePagePositionData } from "@/lib/render-wasm/position-data";
import { enqueueRender } from "@/lib/render-wasm/render-queue";
import { calculateSize, type ViewerSize } from "@/lib/render-wasm/sizes";
import {
  acquireViewerContext,
  releaseViewerContext,
  renderViewerFrame,
  resetViewerSnapshot,
} from "@/lib/render-wasm/viewer-render";
import {
  collectHotspots,
  createShapeReader,
  prepareAllObjects,
  readSelrect,
  type HotspotEntry,
} from "@/lib/render-wasm/viewer-shapes";
import { createViewerHost } from "@/lib/render-wasm/viewer-host";
import {
  activateInteraction,
  calculateDelta,
  deactivateInteraction,
  interactionsByEvent,
  type InteractionShape,
  type Point,
  type ShapeReader,
  type SnapTo,
  type ViewerAction,
} from "@/lib/viewer-interactions";

// calculate-size without the zoomed width/height: enough to size the wrapper
// (base * zoom) and to keep the design-space origin for later overlays.
export interface ViewerWasmBounds {
  x: number;
  y: number;
  baseWidth: number;
  baseHeight: number;
}

export interface ViewerWasmViewportProps {
  fileId: string;
  shareId: string | null;
  pageId: string;
  frameId: string;
  frameName: string;
  zoom: number;
  onBounds?: (bounds: ViewerWasmBounds | null) => void;
  // ref:viewer-show-interactions: with it on, hotspots paint their
  // stroke / fill highlight (the F6.5 show-interactions slice wires it).
  showInteractions?: boolean;
  // The snap-to of an open overlay: present, the viewport computes the
  // alignment delta (calculateDelta over the raw frame selrect) and bakes
  // it into the render origin and the prepared objects, exactly like
  // viewer.cljs viewer-overlay.
  snapTo?: SnapTo;
  // The overlay position against the base frame (the frame-offset context
  // of the interaction math); the main viewport uses (0, 0).
  frameOffset?: Point;
  // The base frame of the interaction math (the base-frame context): an
  // overlay passes its top-level frame, the main viewport its own.
  baseFrameId?: string;
  // refs/viewer-overlays: the frame ids of the open overlays, for the
  // activate / deactivate math. Read at event time through a ref, so list
  // changes do not re-run the load effect.
  overlaysIds?: readonly string[];
  // The viewer actions the hotspot handlers produce; the page applies them
  // to its state (navigation, overlays).
  onAction?: (action: ViewerAction) => void;
}

// The hotspot layer of the current frame: the drawable entries plus the
// context the pointer handlers of lib/viewer-interactions.ts read. The
// open overlay ids come through a ref, since the handlers of the compiled
// viewer read refs/viewer-overlays at event time.
interface HotspotData {
  entries: HotspotEntry[];
  baseFrame: InteractionShape;
  reader: ShapeReader;
  frameOffset: Point;
  overlaysIdsRef: React.RefObject<readonly string[]>;
}

// One hotspot (shapes.cljs hotspot*): a transparent rect that is the only
// hit target, wired to the pointer handlers of the SVG tree. A handler
// stops propagation when a matching interaction exists, then runs the
// activate / deactivate math for each of them (the CLJS doseq).
interface HotspotProps {
  entry: HotspotEntry;
  data: HotspotData;
  showInteractions: boolean;
  emit: (action: ViewerAction | null) => void;
}

const Hotspot = memo(function Hotspot({ entry, data, showInteractions, emit }: HotspotProps) {
  const { shape } = entry;

  const run = (
    event: React.PointerEvent<SVGGElement>,
    eventTypes: readonly string[],
    fn: typeof activateInteraction,
  ): void => {
    const matching = interactionsByEvent(shape, eventTypes);
    if (matching.length === 0) return;
    event.stopPropagation();
    for (const interaction of matching) {
      emit(
        fn(
          interaction,
          shape,
          data.baseFrame,
          data.frameOffset,
          data.reader,
          data.overlaysIdsRef.current,
        ),
      );
    }
  };

  return (
    <g
      style={{ cursor: entry.pointer ? "pointer" : undefined }}
      onPointerDown={(event) => run(event, ["click", "mouse-press"], activateInteraction)}
      onPointerUp={(event) => run(event, ["mouse-press"], deactivateInteraction)}
      onPointerEnter={(event) => run(event, ["mouse-enter", "mouse-over"], activateInteraction)}
      onPointerLeave={(event) => {
        run(event, ["mouse-leave"], activateInteraction);
        run(event, ["mouse-over"], deactivateInteraction);
      }}
    >
      <rect
        x={entry.rect.x - 1}
        y={entry.rect.y - 1}
        width={entry.rect.width + 2}
        height={entry.rect.height + 2}
        fill="var(--color-accent-tertiary)"
        stroke="var(--color-accent-tertiary)"
        strokeWidth={showInteractions ? 1 : 0}
        fillOpacity={showInteractions ? 0.2 : 0}
        pointerEvents="all"
        transform={entry.transform}
      />
    </g>
  );
});

export function ViewerWasmViewport({
  fileId,
  shareId,
  pageId,
  frameId,
  frameName,
  zoom,
  onBounds,
  showInteractions = false,
  snapTo,
  frameOffset,
  baseFrameId,
  overlaysIds,
  onAction,
}: ViewerWasmViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // The open overlay ids as the handlers see them (the CLJS derefs
  // refs/viewer-overlays at event time, not at render time).
  const overlaysIdsRef = useRef<readonly string[]>(overlaysIds ?? []);
  useEffect(() => {
    overlaysIdsRef.current = overlaysIds ?? [];
  });
  // Monotonic run id: each effect run takes one, and only the current run
  // may touch the canvas (StrictMode replays effects on the same refs).
  const runIdRef = useRef(0);
  const onBoundsRef = useRef(onBounds);
  const onActionRef = useRef(onAction);

  // Bumped when an offscreen render (thumbnails) tears the shared context
  // down; the debounce coalesces the events of a burst (one per visible
  // thumbnail) into a single re-init.
  const [resetToken, setResetToken] = useState(0);

  const [size, setSize] = useState<ViewerSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hotspots, setHotspots] = useState<HotspotData | null>(null);

  useEffect(() => {
    onBoundsRef.current = onBounds;
    onActionRef.current = onAction;
  });

  // Stable emitter over the latest onAction, so the memoized hotspots do
  // not re-render when the parent callback identity changes.
  const emitAction = useCallback((action: ViewerAction | null) => {
    if (action !== null) onActionRef.current?.(action);
  }, []);

  // Completion signal for tests and diagnosis: the headless /view check
  // waits for data-rendered="true" on the canvas, which the pass sets in
  // its own on-render hook (the compiled rAF render that dispatches
  // "penpot:wasm:render" is not part of the blit pipeline). The tiles
  // event still comes from the wasm binary itself.
  useEffect(() => {
    const onTiles = (): void => {
      if (canvasRef.current !== null) canvasRef.current.dataset.tiles = "true";
    };
    document.addEventListener("penpot:wasm:tiles-complete", onTiles);
    return () => {
      document.removeEventListener("penpot:wasm:tiles-complete", onTiles);
    };
  }, []);

  // The completion signal of the thumbnails' offscreen renders
  // (render-to-canvas clears the shared context as its last step). One
  // re-init per burst keeps the viewport live while the panel is used.
  useEffect(() => {
    let timer: number | null = null;
    const onOffscreenRender = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        timer = null;
        setResetToken((value) => value + 1);
      }, 150);
    };
    document.addEventListener("penpot:wasm:offscreen-render", onOffscreenRender);
    return () => {
      document.removeEventListener("penpot:wasm:offscreen-render", onOffscreenRender);
      if (timer !== null) window.clearTimeout(timer);
    };
  }, []);

  // on-load (shapes.cljs): the after-delay interactions fire once the
  // hotspot layer is installed, one timer per interaction, and the timers
  // are cleared when the layer changes (frame / zoom / reset).
  useEffect(() => {
    if (hotspots === null) return;
    const timers: number[] = [];
    for (const entry of hotspots.entries) {
      for (const interaction of interactionsByEvent(entry.shape, ["after-delay"])) {
        const delay = typeof interaction.delay === "number" ? interaction.delay : 0;
        timers.push(
          window.setTimeout(() => {
            emitAction(
              activateInteraction(
                interaction,
                entry.shape,
                hotspots.baseFrame,
                hotspots.frameOffset,
                hotspots.reader,
                hotspots.overlaysIdsRef.current,
              ),
            );
          }, delay),
        );
      }
    }
    return () => {
      for (const timer of timers) window.clearTimeout(timer);
    };
  }, [hotspots, emitAction]);

  // Teardown, on real unmount only, queued with the shared renders: a
  // thumbnail pass may hold the context at that moment, and jumping the
  // queue could kill it mid-pass. The holder count keeps a closing overlay
  // from clearing the context of the main viewport behind it; the last
  // release clears it, and the live guard keeps that a no-op when a one-shot
  // render already handed it back. The snapshot resets either way, so the
  // next mount rebuilds from scratch.
  useEffect(() => {
    acquireViewerContext();
    return () => {
      if (!releaseViewerContext()) return;
      void enqueueRender(async () => {
        try {
          // The engine may never have loaded (an error before the first
          // pass); asking it to clear would start a 256 MB download.
          if (moduleReady()) {
            const module = await loadEngineModule();
            clearCanvas(module, { loseBrowserContext: false });
          }
          resetViewerSnapshot();
        } catch {
          // The module never loaded; nothing to hand back.
        }
      });
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

    setError(null);
    setHotspots(null);
    canvas.dataset.rendered = "false";
    delete canvas.dataset.tiles;
    delete canvas.dataset.positionData;

    void (async () => {
      try {
        const module = await loadEngineModule();
        if (!alive()) return;

        const bundle = await loadDecodedBundle({ fileId, shareId });
        if (!alive()) return;
        const objects = readPageObjects(bundle.fileData, pageId);
        if (objects === undefined) {
          throw new Error(`render-wasm: page ${pageId} has no objects`);
        }
        const frame = shapeById(objects, frameId);
        if (frame === undefined) {
          throw new Error(`render-wasm: frame ${frameId} not on page ${pageId}`);
        }

        const next = calculateSize(objects, frame, zoom);
        if (!alive()) return;
        setSize(next);
        onBoundsRef.current?.({ x: next.x, y: next.y, baseWidth: next.baseWidth, baseHeight: next.baseHeight });

        // The alignment delta of an overlay viewport (viewer-overlay: the
        // raw frame selrect and the snap-to; the zoom multiplies at the
        // end). The main viewport keeps (0, 0), like viewer-wrapper.
        const delta =
          snapTo !== undefined
            ? calculateDelta(next, readSelrect(frame), snapTo, zoom)
            : { x: 0, y: 0 };

        // The hotspot layer of the current viewport: preparePageObjects
        // shifts every shape by -(size + delta) into vbox space. The base
        // frame and the offset come from the viewer contexts: the main
        // viewport uses the frame itself and (0, 0) (viewer-wrapper); an
        // overlay uses its top-level frame and its position
        // (viewer-overlay). transformMatrixString handles rotated / flipped
        // shapes; the plain reader feeds the interaction math.
        const prepared = prepareAllObjects(objects, { x: next.x, y: next.y }, delta);
        const reader = createShapeReader(prepared);
        const baseFrame = reader(baseFrameId ?? frameId);
        if (baseFrame !== undefined) {
          const entries = collectHotspots(prepared, reader, frameId);
          if (!alive()) return;
          setHotspots({
            entries,
            baseFrame,
            reader,
            frameOffset: frameOffset ?? { x: 0, y: 0 },
            overlaysIdsRef,
          });
        }

        // The visible canvas is the blit target; its physical size is the
        // compiled canvas-dimensions (viewport-wasm): css = round(zoom *
        // base), physical = round(css * dpr). Assign only when it changed:
        // setting width/height clears the surface, and the pass right
        // below repaints it in the same task.
        const dpr = readDpr();
        const cssW = Math.max(1, Math.round(zoom * next.baseWidth));
        const cssH = Math.max(1, Math.round(zoom * next.baseHeight));
        const physW = Math.max(1, Math.round(cssW * dpr));
        const physH = Math.max(1, Math.round(cssH * dpr));
        if (canvas.width !== physW) canvas.width = physW;
        if (canvas.height !== physH) canvas.height = physH;
        if (!alive()) return;

        // The position-data pass runs once per run, after the blit (the
        // model is fully loaded by then): it computes the missing text
        // position-data on the viewport's own model (the port of
        // update-page-position-data). A partial pass (dead wasm context)
        // stays uncached and retries on the next run.
        let positionDone = false;
        // use-viewer-wasm-layers! bakes the delta into the WASM view
        // origin (render-size = size + delta) so the rendered canvas
        // aligns with the prepared hotspot SVG.
        // The image/font half of the upload lives in the host: media URLs
        // resolve against the same origin as the compiled cf/resolve-file-media,
        // and the custom fonts come from the bundle's variant rows.
        const host = createViewerHost({ module, bundle, shareId });
        await renderViewerFrame(module, canvas, {
          // The compiled call site passed the page id as the page key.
          pageKey: pageId,
          pageObjects: objects,
          size: { x: next.x + delta.x, y: next.y + delta.y },
          scale: zoom,
          frameId,
          host,
          onRender: () => {
            canvas.dataset.rendered = "true";
            if (!positionDone) {
              try {
                const result = updatePagePositionData(module, objects, pageId);
                canvas.dataset.positionData =
                  result.computed > 0
                    ? "computed"
                    : result.complete
                      ? "up-to-date"
                      : "pending";
                positionDone = result.complete;
              } catch (cause: unknown) {
                console.error("[render-wasm] position-data pass failed:", cause);
                canvas.dataset.positionData = "error";
                positionDone = true;
              }
            }
          },
        });
      } catch (cause: unknown) {
        if (!alive()) return;
        const message = cause instanceof Error ? cause.message : String(cause);
        console.error("[render-wasm] viewport render failed:", cause);
        onBoundsRef.current?.(null);
        setHotspots(null);
        setError(message);
      }
    })();

    return () => {
      disposed = true;
    };
  }, [
    fileId,
    shareId,
    pageId,
    frameId,
    zoom,
    resetToken,
    snapTo,
    frameOffset,
    baseFrameId,
  ]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="pp-viewport-canvas"
        data-rendered="false"
        style={{
          display: "block",
          width: "100%",
          height: "100%",
          pointerEvents: "none",
        }}
      />
      {hotspots !== null && hotspots.entries.length > 0 && size !== null ? (
        // wasm-hotspots-svg*: the vbox is the zoom-free padded size, so
        // the prepared (vbox-space) rects scale with the zoomed css size.
        <svg
          viewBox={"0 0 " + size.baseWidth + " " + size.baseHeight}
          width={size.width}
          height={size.height}
          version="1.1"
          fill="none"
          style={{ position: "absolute", top: 0, left: 0 }}
          data-hotspots={String(hotspots.entries.length)}
        >
          <g>
            {hotspots.entries.map((entry) => (
              <Hotspot
                key={entry.id}
                entry={entry}
                data={hotspots}
                showInteractions={showInteractions}
                emit={emitAction}
              />
            ))}
          </g>
        </svg>
      ) : null}
      {error !== null ? (
        <div className="pp-viewport-placeholder" title={error}>
          <span>{frameName}</span>
          {size !== null ? (
            <span>{Math.round(size.width) + " \u00d7 " + Math.round(size.height)}</span>
          ) : null}
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
