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
// shape; a left press over a shape that crosses the 10px move threshold
// becomes the move drag (F9.3): the selection updates per the press branch
// (AD3), the wasm modifier preview follows the pointer on one rAF flush
// and the hover visuals step aside. pointermove pans, grows the marquee
// (10 / zoom minimum on width or height), flushes the drag preview or runs
// the rAF-merged hover query (setup-hover-shapes) plus the 50ms-debounced
// top-nested-frame; pointerup finalizes the gesture (a pending click
// released inside the move threshold selects; a drag releases into one
// update-file commit, F9.3 T3/T5). Escape clears the
// selection and cancels the in-flight gesture (a running drag resets its
// preview first); window keydown/keyup/blur feed space/shift/mod and the
// cursor (default/pointer/grab/grabbing).
//
// The draw gesture (F9.5): a left press with a box tool (frame/rect/
// ellipse) resolves its parent through topNestedFrameAt + firstValidParent
// at press time, previews the box in the store once the pointer passes 10
// screen pixels (the overlay draws the dashed rect), and commits one
// add-obj on release; a release under the threshold creates a 100 x 100
// box centered on the press. Shift squares and Alt centers the box. Escape
// or pointercancel aborts and returns the tool to move; a completed draw
// returns it the same way.
//
// The resize/rotate gesture (F9.6): the overlay sees the pointerdown on a
// handle or rotation zone and hands it over through gestureRef
// (beginResize / beginRotate); the canvas captures the pointer and runs
// the gesture to the release. Each frame builds one world matrix from the
// selection geometry captured at the press (lib/workspace-transform),
// splats it over the transform set as the wasm modifier preview and writes
// the same matrix to the store transformPreview the overlay draws with.
// Shift locks the aspect ratio (or follows the shape proportion-lock), Alt
// resizes around the frame center, mod snaps rotation to 45 degrees and
// Shift to 15. The release builds one mod-obj per changed shape and reuses
// sendUpdateFile; a zero matrix or an unchanged model sends nothing. A
// successful commit swaps the JS model, rebuilds the index and hands the
// new geometry to wasm in the same task; Escape, pointercancel and a
// failed request reset the preview and leave the file alone.
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
// - The click selection runs on pointerup behind a 10px move threshold
//   instead of the DOM click event of on-click (F9.3 widened the F9.2
//   5px); a press that crosses the threshold starts the move drag. The
//   CLJS DOM layering is approximated with the selection-membership
//   branches of AD3: a press on a selected shape moves the whole
//   selection, a press outside it replaces the selection and shift
//   toggles. The drag preview drives the internal modifier ABI; the
//   release persists one update-file (AD5/AD6) gated by
//   file.permissions["can-edit"]. A successful commit swaps the JS model
//   (objectsRef/indexRef/store.objects, T5) and hands the preview over to
//   the committed geometry through the same-task wasm push (AD7); a
//   failed commit resets the preview and leaves the model untouched. A
//   commit in flight rejects new presses, and a failed commit only
//   reports through the console and the store error channel (no visible
//   banner yet, T6).
// - The drag needs the internal modifier ABI (lib/render-wasm/modifiers):
//   when a wasm rebuild drops an entry point the threshold crossing keeps
//   the F9.2 behavior (the release selects nothing) and warns once per
//   load.
// - Escape during a drag resets the preview and then clears the selection
//   (the CLJS :escape shortcut emits interrupt + deselect-all); a
//   pointercancel instead restores the selection the threshold crossing
//   replaced.
// - mod+space pans instead of the CLJS start-zooming drag.
// - The resize/rotate gesture applies one world matrix to the selection. A
//   resize hands it to the renderer and previews and commits the matrices it
//   answers with (F9.11): the constraint spread and the layout reflow stay in
//   wasm, one algorithm for the drag, the panel fields and the reflow. A
//   rotation keeps the local rigid spread of lib/workspace-constraints (the
//   CLJS rotation algorithm skips the child constraints on purpose), and so
//   does a wasm without the propagate ABI. Text shapes stay non-interactive
//   and the post-commit wasm handover carries the whole record, like the
//   move path.
// - A layout attribute edit asks the renderer for a reflow right after it
//   commits, and the returned child positions ride a second update-file
//   request folded into the same undo entry (F9.11). Drawing, deleting and
//   reordering shapes inside a layout do not reflow yet: the drop already
//   places the shape where the layout wants it.
// - clientToWorld is the alias of the F9.1 pointToViewport (same formula;
//   see lib/workspace-viewport).
// - The hover queries run synchronously against the JS-side index on an
//   rAF merge instead of the worker ask-buffered stream; the debounced
//   top-nested-frame behavior is preserved (50ms).
// - No double-click (enter group/frame), no focus mode and no text/comment
//   interactions: F9.2 selects and navigates; F9.5 adds the three box draw
//   tools (frame/rect/ellipse) and nothing else.

import {
  memo,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type Ref,
} from "react";

import { WorkspaceViewportOverlay } from "@/components/workspace-viewport-overlay";
import { ensureWasmModule, loadRenderer } from "@/lib/render-wasm/bridge";
import { KEY, call, sleep, type RendererApp } from "@/lib/render-wasm/interop";
import {
  DRAG_PREVIEW_INTERNALS,
  GEOMETRY_PUSH_INTERNALS,
  cleanModifiers,
  commitShapeGeometry,
  configureModifiers,
  endModifiers,
  missingInternals,
  resetModifierPreview,
  startModifiers,
  type GeometryShape,
  type Matrix6,
  type ShapeGeometry,
} from "@/lib/render-wasm/modifiers";
import { PROPAGATE_INTERNALS, propagateModifiers } from "@/lib/render-wasm/propagate";
import {
  clearWorkspaceCanvas,
  initializeWorkspaceViewport,
  initWorkspaceCanvas,
  resizeWorkspaceCanvas,
  setWorkspaceRulerColors,
  setWorkspaceRulersOffsets,
  setWorkspaceRulersSelection,
  setWorkspaceRulersVisible,
  setWorkspaceViewBox,
} from "@/lib/render-wasm/workspace-render";
import {
  loadDecodedWorkspaceFile,
  invalidateDecodedWorkspaceFile,
  workspacePageObjects,
} from "@/lib/render-wasm/workspace-data";
import {
  applyShapeStyle,
  attrsWriteStyle,
  uploadChangedShapes,
  uploadNewShape,
  uploadShapeGeometry,
} from "@/lib/render-wasm/shape-upload";
import { isMacos } from "@/lib/shortcuts";
import { notifyPluginContentSaved } from "@/lib/plugin-context";
import {
  registerWorkspaceBridge,
  type PluginDrawBox,
  type PluginViewportSnapshot,
} from "@/lib/workspace-bridge";
import { ZERO_UUID } from "@/lib/file-data";
import { cmdEncoded } from "@/lib/rpc";
import { encodeUpdateFile, type UpdateFileChange } from "@/lib/transit";
import {
  canEditFile,
  immediateChildren,
  isDrawTool,
  pageObjects,
  type WorkspaceDrawTool,
  type WorkspaceFile,
  type WorkspaceObjects,
  type WorkspaceShape,
  type WorkspaceTool,
} from "@/lib/workspace";
import { createWorkspaceIndex, type WorkspaceIndex } from "@/lib/workspace-index";
import {
  applyAddShape,
  clickDrawRect,
  createDrawShape,
  drawRectFromPoints,
  firstValidParent,
  type DrawRect,
} from "@/lib/workspace-draw";
import { dropIndexForFrame } from "@/lib/workspace-drop";
import {
  applyMove,
  buildMoveChanges,
  movedGeometry,
  resolveMoveSet,
  topNestedFrameAt,
} from "@/lib/workspace-move";
import { buildRelocateChanges } from "@/lib/workspace-relocate";
import {
  buildGeometryChange,
  geometryTransform,
  type GeometryTarget,
} from "@/lib/workspace-geometry";
import { acceptedSubtreeEntries, gestureEntries } from "@/lib/workspace-constraints";
import { buildStyleChange } from "@/lib/workspace-style";
import {
  applyReflow,
  reflowChanges,
  reflowEntries,
  reflowTargetIds,
  type ReflowUpdate,
} from "@/lib/workspace-reflow";
import type { ShapeUpdate } from "@/lib/workspace-multi";
import { buildVerticalOrderChanges, type VerticalOrderLocation } from "@/lib/workspace-order";
import {
  addPageChange,
  deletePageChange,
  emptyPage,
  normalizePageName,
  pageInfos,
  renamePageChange,
  uniquePageName,
  validPageName,
  withPageAdded,
  withPageDeleted,
  withPageRenamed,
} from "@/lib/workspace-pages";
import {
  applyUpdateChanges,
  canRedo,
  canUndo,
  createUndoState,
  invertChanges,
  mergeUndo,
  pushUndo,
  redoStep,
  undoStep,
  type UndoState,
} from "@/lib/workspace-undo";
import {
  applyTransformEntries,
  buildTransformEntryChanges,
  isIdentityMatrix,
  matrixRecord,
  resizeGesture,
  rotateGesture,
  selectionGeometry,
  isTransformableShape,
  translationMatrix,
  IDENTITY_MATRIX,
  type ResizeHandler,
  type RotationCorner,
  type SelectionGeometry,
  type TransformEntry,
} from "@/lib/workspace-transform";
import {
  alignMoves,
  distributeMoves,
  type AlignAxis,
  type AlignMove,
  type DistributeAxis,
} from "@/lib/workspace-align";
import {
  areaInitialSelection,
  createHoverIdsCache,
  hoverShapeId,
  hoverStackAt,
  isFrameShape,
  isRootFrameShape,
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
  setDragDelta,
  setDrawPreview,
  setHover,
  setHoverShapeId,
  setHoverTopFrameId,
  setSelection,
  setTransformPreview,
  setUndoAvailability,
  setWorkspaceObjects,
  setWorkspaceState,
  setWorkspaceViewport,
  subscribeWorkspace,
  toggleSelection,
  type WorkspaceState,
} from "@/lib/workspace-store";
import {
  clientToWorld,
  fitViewport,
  initialViewport,
  normalizeWheel,
  pointToViewport,
  rectCenter,
  resizeViewport,
  scrollBy,
  shapesRect,
  wheelScrollDeltas,
  wheelZoomFactor,
  zoomBy,
  type ViewportPoint,
  type ViewportState,
} from "@/lib/workspace-viewport";

// clr/canvas, the background of a page without one.
const DEFAULT_BACKGROUND = "#E8E9EA";

// A plugin history block that never finishes stops folding after this long,
// so one forgotten undoBlockFinish cannot swallow the user's later edits.
const UNDO_BLOCK_TIMEOUT_MS = 10_000;

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

// The pending-click threshold (client pixels, 10 screen px since F9.3
// AD3): a release inside it selects the shape, a press that crosses it
// starts the move drag.
const CLICK_MOVE_THRESHOLD = 10;

// The hover-top-frame debounce of setup-hover-shapes (rx/debounce 50).
const TOP_FRAME_DEBOUNCE_MS = 50;

// The marquee minimum of handle-area-selection: the updates start once the
// width or the height passes 10 / zoom (world units).
const AREA_MIN_SIZE = 10;

// The onToolChange fallback until the shell wires the toolbar (F9.5 T6).
const NOOP_TOOL_CHANGE = (): void => {};

// The subtree entries of one gesture (F9.10 + F9.11). A resize sends the
// world matrix of its roots to the renderer as the "child" kind and takes
// the matrices it answers with: the constraint spread and the layout reflow
// are one algorithm there, shared with the drag and the attribute edits. A
// rotation keeps the local rigid spread (set-wasm-rotation-modifiers skips
// the child constraints on purpose, and the overlay previews that spread),
// and so does a wasm without the propagate ABI.
function gestureSubtreeEntries(
  app: RendererApp | null,
  objects: WorkspaceObjects,
  roots: readonly string[],
  matrix: Matrix6,
  rotation: number,
  propagate: boolean,
): TransformEntry[] {
  const accepted = roots.filter((id) => {
    const shape = objects[id];
    return shape !== undefined && shape !== null && isTransformableShape(shape);
  });
  if (accepted.length === 0) return [];
  // An identity gesture changes nothing, and the renderer reads identity as
  // "reflow this": asking it mid-gesture would snap a layout's children to
  // their flow positions before the user lets go. Answer the local spread,
  // which is the same no-op.
  if (isIdentityMatrix(matrix)) {
    return gestureEntries(objects, accepted, matrix, rotation, isTransformableShape);
  }
  if (propagate && rotation === 0 && app !== null) {
    try {
      return acceptedSubtreeEntries(
        objects,
        propagateModifiers(
          app,
          accepted.map((id) => ({ id, matrix })),
        ),
      );
    } catch (cause: unknown) {
      console.warn("[workspace] could not propagate the transform in wasm:", cause);
    }
  }
  return gestureEntries(objects, accepted, matrix, rotation, isTransformableShape);
}

// The resize/rotate gesture (F9.6): the selection geometry captured at the
// press (the selection cannot change mid-gesture), the handle or rotation
// corner, the selected ids the world matrix applies to and the last preview
// the release commits. Null outside a running transform gesture.
interface TransformGestureState {
  geometry: SelectionGeometry;
  handler: ResizeHandler | null;
  corner: RotationCorner | null;
  // The selection at the press: the gesture matrix applies to it, the
  // subtree and the constraints spread from it (F9.10).
  roots: string[];
  matrix: Matrix6 | null;
  rotation: number;
}

// The pointer gesture the handlers mutate (the CLJS keeps this spread
// across the stream pipeline).
interface PointerInteraction {
  mode: "idle" | "pan" | "area" | "click" | "drag" | "draw" | "resize" | "rotate";
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
  // The pending-drag branch decided at pointerdown (AD3): "group" (the hit
  // shape is selected: the drag moves the whole selection), "single" (the
  // drag replaces the selection with the hit shape) or "toggle" (shift:
  // the drag toggles it); null outside a pending or running drag.
  dragBranch: "group" | "single" | "toggle" | null;
  // The resolved move set while a drag runs (the selection plus the
  // subtrees of its containers, lib/workspace-move).
  dragIds: string[];
  // The selection as it was when the threshold was crossed: the restore
  // source of a pointercancel.
  selectionBeforeDrag: string[] | null;
  // The draw gesture (F9.5): the world press point, the parent resolved at
  // press time, whether the 10-screen-pixel threshold was crossed and the
  // last box (null under the threshold).
  drawStart: ViewportPoint | null;
  drawParentId: string | null;
  drawActive: boolean;
  drawRect: DrawRect | null;
  // The transform gesture state (F9.6).
  transformGesture: TransformGestureState | null;
}

// The $APP-backed pieces of the selection library (they need the wasm
// runtime): created once per load from appRef/wasmObjectsRef.
interface InteractionAdapters {
  sortIds: (ids: readonly string[], mod: boolean) => string[];
  intersectPosition: (id: string, point: ViewportPoint) => boolean;
  topFrame: (point: ViewportPoint) => string | null;
}

// The imperative zoom commands of the shell (F9.4): the right-header widget
// and the main menu drive the canvas through these, so the viewport math
// stays in this component and the store write path stays one.
export interface WorkspaceCanvasHandle {
  zoomIn(): void;
  zoomOut(): void;
  resetZoom(): void;
  zoomToFitAll(): void;
  zoomToSelection(): void;
  // F9.5 AD7: one mod-obj for the style panel; resolves false when the
  // file is read-only, the shape is gone or the commit could not run.
  updateShapeAttrs(id: string, attrs: Record<string, unknown>): Promise<boolean>;
  // F9.9: the multi-selection commit. One update-file call carries a mod-obj
  // per shape (the panel builds the per-shape patches, a shadow or a blur id
  // included), then the local model applies the same changes and one wasm
  // batch rewrites the records a style attribute touched. An empty list, or
  // a list whose shapes are all gone, resolves true without an RPC.
  updateShapesAttrs(updates: readonly ShapeUpdate[]): Promise<boolean>;
  // F9.9: one geometry edit from the size/position/rotation fields. The
  // canvas builds the same world matrix the resize and rotate gestures use,
  // commits one mod-obj and pushes the whole record to wasm; resolves true
  // without a request when the target already matches.
  updateShapeGeometry(id: string, target: GeometryTarget): Promise<boolean>;
  // F9.14: the align and distribute bar of the style panel. Each command
  // reads the current selection, asks lib/workspace-align where every shape
  // goes and commits the batch as one update-file call (one undo entry) with
  // the constraint spread of a move drag. Resolves true without a request
  // when nothing moves; false on a read-only file or a failed commit.
  alignSelection(axis: AlignAxis): Promise<boolean>;
  distributeSelection(axis: DistributeAxis): Promise<boolean>;
  // F9.7: one undo/redo step; the main menu and the Ctrl/Cmd+Z handler
  // reach the effect-owned stack through these.
  undo(): void;
  redo(): void;
  // F9.8: one vertical-order command over the current selection; the main
  // menu and the Ctrl/Cmd+arrow handlers reach the effect-owned command.
  orderSelection(location: VerticalOrderLocation): void;
  // F9.13: the page actions of the left sidebar. Each one commits a single
  // page change through the shared write path (recordUndo false: the undo
  // stack has no page inverse) and resolves null/false when the file is
  // read-only, a commit is already in flight or the backend rejects it.
  // createPage takes the id the plugin API already minted; a missing one is
  // minted here.
  createPage(id?: string): Promise<string | null>;
  renamePage(id: string, name: string): Promise<boolean>;
  deletePage(id: string): Promise<boolean>;
  // F7.4: the plugin bridge commands. They share the write path and the
  // viewport slice above, so a plugin edit is one undo entry and one
  // update-file request, like the panel commands.
  createShape(
    id: string,
    type: "frame" | "rect" | "ellipse",
    box: PluginDrawBox,
  ): Promise<boolean>;
  alignObjects(ids: readonly string[], axis: AlignAxis): Promise<boolean>;
  distributeObjects(ids: readonly string[], axis: DistributeAxis): Promise<boolean>;
  beginUndoBlock(): void;
  endUndoBlock(): void;
  viewport(): PluginViewportSnapshot | null;
  setZoom(zoom: number): void;
  setCenter(center: { x: number; y: number }): void;
  zoomReset(): void;
  zoomIntoView(ids: readonly string[]): void;
}

export interface WorkspaceWasmCanvasProps {
  fileId: string;
  pageId: string;
  // The resolved file of lib/workspace (the store's file): the initial fit
  // reads its page objects, the background its pages-index.
  file: WorkspaceFile;
  // The artboard-name toggle of the shell (View menu): the overlay labels
  // follow it, so the UI state stays out of the store.
  showFrameTitles: boolean;
  // The active toolbar tool (F9.5). Only frame/rect/ellipse draw; the shell
  // owns the state and the canvas mirrors it into a ref. Optional so the
  // component keeps working before the shell wires it (Task 6).
  tool?: WorkspaceTool;
  // The canvas asks the shell to switch tools (a completed draw returns to
  // move, like clear-drawing in the CLJS).
  onToolChange?: (tool: WorkspaceTool) => void;
  // React 19 passes ref as a normal prop; the shell owns the handle.
  ref?: Ref<WorkspaceCanvasHandle>;
}

// The ruler-overlay push of the compiled viewport effects: set-rulers-
// offsets! and set-rulers-selection! run on every selection change with the
// display-state* math of rulers_state.cljs.
function pushWorkspaceRulerState(
  app: RendererApp,
  objects: WorkspaceObjects | null,
  selection: readonly string[],
): void {
  const shapes: WorkspaceShape[] = [];
  for (const id of selection) {
    const shape = objects?.[id];
    if (shape !== null && shape !== undefined) shapes.push(shape);
  }

  // The tick-label offset: selecting a single root frame shifts the scale
  // to the frame origin; otherwise the shared parent frame of the
  // selection sets it (nil -> 0, like (:x selected-frame) on nil).
  let offsetX = 0;
  let offsetY = 0;
  if (shapes.length === 1 && isRootFrameShape(shapes[0])) {
    const first = shapes[0];
    offsetX = typeof first["x"] === "number" ? first["x"] : 0;
    offsetY = typeof first["y"] === "number" ? first["y"] : 0;
  } else if (shapes.length > 0) {
    const frameIds = new Set<string | null | undefined>();
    for (const shape of shapes) {
      const frameId = shape["frame-id"];
      if (typeof frameId === "string" || frameId === null || frameId === undefined) {
        frameIds.add(frameId);
      }
    }
    if (frameIds.size === 1) {
      const frameId = [...frameIds][0];
      if (frameId !== null && frameId !== undefined) {
        const frame = objects?.[frameId];
        offsetX = frame !== undefined && typeof frame["x"] === "number" ? frame["x"] : 0;
        offsetY = frame !== undefined && typeof frame["y"] === "number" ? frame["y"] : 0;
      }
    }
  }
  setWorkspaceRulersOffsets(app, offsetX, offsetY);

  // The purple selection band: the bounding rect of the selected shapes
  // (gsh/shapes->rect over :points, the same math shapesRect ports).
  setWorkspaceRulersSelection(app, shapesRect(shapes));
}

function WorkspaceWasmCanvasImpl({
  fileId,
  pageId,
  file,
  showFrameTitles,
  tool = "move",
  onToolChange,
  ref,
}: WorkspaceWasmCanvasProps) {
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
  // The move drag needs the internal modifier ABI; the load effect gates
  // it once per load (see the load sequence below).
  const dragEnabledRef = useRef(false);
  // F9.11: the geometry propagation ABI (_propagate_modifiers). A rebuild
  // without it keeps the local constraint spread and skips the reflow.
  const propagateEnabledRef = useRef(false);
  // The commit bookkeeping of the write path (F9.3 T3, AD5/AD11): the
  // interaction effect outlives prop changes, so the ids it commits with
  // and the guards all live in refs the load effect refreshes — the edit
  // gate, the revn counter and the vern guard (revn + vern of the current
  // file) and the session id minted once per mount.
  const fileIdRef = useRef(fileId);
  const pageIdRef = useRef(pageId);
  const canEditRef = useRef(true);
  const revnRef = useRef(0);
  const vernRef = useRef(0);
  const sessionIdRef = useRef<string | null>(null);
  // A commit in flight rejects new presses (AD9).
  const commitPendingRef = useRef(false);
  // The undo stack of this page load (F9.7): the canvas owns it and mirrors
  // its cursor into the store; the imperative handle and the keydown reach
  // the effect-owned commands through historyRef.
  const undoRef = useRef<UndoState>(createUndoState());
  const historyRef = useRef<{
    undo: () => void;
    redo: () => void;
  } | null>(null);
  // F7.4: an open plugin undo block. The first commit inside it records one
  // entry and the later ones fold into it, so one undo returns the whole
  // plugin transaction.
  const undoBlockRef = useRef<{ openedAt: number; recorded: boolean } | null>(null);
  // F9.8: the vertical-order command of the current load, owned by the
  // interaction effect like the history step.
  const orderRef = useRef<((location: VerticalOrderLocation) => void) | null>(null);
  // The tool prop mirrored for the long-lived interaction effect, the
  // onToolChange prop mirrored the same way, and the cursor repaint the
  // tool effect triggers without re-running the gesture effect.
  const toolRef = useRef<WorkspaceTool>(tool);
  const onToolChangeRef = useRef<(tool: WorkspaceTool) => void>(
    onToolChange ?? NOOP_TOOL_CHANGE,
  );
  const cursorRef = useRef<(() => void) | null>(null);
  // The overlay hands a handle press to the gesture effect through this
  // ref: the effect owns the pointer capture, the preview and the commit;
  // the overlay only knows the pointerdown.
  const gestureRef = useRef<{
    beginResize: (handler: ResizeHandler, event: ReactPointerEvent<SVGElement>) => void;
    beginRotate: (corner: RotationCorner, event: ReactPointerEvent<SVGElement>) => void;
  } | null>(null);

  // Stable callbacks for the overlay: the effect re-creates the gesture
  // closures on every load, the overlay keeps the same props.
  const handleResizeStart = useCallback(
    (handler: ResizeHandler, event: ReactPointerEvent<SVGElement>): void => {
      gestureRef.current?.beginResize(handler, event);
    },
    [],
  );

  const handleRotateStart = useCallback(
    (corner: RotationCorner, event: ReactPointerEvent<SVGElement>): void => {
      gestureRef.current?.beginRotate(corner, event);
    },
    [],
  );

  const [error, setError] = useState<string | null>(null);

  // The ruler overlay follows the store selection (rulers_state.cljs): a
  // selection change pushes the offset and the purple band into the wasm
  // UI state. The subscription skips unrelated store writes by comparing
  // the selection key; the canvas load itself pushes the initial state.
  const rulerSelectionKeyRef = useRef("");
  useEffect(() => {
    return subscribeWorkspace(() => {
      const app = appRef.current;
      if (app === null) return;
      const { selection, objects } = getWorkspaceState();
      const key = selection.join(",");
      if (key === rulerSelectionKeyRef.current) return;
      rulerSelectionKeyRef.current = key;
      pushWorkspaceRulerState(app, objects, selection);
    });
  }, []);

  // AD9: the canvas owns no tool state; it mirrors the shell prop and asks
  // the shell to switch back after a draw.
  useEffect(() => {
    toolRef.current = tool;
    cursorRef.current?.();
  }, [tool]);

  useEffect(() => {
    onToolChangeRef.current = onToolChange ?? NOOP_TOOL_CHANGE;
  }, [onToolChange]);

  // AD6: the single pessimistic write path of the canvas (F9.5). Every draw
  // and every style edit funnels through here, so the in-flight guard
  // (commitPendingRef), the revn advance and the vern guard live in one
  // place. Returns the revn the backend reported, or null when a commit is
  // already in flight or the session id is missing; throws when the request
  // fails (the callers own their error reporting and local rollback).
  const sendUpdateFile = useCallback(
    async (
      changes: UpdateFileChange[],
      recordUndo: boolean | "merge" = true,
      undoBase?: WorkspaceObjects | null,
    ): Promise<number | null> => {
      const sessionId = sessionIdRef.current;
      if (sessionId === null || commitPendingRef.current) return null;
      // An open plugin undo block folds every commit after its first into
      // one undo entry; a block past its timeout is dropped, so a plugin
      // that never finishes cannot swallow the user's later edits.
      if (
        undoBlockRef.current !== null &&
        Date.now() - undoBlockRef.current.openedAt > UNDO_BLOCK_TIMEOUT_MS
      ) {
        undoBlockRef.current = null;
      }
      const block = undoBlockRef.current;
      const mode: boolean | "merge" =
        block !== null && recordUndo === true
          ? block.recorded
            ? "merge"
            : true
          : recordUndo;
      // The inverse is derived from the model the commit was built on, so
      // the snapshot and the selection are taken before the request. The
      // inversion runs before the request too: a change that cannot be
      // undone must not reach the file. A merged request may name its own
      // base: a reflow trails an attribute edit that already reached the
      // model, and undo must land on the state before that edit.
      const record = mode !== false;
      const before = record ? (undoBase !== undefined ? undoBase : objectsRef.current) : null;
      const selectionBefore = record ? [...getWorkspaceState().selection] : [];
      const undoChanges =
        record && before !== null ? invertChanges(before, changes) : [];
      commitPendingRef.current = true;
      try {
        const body = encodeUpdateFile({
          id: fileIdRef.current,
          "session-id": sessionId,
          revn: revnRef.current,
          vern: vernRef.current,
          changes,
        });
        const response = await cmdEncoded<{ revn?: unknown }>("update-file", body);
        const revn =
          response !== null && typeof response === "object" ? response.revn : undefined;
        if (typeof revn !== "number") {
          throw new Error("update-file: the response carried no revn");
        }
        // The response revn is the file revn BEFORE this commit, and
        // process-changes-and-validate raised the stored one to at least
        // revn + 1 (the T3 E2E saw it: only the lagged rows carry the
        // post-commit revn). The local guard tracks that bound: the CLJS
        // persistence advances optimistically, and the backend only
        // rejects a revn ABOVE the stored one (files_update.clj), so a
        // lagging submit stays accepted.
        revnRef.current = Math.max(revnRef.current, revn + 1);
        // The decoded cache of lib/render-wasm/workspace-data still holds
        // the file as it stood before this commit. Drop it, so a page
        // switch or a reload re-reads the file from the backend (a page
        // created above lands there, a renamed page shows its new name).
        invalidateDecodedWorkspaceFile(appRef.current, fileIdRef.current);
        // F9.7: one successful request is one undo entry, whatever the
        // number of changes (a move plus its reparent stays one step).
        if (undoChanges.length > 0) {
          const entry = {
            changes: [...changes],
            undoChanges,
            selectionBefore,
            selectionAfter: selectionBefore,
          };
          undoRef.current =
            mode === "merge"
              ? mergeUndo(undoRef.current, entry)
              : pushUndo(undoRef.current, entry);
          setUndoAvailability(canUndo(undoRef.current), canRedo(undoRef.current));
          // The first recorded commit of a plugin block opens its entry;
          // the later ones folded into it above.
          if (block !== null) block.recorded = true;
        }
        // handle-state-change "contentsave": the commit is persisted, so
        // the plugin callbacks run (debounced, without arguments).
        notifyPluginContentSaved();
        return revn;
      } finally {
        commitPendingRef.current = false;
      }
    },
    [],
  );

  // F9.11: the shell half of a layout reflow. The renderer owns the layout
  // algorithm (reflow_flex_layout / reflow_grid_layout), so the shell marks
  // the edited containers with an identity transform — the "reflow this"
  // mark — and takes the matrices it answers with. Those become one
  // update-file request that merges into the attribute edit that asked for
  // it, plus the same matrices applied to the model and pushed to wasm. The
  // inverse is built from `before`, the model as it stood before the edit,
  // so one undo step returns both the attributes and the child positions.
  // A missing ABI, a failing call or a reflow that moves nothing leaves the
  // committed attributes alone.
  const commitReflow = useCallback(
    async (
      before: WorkspaceObjects,
      after: WorkspaceObjects,
      updates: readonly ReflowUpdate[],
    ): Promise<void> => {
      if (!propagateEnabledRef.current) return;
      const app = appRef.current;
      if (app === null) return;
      try {
        const ids = reflowTargetIds(after, updates);
        if (ids.length === 0) return;
        const transforms = propagateModifiers(app, reflowEntries(ids));
        const changes = reflowChanges(after, transforms, pageIdRef.current);
        if (changes.length === 0) return;
        const revn = await sendUpdateFile(changes, "merge", before);
        if (revn === null) return;
        const next = applyReflow(after, transforms);
        objectsRef.current = next;
        indexRef.current = createWorkspaceIndex(next);
        setWorkspaceObjects(next);
        try {
          const shapes: WorkspaceShape[] = [];
          for (const [id] of transforms) {
            const shape = next[id];
            if (shape !== undefined && shape !== null) shapes.push(shape);
          }
          uploadShapeGeometry(app, shapes);
        } catch (cause: unknown) {
          console.warn("[workspace] could not sync the reflow to wasm:", cause);
        }
      } catch (cause: unknown) {
        // The attributes are committed and the file keeps them; only the
        // reflowed positions are behind.
        console.warn("[workspace] could not reflow the layout:", cause);
      }
    },
    [sendUpdateFile],
  );

  // F9.14: the align / distribute commands. A moved shape becomes one
  // translation matrix, spread to its subtree by the same constraints the
  // move drag applies, and the whole batch rides one update-file request so
  // one undo returns the selection to its old place. A batch that moves
  // nothing sends nothing and resolves true (the command already holds).
  const commitTranslationMoves = useCallback(
    async (moves: readonly AlignMove[]): Promise<boolean> => {
      if (!canEditRef.current) return false;
      const objects = objectsRef.current;
      if (objects === null) return false;
      const entries: TransformEntry[] = [];
      const seen = new Set<string>();
      for (const move of moves) {
        const shape = objects[move.id];
        if (shape === undefined || shape === null || !isTransformableShape(shape)) continue;
        // The renderer spreads the matrix to the children when the
        // constraint ABI is there; the local spread is the fallback.
        const subtree = gestureSubtreeEntries(
          appRef.current,
          objects,
          [move.id],
          translationMatrix(move.dx, move.dy),
          0,
          propagateEnabledRef.current,
        );
        for (const entry of subtree) {
          if (seen.has(entry.id)) continue;
          seen.add(entry.id);
          entries.push(entry);
        }
      }
      if (entries.length === 0) return true;
      const changes = buildTransformEntryChanges(objects, entries, pageIdRef.current);
      if (changes.length === 0) return true;
      try {
        const revn = await sendUpdateFile(changes);
        if (revn === null) return false;
        // Re-read: the model may have been replaced while the RPC ran. The
        // patches carry absolute geometry, so they land on either snapshot.
        const currentObjects = objectsRef.current;
        if (currentObjects === null) return false;
        const next = applyTransformEntries(currentObjects, entries);
        objectsRef.current = next;
        indexRef.current = createWorkspaceIndex(next);
        setWorkspaceObjects(next);
        const app = appRef.current;
        if (app !== null) {
          try {
            // The whole record: set_object carries the selrect, points and
            // transform a selrect-only push would drop.
            const shapes: WorkspaceShape[] = [];
            for (const id of seen) {
              const shape = next[id];
              if (shape !== undefined && shape !== null) shapes.push(shape);
            }
            uploadShapeGeometry(app, shapes);
          } catch (cause: unknown) {
            console.warn("[workspace] could not sync the aligned shapes to wasm:", cause);
          }
        }
        return true;
      } catch (cause: unknown) {
        console.error("[workspace] align commit failed:", cause);
        setWorkspaceState({ error: cause });
        return false;
      }
    },
    [sendUpdateFile],
  );

  // F9.13: the page actions of the left sidebar. The backend has no page
  // RPC: create, rename and delete are the :add-page / :mod-page /
  // :del-page changes of update-file, so each action commits through the
  // shared write path and mirrors the same change into the store's file.
  // recordUndo stays false: lib/workspace-undo inverts shape changes from
  // the page model and has no page inverse.
  const createPage = useCallback(async (requestedId?: string): Promise<string | null> => {
    if (!canEditRef.current) return null;
    const current = getWorkspaceState().file;
    if (current === null) return null;
    // The plugin API mints the id so its page proxy can answer before the
    // commit lands; a page that already exists is left alone.
    if (requestedId !== undefined && (current.data.pages ?? []).includes(requestedId)) {
      return requestedId;
    }
    const id = requestedId ?? crypto.randomUUID();
    const name = uniquePageName(pageInfos(current).map((page) => page.name));
    try {
      const revn = await sendUpdateFile([addPageChange(id, name)], false);
      if (revn === null) return null;
      // The backend builds the page with ctp/make-empty-page; the local
      // copy clones the open page's root frame (a page root carries no
      // children) so the JS model has the page before the next load.
      // Re-read the file: a commit may have landed while the RPC ran.
      const latest = getWorkspaceState().file ?? current;
      const root = pageObjects(latest, getWorkspaceState().pageId)[ZERO_UUID] ?? null;
      setWorkspaceState({ file: withPageAdded(latest, emptyPage(id, name, root)) });
      return id;
    } catch (cause: unknown) {
      console.error("[workspace] page create failed:", cause);
      setWorkspaceState({ error: cause });
      return null;
    }
  }, [sendUpdateFile]);

  // mod-page :name. The page map keeps its objects reference, so the
  // canvas load effect (keyed on the open page objects) does not reload
  // and the viewport, the selection and the undo stack survive.
  const renamePage = useCallback(
    async (id: string, name: string): Promise<boolean> => {
      if (!canEditRef.current) return false;
      const trimmed = normalizePageName(name);
      if (!validPageName(trimmed)) return false;
      const current = getWorkspaceState().file;
      if (current === null) return false;
      const page = (current.data["pages-index"] ?? {})[id];
      if (page === undefined || page === null) return false;
      if (page.name === trimmed) return true;
      try {
        const revn = await sendUpdateFile([renamePageChange(id, trimmed)], false);
        if (revn === null) return false;
        const latest = getWorkspaceState().file ?? current;
        setWorkspaceState({ file: withPageRenamed(latest, id, trimmed) });
        return true;
      } catch (cause: unknown) {
        console.error("[workspace] page rename failed:", cause);
        setWorkspaceState({ error: cause });
        return false;
      }
    },
    [sendUpdateFile],
  );

  // del-page. The last page stays (the sidebar hides the button; the CLJS
  // sitemap refuses to empty the file too). Deleting the open page moves
  // the selection to the first remaining one in the same store write, so
  // no render sees the open page gone.
  const deletePage = useCallback(
    async (id: string): Promise<boolean> => {
      if (!canEditRef.current) return false;
      const current = getWorkspaceState().file;
      if (current === null) return false;
      const pages = current.data.pages ?? [];
      if (pages.length <= 1 || !pages.includes(id)) return false;
      try {
        const revn = await sendUpdateFile([deletePageChange(id)], false);
        if (revn === null) return false;
        const latest = getWorkspaceState().file ?? current;
        const patch: Partial<WorkspaceState> = { file: withPageDeleted(latest, id) };
        if (getWorkspaceState().pageId === id) {
          patch.pageId = (latest.data.pages ?? []).find((pageId) => pageId !== id) ?? null;
        }
        setWorkspaceState(patch);
        return true;
      } catch (cause: unknown) {
        console.error("[workspace] page delete failed:", cause);
        setWorkspaceState({ error: cause });
        return false;
      }
    },
    [sendUpdateFile],
  );

  // One write path for the imperative commands: the same stateRef plus
  // set-view-box plus store slice the wheel flush uses, so the overlay and
  // the wasm viewport cannot diverge.
  const applyViewport = useCallback((next: ViewportState): void => {
    const app = appRef.current;
    if (app === null) return;
    stateRef.current = next;
    setWorkspaceViewBox(app, next.zoom, next.vbox);
    setWorkspaceViewport(next);
  }, []);

  const handle = useMemo<WorkspaceCanvasHandle>(() => {
    // reset-zoom: land on zoom 1 around the current center. Shared by the
    // menu command and the plugin viewport proxy.
    const resetZoom = (): void => {
      const state = stateRef.current;
      if (state !== null) {
        applyViewport(zoomBy(state, rectCenter(state.vbox), 1 / state.zoom));
      }
    };
    // fit-to-shapes (padding 40): the selection command and the plugin
    // zoomIntoView over an explicit id list.
    const fitToIds = (ids: readonly string[]): void => {
      const state = stateRef.current;
      const objects = objectsRef.current;
      if (state === null || objects === null) return;
      const shapes: WorkspaceShape[] = [];
      for (const id of ids) {
        const shape = objects[id];
        if (shape !== undefined && shape !== null) shapes.push(shape);
      }
      const srect = shapesRect(shapes);
      if (srect === null) return;
      const next = fitViewport(state.vport, srect, 40);
      if (next !== null) applyViewport(next);
    };

    return {
      // increase-zoom / decrease-zoom around the box center.
      zoomIn: () => {
        const state = stateRef.current;
        if (state !== null) applyViewport(zoomBy(state, rectCenter(state.vbox), 1.3));
      },
      zoomOut: () => {
        const state = stateRef.current;
        if (state !== null) applyViewport(zoomBy(state, rectCenter(state.vbox), 1 / 1.3));
      },
      // reset-zoom: land on zoom 1 around the current center.
      resetZoom,
      zoomReset: resetZoom,
      // zoom-to-fit-all over the root children (padding 160).
      zoomToFitAll: () => {
        const state = stateRef.current;
        const objects = objectsRef.current;
        if (state === null || objects === null) return;
        const srect = shapesRect(immediateChildren(objects));
        if (srect === null) return;
        const next = fitViewport(state.vport, srect, 160);
        if (next !== null) applyViewport(next);
      },
      // zoom-to-selected-shape over the current selection (padding 40); an
      // empty selection is a no-op (the menu disables the item).
      zoomToSelection: () => fitToIds(getWorkspaceState().selection),
      // AD7 (F9.5): one mod-obj with one set per attribute; the local model
      // applies the same attrs before the promise resolves, then the
      // wasm-visible subset is pushed. A wasm failure never fails the
      // commit (the file already accepted it).
      updateShapeAttrs: async (id, attrs) => {
        if (!canEditRef.current) return false;
        const objects = objectsRef.current;
        if (objects === null) return false;
        const shape = objects[id];
        if (shape === undefined || shape === null) return false;
        try {
          const revn = await sendUpdateFile([
            buildStyleChange(id, pageIdRef.current, attrs),
          ]);
          if (revn === null) return false;
          // Re-read: the model may have been replaced while the RPC ran.
          const currentObjects = objectsRef.current;
          const currentShape = currentObjects === null ? undefined : currentObjects[id];
          if (currentObjects === null || currentShape === undefined || currentShape === null) {
            return false;
          }
          // A nil val deletes the attribute, the rule ctn/set-shape-attr
          // applies on the backend: a removed shadow or blur must leave no
          // null key behind on the local model.
          const nextShape: WorkspaceShape = { ...currentShape };
          for (const [attr, val] of Object.entries(attrs)) {
            if (val === null || val === undefined) delete nextShape[attr];
            else nextShape[attr] = val;
          }
          const next = { ...currentObjects, [id]: nextShape };
          objectsRef.current = next;
          indexRef.current = createWorkspaceIndex(next);
          setWorkspaceObjects(next);
          const app = appRef.current;
          if (app !== null) {
            try {
              applyShapeStyle(app, nextShape, attrs);
            } catch (cause: unknown) {
              console.warn("[workspace] could not sync the style to wasm:", cause);
            }
          }
          // F9.11: a layout attribute re-places the children. wasm holds the
          // new record now, so the reflow is one request away. A failure
          // there never fails the committed edit.
          await commitReflow(currentObjects, next, [{ id, attrs }]);
          return true;
        } catch (cause: unknown) {
          console.error("[workspace] style commit failed:", cause);
          setWorkspaceState({ error: cause });
          return false;
        }
      },
      // F9.9: one RPC and one wasm batch for a whole selection. The changes
      // go in order, applyUpdateChanges mirrors them (a nil val deletes the
      // attribute), and only the shapes whose attrs the renderer reads are
      // rewritten in wasm: a blocked-only edit stays a JS-side change.
      updateShapesAttrs: async (updates) => {
        if (!canEditRef.current) return false;
        const objects = objectsRef.current;
        if (objects === null) return false;
        const entries = updates.filter(
          (update) =>
            Object.keys(update.attrs).length > 0 &&
            objects[update.id] !== undefined &&
            objects[update.id] !== null,
        );
        if (entries.length === 0) return true;
        const changes = entries.map((entry) =>
          buildStyleChange(entry.id, pageIdRef.current, entry.attrs),
        );
        try {
          const revn = await sendUpdateFile(changes);
          if (revn === null) return false;
          // Re-read: the model may have been replaced while the RPC ran.
          const currentObjects = objectsRef.current;
          if (currentObjects === null) return false;
          const after = applyUpdateChanges(currentObjects, changes);
          objectsRef.current = after;
          indexRef.current = createWorkspaceIndex(after);
          setWorkspaceObjects(after);
          const app = appRef.current;
          if (app !== null) {
            const styled = changes.filter((_, index) =>
              attrsWriteStyle(entries[index].attrs),
            );
            if (styled.length > 0) {
              try {
                uploadChangedShapes(app, currentObjects, after, styled);
              } catch (cause: unknown) {
                console.warn(
                  "[workspace] could not sync the style batch to wasm:",
                  cause,
                );
              }
            }
          }
          // F9.11: the layout edits of the batch ask for one reflow each,
          // after the batch reached wasm. A failure there never fails the
          // committed edits.
          await commitReflow(currentObjects, after, entries);
          return true;
        } catch (cause: unknown) {
          console.error("[workspace] style batch failed:", cause);
          setWorkspaceState({ error: cause });
          return false;
        }
      },
      // F9.9: the size/position/rotation fields of the style panel. One
      // mod-obj built with the same world matrices the gestures use, then
      // the local model and the wasm record. A target equal to the current
      // geometry sends nothing and resolves true: the wanted state already
      // holds, so the panel must not flash its generic error.
      //
      // F9.10: the same matrix spreads to the subtree, so a frame resized
      // from the panel moves its children by their constraints too.
      updateShapeGeometry: async (id, target) => {
        if (!canEditRef.current) return false;
        const objects = objectsRef.current;
        if (objects === null) return false;
        const shape = objects[id];
        if (shape === undefined || shape === null) return false;
        const change = buildGeometryChange(shape, target, pageIdRef.current);
        if (change === null) return true;
        const gesture = geometryTransform(shape, target);
        const descendants =
          gesture === null
            ? []
            : gestureSubtreeEntries(
                appRef.current,
                objects,
                [id],
                gesture.matrix,
                gesture.rotationDelta,
                propagateEnabledRef.current,
              ).filter((entry) => entry.id !== id);
        const extra = buildTransformEntryChanges(objects, descendants, pageIdRef.current);
        try {
          const revn = await sendUpdateFile(extra.length === 0 ? [change] : [change, ...extra]);
          if (revn === null) return false;
          // Re-read: the model may have been replaced while the RPC ran. The
          // patch carries absolute geometry, so it lands on either snapshot.
          const currentObjects = objectsRef.current;
          const currentShape = currentObjects === null ? undefined : currentObjects[id];
          if (currentObjects === null || currentShape === undefined || currentShape === null) {
            return false;
          }
          const patched = applyUpdateChanges({ [id]: currentShape }, [change])[id];
          const next = applyTransformEntries({ ...currentObjects, [id]: patched }, descendants);
          objectsRef.current = next;
          indexRef.current = createWorkspaceIndex(next);
          setWorkspaceObjects(next);
          const app = appRef.current;
          if (app !== null) {
            try {
              // The whole record: set_object carries the selrect, points,
              // rotation and transform a selrect-only push would drop.
              const shapes: WorkspaceShape[] = [patched];
              for (const entry of descendants) {
                const moved = next[entry.id];
                if (moved !== undefined && moved !== null) shapes.push(moved);
              }
              uploadShapeGeometry(app, shapes);
            } catch (cause: unknown) {
              console.warn("[workspace] could not sync the new geometry to wasm:", cause);
            }
          }
          return true;
        } catch (cause: unknown) {
          console.error("[workspace] geometry commit failed:", cause);
          setWorkspaceState({ error: cause });
          return false;
        }
      },
      undo: () => historyRef.current?.undo(),
      redo: () => historyRef.current?.redo(),
      orderSelection: (location) => orderRef.current?.(location),
      alignSelection: (axis) =>
        commitTranslationMoves(
          alignMoves(objectsRef.current ?? {}, getWorkspaceState().selection, axis),
        ),
      distributeSelection: (axis) =>
        commitTranslationMoves(
          distributeMoves(objectsRef.current ?? {}, getWorkspaceState().selection, axis),
        ),
      // F7.4: api.cljs create-shape. One add-obj under the page root at the
      // plugin box; the id comes from the caller so its proxy can answer
      // before the commit. The CLJS does not select the new shape either.
      createShape: async (id, type, box) => {
        if (!canEditRef.current) return false;
        const objects = objectsRef.current;
        if (objects === null) return false;
        const parentId = ZERO_UUID;
        const parent = objects[parentId];
        if (parent === undefined || parent === null) return false;
        const shape = createDrawShape(type, box, parentId, id);
        const change: UpdateFileChange = {
          type: "add-obj",
          id: shape.id,
          obj: shape,
          "page-id": pageIdRef.current,
          "frame-id": parentId,
          "parent-id": parentId,
        };
        try {
          const revn = await sendUpdateFile([change]);
          if (revn === null) return false;
          // The local mirror of add-shape: insert under the root and rebuild
          // the hit-testing index. Re-read: a commit may have landed while
          // the RPC ran.
          const next = applyAddShape(objectsRef.current ?? objects, shape, parentId);
          objectsRef.current = next;
          indexRef.current = createWorkspaceIndex(next);
          setWorkspaceObjects(next);
          const app = appRef.current;
          if (app !== null) {
            try {
              uploadNewShape(app, shape, next[parentId]);
            } catch (cause: unknown) {
              console.warn("[workspace] could not sync the new shape to wasm:", cause);
            }
          }
          return true;
        } catch (cause: unknown) {
          console.error("[workspace] shape create failed:", cause);
          setWorkspaceState({ error: cause });
          return false;
        }
      },
      // F7.4: the plugin align/distribute over an explicit id list; the same
      // commit the panel commands use.
      alignObjects: (ids, axis) =>
        commitTranslationMoves(alignMoves(objectsRef.current ?? {}, ids, axis)),
      distributeObjects: (ids, axis) =>
        commitTranslationMoves(distributeMoves(objectsRef.current ?? {}, ids, axis)),
      // F7.4: one plugin history block. sendUpdateFile records the first
      // commit and folds the rest into it; the timestamp drops a block a
      // plugin forgets to finish.
      beginUndoBlock: () => {
        undoBlockRef.current = { openedAt: Date.now(), recorded: false };
      },
      endUndoBlock: () => {
        undoBlockRef.current = null;
      },
      viewport: () => {
        const state = stateRef.current;
        if (state === null) return null;
        return { zoom: state.zoom, vbox: { ...state.vbox } };
      },
      // set-zoom: the plugin sends an absolute zoom, the viewport math takes
      // a factor around the box center.
      setZoom: (zoom) => {
        const state = stateRef.current;
        if (state === null || !(zoom > 0)) return;
        applyViewport(zoomBy(state, null, zoom / state.zoom));
      },
      // update-viewport-position: shift the box so its center lands on the
      // requested world point.
      setCenter: (center) => {
        const state = stateRef.current;
        if (state === null) return;
        const current = rectCenter(state.vbox);
        applyViewport(scrollBy(state, center.x - current.x, center.y - current.y));
      },
      zoomIntoView: fitToIds,
      createPage,
      renamePage,
      deletePage,
    };
  }, [
    applyViewport,
    commitReflow,
    commitTranslationMoves,
    createPage,
    deletePage,
    renamePage,
    sendUpdateFile,
  ]);

  useImperativeHandle(ref, () => handle, [handle]);

  // F7.4: the plugin proxies of lib/plugin-context reach the same object the
  // shell drives; objects() is the live JS model of the interaction layer.
  useEffect(() => {
    registerWorkspaceBridge({ ...handle, objects: () => objectsRef.current });
    return () => registerWorkspaceBridge(null);
  }, [handle]);

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

  // The load key of the canvas: the open page map, not the whole file. A
  // page rename (or a change to another page of the sitemap) then leaves
  // the canvas alone, so the viewport, the selection and the undo stack
  // survive it; a page switch still changes pageId and reloads.
  const canvasPage = (file.data["pages-index"] ?? {})[pageId] ?? null;
  const canvasObjects = canvasPage?.objects ?? null;
  const canvasBackground =
    typeof canvasPage?.background === "string" ? canvasPage.background : DEFAULT_BACKGROUND;
  const canvasCanEdit = canEditFile(file);
  const canvasRevn = typeof file.revn === "number" ? file.revn : 0;
  const canvasVern = typeof file.vern === "number" ? file.vern : 0;

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
    dragEnabledRef.current = false;
    propagateEnabledRef.current = false;
    // F9.7: the stack is per load (see lib/workspace-undo); a page switch
    // reloads the model, so no entry may survive it.
    undoRef.current = createUndoState();
    setUndoAvailability(false, false);
    // The write-path bookkeeping of this file (AD5/AD11): the ids the
    // interaction effect commits with, the edit gate, the revn/vern
    // guards and the session id minted once per mount.
    fileIdRef.current = fileId;
    pageIdRef.current = pageId;
    canEditRef.current = canvasCanEdit;
    revnRef.current = canvasRevn;
    vernRef.current = canvasVern;
    if (sessionIdRef.current === null) {
      sessionIdRef.current = crypto.randomUUID();
    }

    void (async () => {
      try {
        const app = await loadRenderer();
        if (!alive()) return;
        await ensureWasmModule(app);
        if (!alive()) return;

        // F9.3: the move drag drives the internal modifier ABI directly;
        // gate it once per load so a wasm rebuild missing an entry point
        // degrades to the F9.2 click behavior instead of trapping. Both
        // sets gate the drag: the preview needs set-modifiers, and a
        // commit must be able to hand the geometry over to the pool (a
        // missing push entry would leave the wasm side stale after a
        // commit).
        const missing = missingInternals(app, [
          ...DRAG_PREVIEW_INTERNALS,
          ...GEOMETRY_PUSH_INTERNALS,
        ]);
        dragEnabledRef.current = missing.length === 0;
        if (missing.length > 0) {
          console.warn(`[render-wasm] drag disabled, missing internals: ${missing.join(", ")}`);
        }

        // F9.11: the geometry propagation ABI drives the resize spread and
        // the layout reflow. A rebuild without it keeps the local constraint
        // spread of F9.10 and commits no reflow.
        const missingPropagate = missingInternals(app, PROPAGATE_INTERNALS);
        propagateEnabledRef.current = missingPropagate.length === 0;
        if (missingPropagate.length > 0) {
          console.warn(
            `[render-wasm] geometry propagation disabled, missing internals: ${missingPropagate.join(", ")}`,
          );
        }

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
        const objects = canvasObjects ?? {};
        objectsRef.current = objects;
        indexRef.current = createWorkspaceIndex(objects);
        // AD10: the store carries the same reference the overlay draws from
        // (a commit replaces it together with the ref).
        setWorkspaceObjects(objects);
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
        const background = canvasBackground;

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

        // The workspace chrome: rulers visible, a rounded viewport frame
        // and the light ruler palette (the wasm default is the dark
        // theme), like the compiled viewport effects after the canvas init.
        setWorkspaceRulerColors(app);
        setWorkspaceRulersVisible(app, true);

        // Push the current selection into the ruler overlay (F9.2+): the
        // load reset the store selection above, but a race where the layer
        // panel already named a shape before the canvas was ready is
        // possible. Also pushes zero offsets. The key ref sync keeps the
        // store subscription in step with this direct push.
        const loadedSelection = getWorkspaceState().selection;
        pushWorkspaceRulerState(app, objects, loadedSelection);
        rulerSelectionKeyRef.current = loadedSelection.join(",");

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
  }, [
    canvasBackground,
    canvasCanEdit,
    canvasObjects,
    canvasRevn,
    canvasVern,
    fileId,
    pageId,
  ]);

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
      dragBranch: null,
      dragIds: [],
      selectionBeforeDrag: null,
      drawStart: null,
      drawParentId: null,
      drawActive: false,
      drawRect: null,
      transformGesture: null,
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

    // The move drag (F9.3): the rAF-merged preview flush, the latest world
    // position of the pointer and whether the modifier overrides are live.
    const drag = {
      active: false,
      rafId: 0,
      currentWorld: null as ViewportPoint | null,
    };

    // The resize/rotate gesture (F9.6): the same one-preview-per-frame
    // shape as the move drag, plus the modifier keys the latest pointer
    // event reported (Shift locks the aspect ratio, Alt centers a resize,
    // mod snaps a rotation to 45 degrees and Shift to 15).
    const transform = {
      active: false,
      rafId: 0,
      currentWorld: null as ViewportPoint | null,
      shift: false,
      alt: false,
      mod: false,
    };

    const canvasOrigin = (): ViewportPoint => {
      const bbox = canvas.getBoundingClientRect();
      return { x: bbox.left, y: bbox.top };
    };

    const toWorld = (client: ViewportPoint, state: ViewportState): ViewportPoint =>
      clientToWorld(client, canvasOrigin(), state.zoom, state.vbox);

    const updateCursor = (): void => {
      if (interaction.mode === "pan") canvas.style.cursor = "grabbing";
      else if (keys.space) canvas.style.cursor = "grab";
      else if (isDrawTool(toolRef.current)) canvas.style.cursor = "crosshair";
      else if (hoverActive) canvas.style.cursor = "pointer";
      else canvas.style.cursor = "default";
    };

    // The tool mirror effect repaints the cursor through this hook without
    // re-running the gesture effect.
    cursorRef.current = updateCursor;

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

    // One preview configuration per frame: the world delta against the
    // press anchor, splat as one translation matrix over the move set (the
    // CLJS apply-wasm-modifiers translation branch — no snap-pixel, no
    // ignore-geometry; AD2).
    const flushDrag = (): void => {
      drag.rafId = 0;
      const app = appRef.current;
      const current = drag.currentWorld;
      const down = interaction.downWorld;
      if (app === null || current === null || down === null) return;
      if (interaction.mode !== "drag" || interaction.cancelled) return;
      const dx = current.x - down.x;
      const dy = current.y - down.y;
      const matrix: Matrix6 = [1, 0, 0, 1, dx, dy];
      configureModifiers(
        app,
        interaction.dragIds.map((id) => [id, matrix] as const),
      );
      // The overlay offsets the selection visuals by the same delta.
      setDragDelta({ dx, dy });
    };

    // One transform preview per frame (F9.6): the local gesture math of
    // lib/workspace-transform against the geometry captured at the press,
    // splat as one world matrix over the transform set. The same matrix
    // drives the wasm overrides and the store preview, so the canvas and
    // the overlay cannot drift.
    const flushTransform = (): void => {
      transform.rafId = 0;
      const app = appRef.current;
      const current = transform.currentWorld;
      const gesture = interaction.transformGesture;
      const down = interaction.downWorld;
      if (app === null || current === null || gesture === null || down === null) return;
      if (interaction.mode !== "resize" && interaction.mode !== "rotate") return;
      if (interaction.cancelled) return;

      let matrix: Matrix6;
      let rotation = 0;
      if (interaction.mode === "resize") {
        const handler = gesture.handler;
        if (handler === null) return;
        const result = resizeGesture(gesture.geometry, handler, down, current, {
          lock: transform.shift || gesture.geometry.proportionLock,
          center: transform.alt,
        });
        if (result === null) return;
        matrix = result.matrix;
      } else {
        const result = rotateGesture(gesture.geometry.center, down, current, {
          // The CLJS cond gives mod priority over shift (45 before 15).
          snap45: transform.mod,
          snap15: transform.shift && !transform.mod,
        });
        matrix = result.matrix;
        rotation = result.angle;
      }

      gesture.matrix = matrix;
      gesture.rotation = rotation;
      // The same entries the release commits drive the preview. From F9.11 a
      // resize takes the renderer's answer (constraints plus layout reflow);
      // a rotation keeps the local rigid spread.
      const objects = objectsRef.current;
      if (objects === null) return;
      const entries = gestureSubtreeEntries(
        app,
        objects,
        gesture.roots,
        matrix,
        rotation,
        propagateEnabledRef.current,
      );
      configureModifiers(
        app,
        entries.map((entry) => [entry.id, entry.matrix] as const),
      );
      setTransformPreview(matrixRecord(matrix));
    };

    // The press of a resize handle or a rotation zone (F9.6). The overlay
    // sees the pointerdown and hands it here — the canvas never does — and
    // the canvas captures the pointer from that press and runs the gesture
    // to the release. The identity preview enters the state at once, so
    // the overlay hides the handles before the first move.
    const beginTransform = (
      mode: "resize" | "rotate",
      handler: ResizeHandler | null,
      corner: RotationCorner | null,
      event: ReactPointerEvent<SVGElement>,
    ): void => {
      if (interaction.mode !== "idle") return;
      if (commitPendingRef.current) return;
      // A read-only file and a wasm without the modifier ABI keep the F9.2
      // behavior: no gesture starts.
      if (!canEditRef.current || !dragEnabledRef.current) return;
      const app = appRef.current;
      const state = stateRef.current;
      const objects = objectsRef.current;
      if (app === null || state === null || objects === null) return;
      const selection = getWorkspaceState().selection;
      const geometry = selectionGeometry(objects, selection);
      if (geometry === null) return;
      // The roots are the selection: the commit and the preview spread the
      // matrix to their subtrees with the constraint rules
      // (lib/workspace-constraints), filtered to the types the generic
      // transform supports (a text child keeps its geometry, AD6).
      if (selection.length === 0) return;

      event.preventDefault();
      event.stopPropagation();
      canvas.setPointerCapture(event.pointerId);

      const client = { x: event.clientX, y: event.clientY };
      const world = toWorld(client, state);
      interaction.mode = mode;
      interaction.pointerId = event.pointerId;
      interaction.downClient = client;
      interaction.downWorld = world;
      interaction.moved = false;
      interaction.cancelled = false;
      interaction.transformGesture = {
        geometry,
        handler,
        corner,
        roots: [...selection],
        matrix: null,
        rotation: 0,
      };
      transform.active = true;
      transform.currentWorld = world;
      transform.shift = event.shiftKey;
      transform.alt = event.altKey;
      transform.mod = isMacos() ? event.metaKey : event.ctrlKey;
      // The hover visuals belong to the idle state.
      hoverActive = false;
      setHover(null);
      setHoverShapeId(null);
      setTransformPreview(matrixRecord(IDENTITY_MATRIX));
      startModifiers(app);
      updateCursor();
    };

    const beginResize = (
      handler: ResizeHandler,
      event: ReactPointerEvent<SVGElement>,
    ): void => {
      beginTransform("resize", handler, null, event);
    };

    const beginRotate = (
      corner: RotationCorner,
      event: ReactPointerEvent<SVGElement>,
    ): void => {
      beginTransform("rotate", null, corner, event);
    };

    // The overlay bridge of this closure (the effect re-runs per load).
    gestureRef.current = { beginResize, beginRotate };

    // Undo the transform bookkeeping without touching the wasm side.
    const stopTransformState = (): void => {
      transform.active = false;
      if (transform.rafId !== 0) {
        window.cancelAnimationFrame(transform.rafId);
        transform.rafId = 0;
      }
      transform.currentWorld = null;
    };

    // Leave the preview without a commit (Escape, pointercancel, a failed
    // request or a zero transform): drop the overrides, show the base
    // geometry again and clear the overlay preview. Idempotent per gesture.
    const cancelTransformPreview = (): void => {
      if (!transform.active) return;
      stopTransformState();
      const app = appRef.current;
      if (app !== null) resetModifierPreview(app);
      setTransformPreview(null);
    };

    // The release of a transform gesture (AD4): one pessimistic update-file
    // through the shared write path, then the JS model swap and the wasm
    // geometry handover. A zero matrix or an unchanged model sends nothing;
    // a failure resets the preview over the untouched base geometry.
    //
    // F9.10/F9.11: every shape of the gesture takes the matrix the renderer
    // answered with — the roots with the gesture matrix, a container's
    // children by their constraints and a layout frame's children by its
    // reflow. All of them ride one request.
    const commitTransform = async (
      roots: string[],
      matrix: Matrix6,
      rotation: number,
    ): Promise<void> => {
      const objects = objectsRef.current;
      if (objects === null || commitPendingRef.current) {
        cancelTransformPreview();
        return;
      }
      const entries = gestureSubtreeEntries(
        appRef.current,
        objects,
        roots,
        matrix,
        rotation,
        propagateEnabledRef.current,
      );
      const changes = buildTransformEntryChanges(objects, entries, pageIdRef.current);
      if (changes.length === 0) {
        cancelTransformPreview();
        return;
      }
      try {
        const revn = await sendUpdateFile(changes);
        if (revn === null) {
          cancelTransformPreview();
          return;
        }
        // The model swaps before the preview cleanup, in one task: the
        // canvas never renders between the preview and the committed
        // state (the same handover as the move commit).
        const next = applyTransformEntries(objects, entries);
        objectsRef.current = next;
        indexRef.current = createWorkspaceIndex(next);
        setWorkspaceObjects(next);
        stopTransformState();
        setTransformPreview(null);
        const pushApp = appRef.current;
        if (pushApp !== null) {
          // Leave the preview mode and drop the overrides, then rewrite the
          // whole committed record: set_object carries the rotation, the
          // transform and the flips a selrect-only push would lose. A wasm
          // failure never fails the committed file.
          try {
            endModifiers(pushApp);
            cleanModifiers(pushApp);
            const changed = new Set(changes.map((change) => change.id));
            const shapes: WorkspaceShape[] = [];
            for (const id of changed) {
              const shape = next[id];
              if (shape !== undefined && shape !== null) shapes.push(shape);
            }
            uploadShapeGeometry(pushApp, shapes);
          } catch (cause: unknown) {
            console.warn("[workspace] could not sync the transformed shapes to wasm:", cause);
          }
        }
      } catch (cause: unknown) {
        console.error("[workspace] transform commit failed:", cause);
        setWorkspaceState({ error: cause });
        cancelTransformPreview();
      }
    };

    // F9.7: one undo or redo step. Both directions send one pessimistic
    // update-file through the shared write path (never recorded again),
    // then apply the same changes locally, push them to wasm and move the
    // cursor. A failed request leaves the stack, the model and the
    // selection alone.
    const performHistory = async (direction: "undo" | "redo"): Promise<void> => {
      if (commitPendingRef.current) return;
      const step = direction === "undo" ? undoStep(undoRef.current) : redoStep(undoRef.current);
      if (step === null) return;
      const before = objectsRef.current;
      if (before === null) return;
      const changes = direction === "undo" ? step.entry.undoChanges : step.entry.changes;
      if (changes.length === 0) return;
      const selectionBeforeStep = [...getWorkspaceState().selection];
      try {
        const revn = await sendUpdateFile(changes, false);
        if (revn === null) return;
        const after = applyUpdateChanges(before, changes);
        objectsRef.current = after;
        indexRef.current = createWorkspaceIndex(after);
        setWorkspaceObjects(after);
        // The wasm handover: the parents whose children changed, then the
        // shapes that still exist. A wasm failure never fails the commit.
        const app = appRef.current;
        if (app !== null) {
          try {
            uploadChangedShapes(app, before, after, changes);
          } catch (cause: unknown) {
            console.warn("[workspace] could not sync the history step to wasm:", cause);
          }
        }
        // Undo returns to the selection before the commit; redo returns to
        // the selection the user had when undoing. Ids that no longer
        // exist are dropped.
        const selection =
          direction === "undo" ? step.entry.selectionBefore : step.entry.selectionAfter;
        if (direction === "undo") step.entry.selectionAfter = selectionBeforeStep;
        undoRef.current = step.state;
        setSelection(selection.filter((id) => after[id] !== undefined && after[id] !== null));
        // The hover stack may name a shape the step just deleted.
        setHover(null);
        setHoverShapeId(null);
        setHoverTopFrameId(null);
        setUndoAvailability(canUndo(undoRef.current), canRedo(undoRef.current));
      } catch (cause: unknown) {
        console.error(`[workspace] ${direction} failed:`, cause);
        setWorkspaceState({ error: cause });
      }
    };

    const performUndo = (): void => {
      void performHistory("undo");
    };

    const performRedo = (): void => {
      void performHistory("redo");
    };

    historyRef.current = { undo: performUndo, redo: performRedo };

    // F9.8: one vertical-order command over the current selection. The
    // change list is built from the model snapshot, sent through the shared
    // write path (one undo entry, inverted from the same snapshot), then
    // applied locally and pushed to wasm like a history step. The selection
    // and the hover stay untouched: every shape survives the command.
    const performOrder = async (location: VerticalOrderLocation): Promise<void> => {
      if (commitPendingRef.current || !canEditRef.current) return;
      const objects = objectsRef.current;
      if (objects === null) return;
      const changes = buildVerticalOrderChanges(
        objects,
        getWorkspaceState().selection,
        location,
        pageIdRef.current,
      );
      if (changes.length === 0) return;
      try {
        const revn = await sendUpdateFile(changes);
        if (revn === null) return;
        const after = applyUpdateChanges(objects, changes);
        objectsRef.current = after;
        indexRef.current = createWorkspaceIndex(after);
        setWorkspaceObjects(after);
        const app = appRef.current;
        if (app !== null) {
          try {
            uploadChangedShapes(app, objects, after, changes);
          } catch (cause: unknown) {
            console.warn("[workspace] could not sync the z-order change to wasm:", cause);
          }
        }
      } catch (cause: unknown) {
        console.error("[workspace] z-order command failed:", cause);
        setWorkspaceState({ error: cause });
      }
    };

    orderRef.current = (location) => {
      void performOrder(location);
    };

    // The threshold crossing of a pending press (AD3): commit the branch
    // the press decided — a single/toggle press updates the selection
    // first — then resolve the move set over the JS model and enter the
    // wasm preview.
    const startDrag = (world: ViewportPoint): void => {
      const app = appRef.current;
      const objects = objectsRef.current;
      const id = interaction.clickId;
      if (id === null) return;
      if (app === null || objects === null || !dragEnabledRef.current || !canEditRef.current) {
        // The preview ABI is unavailable — or the file is read-only: keep
        // the F9.2 semantics (the release selects nothing).
        interaction.moved = true;
        return;
      }
      interaction.selectionBeforeDrag = getWorkspaceState().selection;
      if (interaction.dragBranch === "single") setSelection([id]);
      else if (interaction.dragBranch === "toggle") toggleSelection(id, true);
      const moveSet = resolveMoveSet(getWorkspaceState().selection, objects);
      if (moveSet.length === 0) {
        // A shift press over the only selected shape toggles it out.
        interaction.moved = true;
        return;
      }
      interaction.mode = "drag";
      interaction.dragIds = moveSet;
      // The hover visuals belong to the idle state.
      hoverActive = false;
      setHover(null);
      setHoverShapeId(null);
      drag.active = true;
      drag.currentWorld = world;
      startModifiers(app);
      drag.rafId = window.requestAnimationFrame(flushDrag);
      updateCursor();
    };

    // Undo the drag bookkeeping without touching the wasm side: stop the
    // pending flush and drop the gesture references.
    const stopDragState = (): void => {
      drag.active = false;
      if (drag.rafId !== 0) {
        window.cancelAnimationFrame(drag.rafId);
        drag.rafId = 0;
      }
      drag.currentWorld = null;
    };

    // Leave the preview without a commit: drop the modifier overrides,
    // show the base geometry again and clear the overlay offset. Idempotent
    // per gesture. The commit success path instead hands the geometry over
    // through commitShapeGeometry (T5, AD7) and stops the state directly.
    const cancelDragPreview = (): void => {
      if (!drag.active) return;
      stopDragState();
      const app = appRef.current;
      if (app !== null) resetModifierPreview(app);
      setDragDelta(null);
    };

    // AD5/AD9: the release of a live drag persists one pessimistic
    // update-file — a cancelled gesture or a collapsed delta sends
    // nothing; commitMove settles the preview on every path. T5 adds the
    // post-commit handover on success:
    // - the JS model is replaced in place (the move application, then the
    //   mov-objects mirror over the ids the change carried) and the
    //   store/overlay follow the same reference (AD9/AD10);
    // - the preview hands over through commitShapeGeometry: end modifiers,
    //   clean the overrides, push every moved shape's new selrect (path
    //   content included) and request one full render, all in the task
    //   that handled the response — no intermediate frame shows the base
    //   geometry (AD7);
    // - a failure resets the preview over the untouched base geometry and
    //   leaves the model, the selection and the revn alone, reporting
    //   through the console and the store error channel (AD9).
    //
    // T4/AD8: the drop target resolves over the JS model — the wasm-side
    // cljs snapshot freezes at load and goes stale after the first commit
    // (the F9.2 KEY.topNestedFrame would misjudge the moved frames). The
    // frames of the live move are excluded (a frame never reparents into
    // itself), and the mov-objects change follows the companion mod-obj
    // list of generate-relocate in the same request (AD5).
    //
    // F9.3 companions: hide-in-viewer, layout-item cleanup,
    // component-root, flex sizing) come from buildRelocateChanges; the
    // same list decides the wasm handover below, because a reparent also
    // changes the tree, not just the geometry.
    //
    // F9.3 drop-index: a flex target turns the release point into the
    // insertion slot of the mov-objects change (lib/workspace-drop), which
    // also re-orders a drop inside the same flex parent. A non-flex target
    // keeps the tail append.
    const commitMove = async (
      ids: string[],
      dx: number,
      dy: number,
      releaseWorld: { x: number; y: number },
    ): Promise<void> => {
      const objects = objectsRef.current;
      if (objects === null || commitPendingRef.current) {
        cancelDragPreview();
        return;
      }
      const excluded = new Set<string>();
      for (const id of ids) {
        if (isFrameShape(objects[id] ?? null)) excluded.add(id);
      }
      const targetFrameId = topNestedFrameAt(objects, releaseWorld, excluded);
      const dropIndex = dropIndexForFrame(objects, targetFrameId, releaseWorld);
      const changes: UpdateFileChange[] = buildMoveChanges(objects, ids, dx, dy, pageIdRef.current);
      const relocate = buildRelocateChanges(
        objects,
        getWorkspaceState().selection,
        targetFrameId,
        pageIdRef.current,
        dropIndex,
      );
      changes.push(...relocate);
      if (changes.length === 0) {
        cancelDragPreview();
        return;
      }
      try {
        // AD6: the shared write path owns the in-flight guard and the revn
        // advance; a null result means another commit slipped in first.
        const revn = await sendUpdateFile(changes);
        if (revn === null) {
          cancelDragPreview();
          return;
        }
        // T5: the model swap. The move applies over the whole drag set, the
        // relocate list (mov-objects included) over that result; the store
        // takes the same reference the refs hold (AD10).
        const moved = applyMove(objects, ids, dx, dy);
        const next = relocate.length === 0 ? moved : applyUpdateChanges(moved, relocate);
        objectsRef.current = next;
        indexRef.current = createWorkspaceIndex(next);
        setWorkspaceObjects(next);
        // The geometry handover (AD7): the same task as the model swap, so
        // the canvas never renders between the preview and the committed
        // state.
        stopDragState();
        setDragDelta(null);
        const pushApp = appRef.current;
        if (pushApp !== null) {
          // A wasm failure never fails the committed file.
          try {
            if (relocate.length === 0) {
              const entries: Array<readonly [GeometryShape, ShapeGeometry]> = [];
              for (const id of ids) {
                const shape = objects[id];
                if (shape === undefined || shape === null) continue;
                const geometry = movedGeometry(shape, dx, dy);
                if (geometry !== null) entries.push([shape, geometry]);
              }
              commitShapeGeometry(pushApp, entries);
            } else {
              // A reparent rewrites the tree (children lists, frame ids,
              // component-root): the selrect-only push cannot carry it, so
              // leave the preview, drop the overrides and upload every
              // shape the change list touches.
              endModifiers(pushApp);
              cleanModifiers(pushApp);
              uploadChangedShapes(pushApp, objects, next, changes);
            }
          } catch (cause: unknown) {
            console.warn("[workspace] could not sync the move to wasm:", cause);
          }
        }
      } catch (cause: unknown) {
        console.error("[workspace] move commit failed:", cause);
        setWorkspaceState({ error: cause });
        // AD9: nothing was applied — the base geometry is still in the
        // pool; the preview resets over it and the model stays untouched.
        cancelDragPreview();
      }
    };

    // The release of a draw gesture (F9.5, AD5/AD6): one add-obj through
    // the shared write path, then the JS model swap, the selection and the
    // incremental wasm upload. A missing parent aborts with a store error;
    // a failed or cancelled commit leaves the file untouched. Every exit
    // returns the tool to move (the CLJS clear-drawing), so a failed draw
    // never traps the pointer in a tool.
    //
    // F9.3 drop-index: a flex parent places the new shape at the slot of the
    // press point (the CLJS box/curve/line drawing passes the initial
    // position to get-drop-index); a non-flex parent appends at the tail.
    const commitDraw = async (
      tool: WorkspaceDrawTool,
      rect: DrawRect,
      parentId: string | null,
      origin: { x: number; y: number } | null,
    ): Promise<void> => {
      if (!canEditRef.current) {
        setDrawPreview(null);
        onToolChangeRef.current("move");
        return;
      }
      const objects = objectsRef.current;
      if (objects === null || parentId === null) {
        setWorkspaceState({
          error: new Error("workspace: cannot draw without a valid parent"),
        });
        setDrawPreview(null);
        onToolChangeRef.current("move");
        return;
      }
      const parent = objects[parentId];
      if (parent === undefined || parent === null) {
        setWorkspaceState({
          error: new Error("workspace: cannot draw without a valid parent"),
        });
        setDrawPreview(null);
        onToolChangeRef.current("move");
        return;
      }
      const shape = createDrawShape(tool, rect, parentId, crypto.randomUUID());
      const dropIndex =
        origin === null ? null : dropIndexForFrame(objects, parentId, origin);
      const change: UpdateFileChange = {
        type: "add-obj",
        id: shape.id,
        obj: shape,
        "page-id": pageIdRef.current,
        "frame-id": parentId,
        "parent-id": parentId,
        ...(dropIndex !== null ? { index: dropIndex } : {}),
      };
      try {
        const revn = await sendUpdateFile([change]);
        if (revn === null) {
          setDrawPreview(null);
          onToolChangeRef.current("move");
          return;
        }
        // The local mirror of the backend add-shape (AD10): insert into the
        // parent at the same slot, replace the shared model and rebuild the
        // hit-testing index (hidden/blocked affect the next queries).
        const next = applyAddShape(objects, shape, parentId, dropIndex ?? undefined);
        objectsRef.current = next;
        indexRef.current = createWorkspaceIndex(next);
        setWorkspaceObjects(next);
        setSelection([shape.id]);
        setDrawPreview(null);
        // AD5: the incremental wasm sync. A failure here never rolls back
        // the committed file; the next reload renders the shape.
        const app = appRef.current;
        if (app !== null) {
          try {
            const parentShape = next[parentId];
            uploadNewShape(app, shape, parentShape);
          } catch (cause: unknown) {
            console.warn("[workspace] could not sync the new shape to wasm:", cause);
          }
        }
      } catch (cause: unknown) {
        console.error("[workspace] draw commit failed:", cause);
        setWorkspaceState({ error: cause });
        setDrawPreview(null);
      }
      onToolChangeRef.current("move");
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
      // AD9: a commit in flight rejects new presses (simplified
      // concurrency; a queue may follow in a later slice).
      if (commitPendingRef.current) return;

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

      // A left press with a box tool starts the draw gesture (F9.5): the
      // parent resolves once, at press time, and no hover/selection logic
      // runs for this press.
      if (event.button === 0 && canEditRef.current && isDrawTool(toolRef.current)) {
        event.preventDefault();
        const drawWorld = toWorld(client, state);
        const target = firstValidParent(objects, topNestedFrameAt(objects, drawWorld));
        interaction.mode = "draw";
        interaction.pointerId = event.pointerId;
        interaction.downClient = client;
        interaction.downWorld = drawWorld;
        interaction.drawStart = drawWorld;
        interaction.drawParentId = target === null ? null : target.id;
        interaction.drawActive = false;
        interaction.drawRect = null;
        interaction.cancelled = false;
        // The hover visuals belong to the idle selection mode.
        hoverActive = false;
        setHover(null);
        setHoverShapeId(null);
        setDrawPreview(null);
        updateCursor();
        return;
      }

      // A left press refreshes the hover stack at the press point (the
      // CLJS reads the stack the last move left behind; recomputing keeps
      // the click correct without a preceding move).
      const world = toWorld(client, state);
      const hoverId = updateHoverAt(world);

      // (or (not id) mod?): the empty canvas and mod both start the
      // marquee; a hit shape records the pending click and its drag
      // branch (the CLJS starts move-selected here).
      if (hoverId === null || keys.mod) {
        startArea(event.pointerId, client, world);
        return;
      }
      interaction.mode = "click";
      interaction.pointerId = event.pointerId;
      interaction.downClient = client;
      interaction.downWorld = world;
      interaction.clickId = hoverId;
      interaction.moved = false;
      interaction.cancelled = false;
      // AD3: the press over the shape decides the drag branch; the
      // threshold crossing commits it.
      const selection = getWorkspaceState().selection;
      interaction.dragBranch = keys.shift
        ? "toggle"
        : selection.includes(hoverId)
          ? "group"
          : "single";
    };

    const onPointerMove = (event: PointerEvent): void => {
      const state = stateRef.current;
      if (state === null) return;

      if (interaction.mode === "idle") {
        // The hover visuals belong to selection mode: a draw tool shows the
        // crosshair and no hover outline until it returns to move.
        if (isDrawTool(toolRef.current)) return;
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

      if (interaction.mode === "draw") {
        if (interaction.cancelled) return;
        const origin = interaction.drawStart;
        const activeTool = toolRef.current;
        if (origin === null || !isDrawTool(activeTool)) return;
        const rect = drawRectFromPoints(origin, toWorld(client, state), state.zoom, {
          square: event.shiftKey,
          center: event.altKey,
        });
        const previous = interaction.drawRect;
        interaction.drawActive = rect !== null;
        interaction.drawRect = rect;
        const changed =
          rect === null
            ? previous !== null
            : previous === null ||
              previous.x !== rect.x ||
              previous.y !== rect.y ||
              previous.width !== rect.width ||
              previous.height !== rect.height;
        if (changed) {
          setDrawPreview(rect === null ? null : { tool: activeTool, ...rect });
        }
        return;
      }

      if (interaction.mode === "drag") {
        // One flush per frame; the flush reads the latest world point.
        if (interaction.cancelled) return;
        drag.currentWorld = toWorld(client, state);
        if (drag.rafId === 0) drag.rafId = window.requestAnimationFrame(flushDrag);
        return;
      }

      if (interaction.mode === "resize" || interaction.mode === "rotate") {
        // One flush per frame; the flush reads the latest world point and
        // the modifier keys this event reported.
        if (interaction.cancelled) return;
        transform.currentWorld = toWorld(client, state);
        transform.shift = event.shiftKey;
        transform.alt = event.altKey;
        transform.mod = isMacos() ? event.metaKey : event.ctrlKey;
        if (transform.rafId === 0) {
          transform.rafId = window.requestAnimationFrame(flushTransform);
        }
        return;
      }

      // The pending click: a drag past the threshold becomes the move
      // gesture (F9.3 AD3); inside the threshold the release selects.
      const down = interaction.downClient;
      if (down === null || interaction.moved) return;
      if (
        Math.abs(client.x - down.x) > CLICK_MOVE_THRESHOLD ||
        Math.abs(client.y - down.y) > CLICK_MOVE_THRESHOLD
      ) {
        startDrag(toWorld(client, state));
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
      interaction.dragBranch = null;
      interaction.dragIds = [];
      interaction.selectionBeforeDrag = null;
      interaction.drawStart = null;
      interaction.drawParentId = null;
      interaction.drawActive = false;
      interaction.drawRect = null;
      interaction.transformGesture = null;
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

      if (mode === "draw") {
        // The release commits one add-obj (F9.5): the last previewed box,
        // or the 100 x 100 click box when the threshold never crossed.
        const drawTool = toolRef.current;
        const start = interaction.downWorld;
        const parentId = interaction.drawParentId;
        const rect =
          interaction.drawActive && interaction.drawRect !== null
            ? interaction.drawRect
            : start === null
              ? null
              : clickDrawRect(start);
        endGesture();
        setDrawPreview(null);
        if (cancelled || rect === null || !isDrawTool(drawTool)) {
          onToolChangeRef.current("move");
          return;
        }
        void commitDraw(drawTool, rect, parentId, start);
        return;
      }

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

      if (mode === "drag") {
        // The release commits (AD5): the world delta against the press
        // anchor becomes one update-file request. A cancelled gesture
        // (Escape) or one that collapsed to zero sends nothing. The
        // selection update made at the threshold crossing stays. The
        // release point also anchors the T4 drop-target resolution.
        // commitMove settles the preview on every path (T5): the success
        // path hands the geometry over, every other exit resets it.
        const state = stateRef.current;
        const down = interaction.downWorld;
        let dx = 0;
        let dy = 0;
        let releaseWorld: { x: number; y: number } | null = null;
        if (!cancelled && down !== null && state !== null) {
          const world = toWorld({ x: event.clientX, y: event.clientY }, state);
          dx = world.x - down.x;
          dy = world.y - down.y;
          releaseWorld = world;
        }
        const ids = interaction.dragIds;
        endGesture();
        if (!cancelled && ids.length > 0 && releaseWorld !== null && (dx !== 0 || dy !== 0)) {
          void commitMove(ids, dx, dy, releaseWorld);
        } else {
          cancelDragPreview();
        }
        return;
      }

      if (mode === "resize" || mode === "rotate") {
        // The release commits once (AD4). The last flush uses the release
        // point, so a fast drag lands where the pointer is; a cancelled
        // gesture, a zero matrix or a collapsed model sends nothing.
        const state = stateRef.current;
        if (!cancelled && state !== null) {
          transform.currentWorld = toWorld({ x: event.clientX, y: event.clientY }, state);
          transform.shift = event.shiftKey;
          transform.alt = event.altKey;
          transform.mod = isMacos() ? event.metaKey : event.ctrlKey;
          flushTransform();
        }
        const gesture = interaction.transformGesture;
        const matrix = gesture === null ? null : gesture.matrix;
        const rotation = gesture === null ? 0 : gesture.rotation;
        const roots = gesture === null ? [] : gesture.roots;
        endGesture();
        if (!cancelled && matrix !== null && roots.length > 0 && !isIdentityMatrix(matrix)) {
          void commitTransform(roots, matrix, rotation);
        } else {
          cancelTransformPreview();
        }
        return;
      }

      endGesture();
    };

    const onPointerCancel = (event: PointerEvent): void => {
      if (interaction.pointerId !== event.pointerId) return;
      if (interaction.mode === "area") setAreaSelect(null);
      if (interaction.mode === "draw") {
        // A cancelled draw leaves the file untouched and returns the tool
        // to move; the preview goes with the gesture.
        setDrawPreview(null);
        onToolChangeRef.current("move");
      }
      if (interaction.mode === "drag") {
        // A physical cancellation leaves the state as if the press never
        // mutated it: the preview resets and the selection the threshold
        // crossing replaced comes back (Escape instead clears it, F9.2).
        cancelDragPreview();
        const before = interaction.selectionBeforeDrag;
        if (before !== null) setSelection(before);
      }
      if (interaction.mode === "resize" || interaction.mode === "rotate") {
        // A physical cancellation resets the preview; the selection never
        // changed during a transform gesture.
        cancelTransformPreview();
      }
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
    // release side effects and a pending click is swallowed; a running
    // drag resets its preview first (the CLJS :escape emits interrupt +
    // deselect-all, so the keydown handler still clears the selection).
    const cancelGesture = (): void => {
      if (interaction.mode === "area") {
        setAreaSelect(null);
        interaction.cancelled = true;
        return;
      }
      if (interaction.mode === "click") interaction.cancelled = true;
      if (interaction.mode === "draw") {
        // Escape aborts the draw now: no commit on the release, the preview
        // goes and the tool returns to move (the CLJS interrupt).
        setDrawPreview(null);
        interaction.cancelled = true;
        interaction.drawActive = false;
        interaction.drawRect = null;
        onToolChangeRef.current("move");
        updateCursor();
        return;
      }
      if (interaction.mode === "drag") {
        cancelDragPreview();
        interaction.cancelled = true;
      }
      if (interaction.mode === "resize" || interaction.mode === "rotate") {
        // Escape drops the preview now; the release that follows finds the
        // gesture cancelled and commits nothing (the keydown handler still
        // clears the selection, like the CLJS interrupt + deselect-all).
        cancelTransformPreview();
        interaction.cancelled = true;
        return;
      }
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
      // A running transform gesture follows the modifier keys without
      // waiting for the next pointer move (Shift/Alt/mod change the matrix).
      if (transform.active && interaction.cancelled === false) {
        transform.shift = event.shiftKey;
        transform.alt = event.altKey;
        transform.mod = keys.mod;
        if (transform.rafId === 0) {
          transform.rafId = window.requestAnimationFrame(flushTransform);
        }
      }
      // mod changes the hover stack (bottom-frames sort + the group
      // filter): refresh the outlines in place, like the CLJS mod-str
      // stream, so the hover follows without moving the cursor.
      if (keys.mod !== wasMod && lastHoverWorld !== null) scheduleHover(lastHoverWorld);
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (isFormTarget(event.target)) return;
      // F9.7: Ctrl/Cmd+Z undoes, Ctrl/Cmd+Shift+Z (or Ctrl+Y on Windows)
      // redoes. Only an idle canvas takes the shortcut: a running gesture
      // owns the pointer and its pending release.
      const mod = isMacos() ? event.metaKey : event.ctrlKey;
      if (mod && !event.altKey && !event.isComposing && interaction.mode === "idle") {
        const key = event.key.toLowerCase();
        const redo =
          (key === "z" && event.shiftKey) ||
          (!isMacos() && key === "y" && !event.shiftKey);
        if (key === "z" || redo) {
          event.preventDefault();
          if (redo) performRedo();
          else performUndo();
          return;
        }
        // F9.8: Ctrl/Cmd+arrow re-orders the selection; the Shift variants
        // jump to the top or the bottom (the CLJS bring-* shortcuts). A
        // read-only file keeps the handler quiet, like emit-when-no-readonly.
        if (event.key === "ArrowUp" || event.key === "ArrowDown") {
          if (!canEditRef.current) return;
          event.preventDefault();
          const location: VerticalOrderLocation =
            event.key === "ArrowUp"
              ? event.shiftKey
                ? "top"
                : "up"
              : event.shiftKey
                ? "bottom"
                : "down";
          void performOrder(location);
          return;
        }
      }
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
      // A drag interrupted by the unmount hands the wasm shapes back and
      // drops the overlay offset; the hover/marquee visuals are
      // canvas-local and go too (a StrictMode replay immediately rebuilds
      // the same closure).
      if (drag.active) cancelDragPreview();
      if (transform.active) cancelTransformPreview();
      gestureRef.current = null;
      historyRef.current = null;
      orderRef.current = null;
      setUndoAvailability(false, false);
      cursorRef.current = null;
      setHover(null);
      setHoverShapeId(null);
      setHoverTopFrameId(null);
      setAreaSelect(null);
      setDrawPreview(null);
    };
  }, [sendUpdateFile]);

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
      <WorkspaceViewportOverlay
        file={file}
        pageId={pageId}
        showFrameTitles={showFrameTitles}
        onResizeStart={handleResizeStart}
        onRotateStart={handleRotateStart}
      />
      {error !== null ? (
        <div className="pp-viewport-placeholder" title={error}>
          <span>{error}</span>
        </div>
      ) : null}
    </>
  );
}

// The page subscribes to the whole store, so a rename (which replaces
// state.file with a new object) re-renders the shell. The canvas must only
// reload when the resolved content changes: compare the fields the load
// effect reads and ignore the name, or a rename would tear down and
// reinitialize the wasm viewport.
export const WorkspaceWasmCanvas = memo(
  WorkspaceWasmCanvasImpl,
  (prev, next) =>
    prev.fileId === next.fileId &&
    prev.pageId === next.pageId &&
    prev.ref === next.ref &&
    prev.file.id === next.file.id &&
    prev.file.revn === next.file.revn &&
    prev.file.vern === next.file.vern &&
    prev.file.permissions === next.file.permissions &&
    prev.file.data === next.file.data &&
    prev.showFrameTitles === next.showFrameTitles &&
    prev.tool === next.tool &&
    prev.onToolChange === next.onToolChange,
);
