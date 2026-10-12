"use client";

// The WASM frame viewport (F6.4): a live canvas that draws the viewer's
// current frame with render-wasm — the stepping stone for the full viewer
// viewport (interactions and overlays arrive with F6.5). The load sequence
// ports initialize-viewport / the render-to-canvas* flow of
// app.main.render-viewer-wasm:
//
//   loadRenderer -> ensureWasmModule -> loadDecodedBundle -> calculateSize
//   -> init-canvas-context (first run, or after an external teardown) or
//      resize-canvas! (later runs)
//   -> initialize-viewport objects zoom vbox {:background-opacity 0
//      :force-sync true :on-render ...}
//
// The component instance survives frame and zoom changes: the context is
// initialized once and the set-objects pipeline rebuilds the tile index
// (_set_view_end), so navigation needs no teardown. The wrapper cannot know
// the padded bounds (calculate-size over gsb/get-object-bounds) before the
// bundle is decoded, so the child reports them to the parent through
// onBounds; the parent sizes the wrapper from them.
//
// The hotspot layer (F6.5) mirrors viewport-wasm* + frame-hotspots*: the
// frame subtree is prepared into vbox space with the compiled
// prepare-objects, one transparent SVG rect per interactive shape sits over
// the canvas, and the pointer handlers run the activate/deactivate math of
// lib/viewer-interactions.ts and report the resulting viewer actions up
// through onAction. Overlay actions are ignored here for now (f65e
// renders overlays).
//
// The wasm module has one global GL context; an offscreen render (the
// thumbnails panel, render-to-canvas) initializes its own and tears it down
// when it finishes (clear-canvas), so the viewport detects the dead context
// (wasm/live?) and re-initializes. The completion events of the thumbnails
// are debounced into a reset that re-runs this effect once per burst.
//
// The on-render callback also drives the position-data pass
// (update-page-position-data, see lib/render-wasm/position-data): it runs
// on the viewport's own loaded model, the CLJS counterpart uses a dedicated
// offscreen context this bundle predates. The canvas carries the pass state
// on data-position-data for diagnosis.
//
// Unmount runs a soft clear-canvas ({:lose-browser-context? false}): the same
// canvas node can be initialized again when React replays effects, and an
// immediate re-init after an explicitly lost context can fail (the same
// reason reload-renderer! waits a frame before re-init).

import { memo, useCallback, useEffect, useRef, useState } from "react";

import { ensureWasmModule, loadRenderer } from "@/lib/render-wasm/bridge";
import {
  KEY,
  arrayMap,
  call,
  get,
  keyword,
  sleep,
  uuid,
  type RendererApp,
} from "@/lib/render-wasm/interop";
import { updatePagePositionData } from "@/lib/render-wasm/position-data";
import { calculateSize, type ViewerSize } from "@/lib/render-wasm/sizes";
import {
  collectHotspots,
  createShapeReader,
  prepareObjects,
  type HotspotEntry,
} from "@/lib/render-wasm/viewer-shapes";
import { loadDecodedBundle } from "@/lib/render-wasm/values";
import {
  activateInteraction,
  deactivateInteraction,
  interactionsByEvent,
  type InteractionShape,
  type Point,
  type ShapeReader,
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
  // The viewer actions the hotspot handlers produce. The overlay kinds are
  // ignored by the current caller; f65e applies them.
  onAction?: (action: ViewerAction) => void;
}

// The hotspot layer of the current frame: the drawable entries plus the
// context the pointer handlers of lib/viewer-interactions.ts read. The
// overlays list stays empty until f65e stores overlay state.
interface HotspotData {
  entries: HotspotEntry[];
  baseFrame: InteractionShape;
  reader: ShapeReader;
  frameOffset: Point;
}

// No overlays open yet: the overlays-ids argument of activate/deactivate.
const EMPTY_OVERLAYS: readonly string[] = [];

// The soft teardown options shared by the unmount path and the unmounted
// mid-init path.
function softClearOptions(app: RendererApp): unknown {
  return arrayMap(app, [[keyword(app, "lose-browser-context?"), false]]);
}

// get-dpr answers the wasm-set dpr or window.devicePixelRatio; guard against
// anything else (the CLJS falls back to 1.0).
function readDpr(app: RendererApp): number {
  const dpr = call(app, KEY.getDpr);
  return typeof dpr === "number" && Number.isFinite(dpr) && dpr > 0 ? dpr : 1;
}

// The canvas is laid out at the container size; the layout engine rounds
// clientWidth/clientHeight, so compare with a pixel of slack. On timeout
// render anyway: resize-canvas! reads the achieved client size itself, so the
// framebuffer and the CSS layout stay in sync even if the poll missed.
async function waitForCanvasSize(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
): Promise<void> {
  const deadline = Date.now() + 3000;
  for (;;) {
    const fit =
      Math.abs(canvas.clientWidth - width) <= 1 &&
      Math.abs(canvas.clientHeight - height) <= 1;
    if (fit) return;
    if (Date.now() > deadline) return;
    await sleep(50);
  }
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
        fn(interaction, shape, data.baseFrame, data.frameOffset, data.reader, EMPTY_OVERLAYS),
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
  onAction,
}: ViewerWasmViewportProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Monotonic run id: each effect run takes one, and only the current run
  // may touch the canvas (StrictMode replays effects on the same refs).
  const runIdRef = useRef(0);
  // The context is initialized once per component instance; later runs only
  // resize it. A teardown resets this.
  const initializedRef = useRef(false);
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

  // Completion signals for tests and diagnosis: the headless /view check
  // waits for data-rendered="true" on the canvas.
  useEffect(() => {
    const onRender = (): void => {
      if (canvasRef.current !== null) canvasRef.current.dataset.rendered = "true";
    };
    const onTiles = (): void => {
      if (canvasRef.current !== null) canvasRef.current.dataset.tiles = "true";
    };
    document.addEventListener("penpot:wasm:render", onRender);
    document.addEventListener("penpot:wasm:tiles-complete", onTiles);
    return () => {
      document.removeEventListener("penpot:wasm:render", onRender);
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
                EMPTY_OVERLAYS,
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

  // Teardown, on real unmount only. The clear stays detached: there is
  // nothing left to wait for on the way out.
  useEffect(() => {
    return () => {
      if (!initializedRef.current) return;
      initializedRef.current = false;
      void loadRenderer()
        .then((app) => {
          call(app, KEY.clearCanvas, softClearOptions(app));
        })
        .catch(() => undefined);
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
        const app = await loadRenderer();
        if (!alive()) return;
        await ensureWasmModule(app);
        if (!alive()) return;

        const bundle = await loadDecodedBundle(app, { fileId, shareId });
        if (!alive()) return;
        const pagesIndex = get(app, bundle.fileData, keyword(app, "pages-index"));
        const page = get(app, pagesIndex, uuid(app, pageId));
        if (page === null || page === undefined) {
          throw new Error(`render-wasm: page ${pageId} not found in the bundle`);
        }
        const objects = get(app, page, keyword(app, "objects"));
        if (objects === null || objects === undefined) {
          throw new Error(`render-wasm: page ${pageId} has no objects`);
        }
        const frame = get(app, objects, uuid(app, frameId));
        if (frame === null || frame === undefined) {
          throw new Error(`render-wasm: frame ${frameId} not on page ${pageId}`);
        }

        const next = calculateSize(app, objects, frame, zoom);
        if (!alive()) return;
        setSize(next);
        onBoundsRef.current?.({
          x: next.x,
          y: next.y,
          baseWidth: next.baseWidth,
          baseHeight: next.baseHeight,
        });

        // The hotspot layer of the current viewport: the base frame is the
        // frame itself with a zero offset (viewer.cljs viewer-wrapper puts
        // it in the base-frame / frame-offset contexts) and the delta of
        // the current viewport is (0, 0), so prepare-objects shifts the
        // subtree by -(size.x, size.y) into vbox space. The compiled
        // transform-str handles rotated / flipped shapes; the plain reader
        // feeds the interaction math.
        const prepared = prepareObjects(
          app,
          frame,
          { x: next.x, y: next.y },
          { x: 0, y: 0 },
          objects,
        );
        const reader = createShapeReader(app, prepared);
        const baseFrame = reader(frameId);
        if (baseFrame !== undefined) {
          const entries = collectHotspots(app, prepared, reader, frameId);
          if (!alive()) return;
          setHotspots({ entries, baseFrame, reader, frameOffset: { x: 0, y: 0 } });
        }

        await waitForCanvasSize(canvas, next.width, next.height);
        if (!alive()) return;

        if (!initializedRef.current || call(app, KEY.wasmLive) !== true) {
          // First run, or the shared context was torn down by an offscreen
          // render (wasm/live? answers false then).
          if (call(app, KEY.initCanvasContext, canvas) !== true) {
            throw new Error(
              "render-wasm: init_canvas_context refused " +
                "(module not ready, or no webgl2 context)",
            );
          }
          initializedRef.current = true;
          if (!alive()) {
            // Unmounted while the context was coming up: hand the context
            // back before leaving.
            initializedRef.current = false;
            call(app, KEY.clearCanvas, softClearOptions(app));
            return;
          }
        } else {
          call(app, KEY.resizeCanvas, canvas, readDpr(app));
        }

        // initialize-viewport only reads :x and :y of the vbox; the padding
        // is already baked into the padded bounds origin.
        const vbox = arrayMap(app, [
          [keyword(app, "x"), next.x],
          [keyword(app, "y"), next.y],
        ]);
        // The position-data pass runs once per run: it computes the missing
        // text position-data on the model set-objects just loaded (the
        // port of update-page-position-data). A partial pass (dead wasm
        // context) stays uncached and retries on the next on-render or run.
        let positionDone = false;
        const options = arrayMap(app, [
          [keyword(app, "background-opacity"), 0],
          [keyword(app, "force-sync"), true],
          [
            keyword(app, "on-render"),
            () => {
              // The workspace chrome (ticks and the rounded frame) is
              // composited by default; the viewer shows the frame alone.
              // Then paint: set-objects calls this instead of its own
              // request-render.
              call(app, KEY.setRulersFrameVisible, false);
              call(app, KEY.setRulersVisible, false);
              if (!positionDone) {
                try {
                  const result = updatePagePositionData(app, objects, pageId);
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
              call(app, KEY.requestRender, "viewer-viewport");
            },
          ],
        ]);
        call(app, KEY.initializeViewport, objects, zoom, vbox, options);
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
  }, [fileId, shareId, pageId, frameId, zoom, resetToken]);

  return (
    <>
      <canvas
        ref={canvasRef}
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
