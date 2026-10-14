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
// The pointer/keyboard interaction ports the handlers of the same
// actions.cljs / hooks.cljs pair: pointerdown captures the pointer and
// then pans (middle or space+left: rAF-accumulated world scroll deltas),
// starts the marquee (a press on the empty canvas or with mod held;
// handle-area-selection semantics — shift appends, shift+mod removes, a
// plain press clears first) or records a pending click over the hover
// shape; pointermove pans, grows the marquee (10 / zoom minimum on width
// or height) or runs the rAF-merged hover query (setup-hover-shapes) plus
// the 50ms-debounced top-nested-frame; pointerup finalizes the gesture
// (a pending click released inside the move threshold selects). Escape
// clears the selection and cancels the in-flight gesture; window
// keydown/keyup/blur feed space/shift/mod and the cursor
// (default/pointer/grab/grabbing).
//
// The selection/hover/marquee visuals are drawn by a sibling overlay
// (components/workspace-viewport-overlay, T5): an SVG in world coordinates
// fed from the store slice this file writes; the hover outline follows the
// single hoverShapeId computed here (the CLJS :id @hover), not the whole
// stack.
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
// - The click selection runs on pointerup behind a 5px move threshold
//   instead of the DOM click event of on-click; a press that crosses the
//   threshold cancels it (the CLJS turns it into the move-selected drag,
//   which arrives with F9.3).
// - mod+space pans instead of the CLJS start-zooming drag.
// - clientToWorld is the alias of the F9.1 pointToViewport (same formula;
//   see lib/workspace-viewport).
// - The hover queries run synchronously against the JS-side index on an
//   rAF merge instead of the worker ask-buffered stream; the debounced
//   top-nested-frame behavior is preserved (50ms).
// - No double-click (enter group/frame), no focus mode, no drawing tools
//   and no text/comment interactions: F9.2 selects and navigates only
//   (Escape clears the selection).

import { useEffect, useRef, useState } from "react";

import { WorkspaceViewportOverlay } from "@/components/workspace-viewport-overlay";
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
import { pageObjects, type WorkspaceFile, type WorkspaceObjects } from "@/lib/workspace";
import { createWorkspaceIndex, type WorkspaceIndex } from "@/lib/workspace-index";
import {
  areaInitialSelection,
  createHoverIdsCache,
  hoverShapeId,
  hoverStackAt,
  makeAppIntersectPosition,
  makeAppSortIds,
  makeAppTopNestedFrame,
  selectionAfterArea,
  type HoverIdsCache,
} from "@/lib/workspace-selection";
import {
  clearSelection,
  getWorkspaceState,
  setAreaSelect,
  setHover,
  setHoverShapeId,
  setHoverTopFrameId,
  setSelection,
  setWorkspaceViewport,
  toggleSelection,
} from "@/lib/workspace-store";
import {
  clientToWorld,
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

// The pending-click threshold (client pixels): a release inside it selects
// the shape, a press that crosses it is treated as a drag.
const CLICK_MOVE_THRESHOLD = 5;

// The hover-top-frame debounce of setup-hover-shapes (rx/debounce 50).
const TOP_FRAME_DEBOUNCE_MS = 50;

// The marquee minimum of handle-area-selection: the updates start once the
// width or the height passes 10 / zoom (world units).
const AREA_MIN_SIZE = 10;

// The pointer gesture the handlers mutate (the CLJS keeps this spread
// across the stream pipeline).
interface PointerInteraction {
  mode: "idle" | "pan" | "area" | "click";
  pointerId: number | null;
  // The client position of the press (the click-threshold anchor).
  downClient: ViewportPoint | null;
  // The world position of the press (the marquee anchor).
  downWorld: ViewportPoint | null;
  // The last client position while panning.
  panLast: ViewportPoint | null;
  // The pending-click candidate and whether a drag cancelled it.
  clickId: string | null;
  moved: boolean;
  // Escape cancels the in-flight gesture (no release side effects).
  cancelled: boolean;
  // The marquee state: the initial selection, the mode flags and whether
  // the minimum size was ever passed.
  areaInitial: string[];
  areaRemove: boolean;
  areaIgnoreGroups: boolean;
  areaActive: boolean;
}

// The $APP-backed pieces of the selection library (they need the wasm
// runtime): created once per load from appRef/wasmObjectsRef.
interface InteractionAdapters {
  sortIds: (ids: readonly string[], mod: boolean) => string[];
  intersectPosition: (id: string, point: ViewportPoint) => boolean;
  topFrame: (point: ViewportPoint) => string | null;
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

  // The interaction layer reads the resolved model through refs: the
  // JS-side objects and their hit-testing index (the query math), the
  // wasm-side objects behind the $APP adapters, and the (mod?, ids) sort
  // cache. All are (re)built by the load effect.
  const objectsRef = useRef<WorkspaceObjects | null>(null);
  const wasmObjectsRef = useRef<unknown>(null);
  const indexRef = useRef<WorkspaceIndex | null>(null);
  const adaptersRef = useRef<InteractionAdapters | null>(null);
  const hoverCacheRef = useRef<HoverIdsCache | null>(null);

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
        wasmObjectsRef.current = wasmObjects;

        // The page objects of the JS-side file (the fit math and the
        // interaction hit-testing) and the page background; both come from
        // the store's file.
        const objects = pageObjects(file, pageId);
        objectsRef.current = objects;
        indexRef.current = createWorkspaceIndex(objects);
        // A (re)load invalidates the previous model's derived state: the
        // $APP adapters, the sort cache and the transient interaction
        // slices (the selection ids belong to the old page).
        adaptersRef.current = null;
        hoverCacheRef.current?.clear();
        clearSelection();
        setHover(null);
        setHoverShapeId(null);
        setHoverTopFrameId(null);
        setAreaSelect(null);
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

  // The pointer/keyboard interaction (see the header): the handlers port
  // the semantics of actions.cljs / hooks.cljs. All the mutable state
  // lives in the effect closure, so a remount (StrictMode replay) starts
  // from a clean gesture. The model comes through the refs the load
  // effect fills, so this effect mounts once per canvas.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    if (hoverCacheRef.current === null) hoverCacheRef.current = createHoverIdsCache();

    const interaction: PointerInteraction = {
      mode: "idle",
      pointerId: null,
      downClient: null,
      downWorld: null,
      panLast: null,
      clickId: null,
      moved: false,
      cancelled: false,
      areaInitial: [],
      areaRemove: false,
      areaIgnoreGroups: false,
      areaActive: false,
    };

    // The tracked modifiers: space switches the pan mode, shift the toggle
    // of the click/marquee, mod the deep selection (meta on macOS, ctrl
    // elsewhere: kbd/mod?).
    const keys = { space: false, shift: false, mod: false };

    let lastHoverWorld: ViewportPoint | null = null;
    let hoverActive = false;
    let hoverRafId = 0;
    let pendingHoverWorld: ViewportPoint | null = null;
    let topFrameTimer = 0;
    const panAcc = { dx: 0, dy: 0, rafId: 0 };

    const canvasOrigin = (): ViewportPoint => {
      const bbox = canvas.getBoundingClientRect();
      return { x: bbox.left, y: bbox.top };
    };

    const toWorld = (client: ViewportPoint, state: ViewportState): ViewportPoint =>
      clientToWorld(client, canvasOrigin(), state.zoom, state.vbox);

    const updateCursor = (): void => {
      if (interaction.mode === "pan") canvas.style.cursor = "grabbing";
      else if (keys.space) canvas.style.cursor = "grab";
      else if (hoverActive) canvas.style.cursor = "pointer";
      else canvas.style.cursor = "default";
    };

    // The $APP adapters need the loaded runtime: created on first use and
    // invalidated by the load effect on every (re)load.
    const ensureAdapters = (): InteractionAdapters | null => {
      if (adaptersRef.current === null) {
        const app = appRef.current;
        const wasmObjects = wasmObjectsRef.current;
        if (app === null || wasmObjects === null) return null;
        adaptersRef.current = {
          sortIds: makeAppSortIds(app, wasmObjects),
          intersectPosition: makeAppIntersectPosition(app),
          topFrame: makeAppTopNestedFrame(app, wasmObjects, false),
        };
      }
      return adaptersRef.current;
    };

    const queryStack = (world: ViewportPoint): string[] => {
      const state = stateRef.current;
      const index = indexRef.current;
      const objects = objectsRef.current;
      if (state === null || index === null || objects === null) return [];
      return hoverStackAt(index, objects, world, state.zoom, {
        mod: keys.mod,
        sortIds: ensureAdapters()?.sortIds,
        cache: hoverCacheRef.current ?? undefined,
      });
    };

    // The 50ms debounce of setup-hover-shapes: the top-nested-frame runs
    // once the hover updates settle.
    const scheduleTopFrame = (world: ViewportPoint): void => {
      if (topFrameTimer !== 0) window.clearTimeout(topFrameTimer);
      topFrameTimer = window.setTimeout(() => {
        topFrameTimer = 0;
        const adapters = ensureAdapters();
        if (adapters === null) return;
        setHoverTopFrameId(adapters.topFrame(world));
      }, TOP_FRAME_DEBOUNCE_MS);
    };

    // The hover outline of the overlay follows the single hover shape (the
    // CLJS :id @hover), not the whole stack: the same remove-hover? / mod
    // filters the click path uses. Returns that shape id.
    const updateHoverAt = (world: ViewportPoint): string | null => {
      const stack = queryStack(world);
      lastHoverWorld = world;
      hoverActive = stack.length > 0;
      setHover(stack);
      const objects = objectsRef.current;
      const hoverId =
        objects === null
          ? null
          : hoverShapeId(stack, objects, world, {
              mod: keys.mod,
              selected: getWorkspaceState().selection,
              intersectPosition: ensureAdapters()?.intersectPosition,
            });
      setHoverShapeId(hoverId);
      updateCursor();
      scheduleTopFrame(world);
      return hoverId;
    };

    // One hover query per frame, whatever the move rate.
    const scheduleHover = (world: ViewportPoint): void => {
      pendingHoverWorld = world;
      if (hoverRafId !== 0) return;
      hoverRafId = window.requestAnimationFrame(() => {
        hoverRafId = 0;
        const pending = pendingHoverWorld;
        pendingHoverWorld = null;
        if (pending !== null) updateHoverAt(pending);
      });
    };

    // schedule-scroll! semantics for the pan drag: the world deltas sum in
    // the accumulator and one flush per frame applies them.
    const flushPan = (): void => {
      panAcc.rafId = 0;
      const dx = panAcc.dx;
      const dy = panAcc.dy;
      panAcc.dx = 0;
      panAcc.dy = 0;
      const app = appRef.current;
      const state = stateRef.current;
      if (app === null || state === null || (dx === 0 && dy === 0)) return;
      const next = scrollBy(state, dx, dy);
      stateRef.current = next;
      setWorkspaceViewBox(app, next.zoom, next.vbox);
      setWorkspaceViewport(next);
    };

    const startArea = (
      pointerId: number,
      client: ViewportPoint,
      world: ViewportPoint,
    ): void => {
      const append = keys.shift;
      const remove = keys.shift && keys.mod;
      interaction.mode = "area";
      interaction.pointerId = pointerId;
      interaction.downClient = client;
      interaction.downWorld = world;
      interaction.cancelled = false;
      interaction.areaActive = false;
      interaction.areaInitial = areaInitialSelection(
        getWorkspaceState().selection,
        append,
        remove,
      );
      interaction.areaRemove = remove;
      interaction.areaIgnoreGroups = keys.mod;
      // handle-area-selection emits deselect-all unless the drag appends.
      if (!append && !remove) clearSelection();
    };

    // select-shapes-by-current-selrect over the marquee: the minimum size
    // of handle-area-selection (width or height past 10 / zoom) gates the
    // updates, and the selection re-runs on every passing position.
    const applyArea = (client: ViewportPoint): void => {
      const state = stateRef.current;
      const start = interaction.downWorld;
      if (state === null || start === null || interaction.cancelled) return;
      const world = toWorld(client, state);
      const rect = {
        x: Math.min(start.x, world.x),
        y: Math.min(start.y, world.y),
        width: Math.abs(world.x - start.x),
        height: Math.abs(world.y - start.y),
      };
      const min = AREA_MIN_SIZE / state.zoom;
      if (rect.width <= min && rect.height <= min) return;
      interaction.areaActive = true;
      setAreaSelect(rect);
      const objects = objectsRef.current;
      const index = indexRef.current;
      if (objects === null || index === null) return;
      setSelection(
        selectionAfterArea(objects, index, rect, interaction.areaInitial, {
          remove: interaction.areaRemove,
          ignoreGroups: interaction.areaIgnoreGroups,
        }),
      );
    };

    const onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0 && event.button !== 1) return;
      const state = stateRef.current;
      const index = indexRef.current;
      const objects = objectsRef.current;
      if (state === null || index === null || objects === null) return;
      if (interaction.mode !== "idle") return;

      // Capture the pointer so the gesture survives leaving the canvas
      // (setPointerCapture in on-pointer-down).
      canvas.setPointerCapture(event.pointerId);
      const client = { x: event.clientX, y: event.clientY };

      // (or middle-click? (and left-click? @space?)): pan. The CLJS
      // branches to start-zooming while mod is held; the mod+space zoom
      // drag is not ported, so mod pans here.
      if (event.button === 1 || (event.button === 0 && keys.space)) {
        event.preventDefault();
        interaction.mode = "pan";
        interaction.pointerId = event.pointerId;
        interaction.panLast = client;
        updateCursor();
        return;
      }

      // A left press refreshes the hover stack at the press point (the
      // CLJS reads the stack the last move left behind; recomputing keeps
      // the click correct without a preceding move).
      const world = toWorld(client, state);
      const hoverId = updateHoverAt(world);

      // (or (not id) mod?): the empty canvas and mod both start the
      // marquee; a hit shape records the pending click (the CLJS starts
      // move-selected here; the drag arrives with F9.3).
      if (hoverId === null || keys.mod) {
        startArea(event.pointerId, client, world);
        return;
      }
      interaction.mode = "click";
      interaction.pointerId = event.pointerId;
      interaction.downClient = client;
      interaction.clickId = hoverId;
      interaction.moved = false;
      interaction.cancelled = false;
    };

    const onPointerMove = (event: PointerEvent): void => {
      const state = stateRef.current;
      if (state === null) return;

      if (interaction.mode === "idle") {
        scheduleHover(toWorld({ x: event.clientX, y: event.clientY }, state));
        return;
      }
      if (interaction.pointerId !== event.pointerId) return;

      const client = { x: event.clientX, y: event.clientY };

      if (interaction.mode === "pan") {
        const last = interaction.panLast;
        interaction.panLast = client;
        if (last === null) return;
        // Drag the world with the hand: the box moves against the pointer.
        panAcc.dx += -(client.x - last.x) / state.zoom;
        panAcc.dy += -(client.y - last.y) / state.zoom;
        if (panAcc.rafId === 0) panAcc.rafId = window.requestAnimationFrame(flushPan);
        return;
      }

      if (interaction.mode === "area") {
        applyArea(client);
        return;
      }

      // The pending click: a drag past the threshold cancels the release
      // selection.
      const down = interaction.downClient;
      if (down === null || interaction.moved) return;
      if (
        Math.abs(client.x - down.x) > CLICK_MOVE_THRESHOLD ||
        Math.abs(client.y - down.y) > CLICK_MOVE_THRESHOLD
      ) {
        interaction.moved = true;
      }
    };

    const endGesture = (): void => {
      interaction.mode = "idle";
      interaction.pointerId = null;
      interaction.downClient = null;
      interaction.downWorld = null;
      interaction.panLast = null;
      interaction.clickId = null;
      interaction.moved = false;
      interaction.cancelled = false;
      interaction.areaActive = false;
      updateCursor();
    };

    const onPointerUp = (event: PointerEvent): void => {
      if (interaction.pointerId !== event.pointerId) return;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
      // The Firefox paste guard of on-pointer-up.
      if (event.button === 1) event.preventDefault();

      const mode = interaction.mode;
      const cancelled = interaction.cancelled;

      if (mode === "area") {
        // The rx/last tick of handle-area-selection: the release position
        // still lands a selection on a fast drag.
        if (!cancelled && interaction.areaActive) {
          applyArea({ x: event.clientX, y: event.clientY });
        }
        setAreaSelect(null);
        endGesture();
        return;
      }

      if (mode === "click") {
        const id = interaction.clickId;
        const moved = interaction.moved;
        endGesture();
        // on-click: a release inside the threshold selects the shape
        // (shift toggles); the browser click event is not used.
        if (id !== null && !moved && !cancelled) {
          toggleSelection(id, keys.shift);
        }
        return;
      }

      endGesture();
    };

    const onPointerCancel = (event: PointerEvent): void => {
      if (interaction.pointerId !== event.pointerId) return;
      if (interaction.mode === "area") setAreaSelect(null);
      endGesture();
    };

    const onPointerLeave = (): void => {
      if (interaction.mode !== "idle") return;
      // The cursor left the viewport: drop the hover visuals.
      hoverActive = false;
      lastHoverWorld = null;
      pendingHoverWorld = null;
      if (topFrameTimer !== 0) {
        window.clearTimeout(topFrameTimer);
        topFrameTimer = 0;
      }
      setHover(null);
      setHoverShapeId(null);
      setHoverTopFrameId(null);
      updateCursor();
    };

    // Escape (the CLJS clear-selection): the marquee aborts without the
    // release side effects and a pending click is swallowed.
    const cancelGesture = (): void => {
      if (interaction.mode === "area") {
        setAreaSelect(null);
        interaction.cancelled = true;
        return;
      }
      if (interaction.mode === "click") interaction.cancelled = true;
    };

    // The keys are ignored while a form control has the focus (the CLJS
    // editing-event? guard).
    const isFormTarget = (target: EventTarget | null): boolean => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        tag === "BUTTON" ||
        target.isContentEditable
      );
    };

    const trackModifiers = (event: KeyboardEvent): void => {
      const wasMod = keys.mod;
      keys.shift = event.shiftKey;
      keys.mod = isMacos() ? event.metaKey : event.ctrlKey;
      // mod changes the hover stack (bottom-frames sort + the group
      // filter): refresh the outlines in place, like the CLJS mod-str
      // stream, so the hover follows without moving the cursor.
      if (keys.mod !== wasMod && lastHoverWorld !== null) scheduleHover(lastHoverWorld);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isFormTarget(event.target)) return;
      if (event.key === " ") {
        if (!keys.space) {
          keys.space = true;
          updateCursor();
        }
        // No page scroll while the pan modifier is held.
        event.preventDefault();
        return;
      }
      if (event.key === "Escape") {
        cancelGesture();
        clearSelection();
        return;
      }
      trackModifiers(event);
    };

    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.key === " ") {
        keys.space = false;
        updateCursor();
      }
      trackModifiers(event);
    };

    // The window-blur cleanup of the modifier tracking.
    const onWindowBlur = (): void => {
      keys.space = false;
      keys.shift = false;
      keys.mod = false;
      updateCursor();
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerCancel);
    canvas.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onWindowBlur);
    canvas.style.cursor = "default";

    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerCancel);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onWindowBlur);
      if (interaction.pointerId !== null && canvas.hasPointerCapture(interaction.pointerId)) {
        canvas.releasePointerCapture(interaction.pointerId);
      }
      if (hoverRafId !== 0) window.cancelAnimationFrame(hoverRafId);
      if (panAcc.rafId !== 0) window.cancelAnimationFrame(panAcc.rafId);
      if (topFrameTimer !== 0) window.clearTimeout(topFrameTimer);
      canvas.style.cursor = "default";
      // The hover/marquee visuals are canvas-local: drop them on unmount
      // (a StrictMode replay immediately rebuilds the same closure).
      setHover(null);
      setHoverShapeId(null);
      setHoverTopFrameId(null);
      setAreaSelect(null);
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
        style={{ display: "block", width: "100%", height: "100%", touchAction: "none" }}
      />
      <WorkspaceViewportOverlay file={file} pageId={pageId} />
      {error !== null ? (
        <div className="pp-viewport-placeholder" title={error}>
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}
