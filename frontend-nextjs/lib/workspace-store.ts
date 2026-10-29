// Workspace module store (F9.1): the mutable slice the /workspace route
// shares across its components.
//
// A module-level store rather than React context: the CLJS original keeps
// this state in the potok global atom, and the F7.4 plugin proxy will read
// it from outside React (:current-file-id, :current-page-id,
// :workspace-local...). The React binding is useSyncExternalStore in the
// route components.
//
// Only the read-only slice F9.1 needs lives here; F9.2 adds the
// selection/hover/area slice; F9.3 adds the JS model reference and the
// live drag translation; F9.5 the draw preview; F9.6 the transform
// preview; F9.7 the undo availability flags. F9.13 switches pages by
// swapping pageId (the route and the canvas follow it); the rest of
// workspace-local arrives with the next slices.

import type { WorkspaceDrawTool, WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";
import type { DrawPoint } from "@/lib/workspace-draw";
import { orderedUnique, selectionAfterClick } from "@/lib/workspace-selection";
import type { ViewportRect, ViewportState } from "@/lib/workspace-viewport";

export type WorkspaceStatus = "idle" | "loading" | "ready" | "error";

// The live translation of a move drag, in world units (F9.3): the canvas
// writes it on every preview frame and the overlay shifts the selection
// visuals by it while the wasm modifiers move the shapes themselves.
export interface DragDelta {
  dx: number;
  dy: number;
}

// The live box of a draw gesture, in world units (F9.5): the canvas writes
// it on every passing pointer move and the overlay renders the dashed
// preview; null between drags and under the 10-screen-pixel threshold.
export interface DrawPreview {
  tool: WorkspaceDrawTool;
  x: number;
  y: number;
  width: number;
  height: number;
}

// The live point stream of a curve drag (F9.5, the freehand tool), in world
// units: the canvas appends on every passing pointer move and the overlay
// draws the polyline; null between strokes.
export interface CurvePreview {
  points: DrawPoint[];
}

// The live world matrix of a resize/rotate gesture (F9.6), in the transit
// {a..f} form: the canvas writes it on every preview frame and the overlay
// maps the selection outlines, the bounds and the handles by it; null when
// no transform gesture runs.
export interface TransformPreview {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface WorkspaceState {
  status: WorkspaceStatus;
  // The ?file-id= of the route; stays set while the file loads.
  fileId: string | null;
  file: WorkspaceFile | null;
  // The open page: the ?page-id= resolved against the file, with the first
  // page of the file as the fallback.
  pageId: string | null;
  // The failure the file load rejected with; unknown until narrowed, since
  // lib/exception-page branches on the RpcError causes it maps to the
  // exception page.
  error: unknown;
  // The workspace-local viewport slice; null until the canvas reports its
  // first size and fit.
  zoom: number | null;
  vbox: ViewportRect | null;
  vport: { width: number; height: number } | null;
  // The current selection as an ordered set of ids (F9.2).
  selection: string[];
  // The hover stack under the cursor (front-most first, already filtered);
  // null when the cursor is not over anything.
  hover: string[] | null;
  // The top-most nested frame under the cursor (the caller debounces the
  // updates, like the CLJS 50ms stream).
  hoverTopFrameId: string | null;
  // The single hover shape the outline overlay draws (the CLJS :id @hover):
  // the first id of the stack that survives the remove-hover? / mod filters
  // (hoverShapeId of lib/workspace-selection); null when nothing drawable is
  // under the cursor.
  hoverShapeId: string | null;
  // The live marquee rectangle in world coordinates while area-selecting.
  areaSelect: ViewportRect | null;
  // The current JS-side page objects (the interaction model): filled by
  // the canvas load effect and replaced after every committed change;
  // null until the first load (the overlay falls back to the file prop).
  objects: WorkspaceObjects | null;
  // The translation of a running move drag; null when no drag runs.
  dragDelta: DragDelta | null;
  // The live box of a running draw gesture (F9.5); null otherwise.
  drawPreview: DrawPreview | null;
  // The live points of a running freehand stroke; null otherwise.
  curvePreview: CurvePreview | null;
  // The live world matrix of a running resize/rotate gesture (F9.6); null
  // otherwise.
  transformPreview: TransformPreview | null;
  // The undo/redo availability of the page load (F9.7): the canvas owns the
  // stack and mirrors its cursor here for the menu and its disabled states.
  canUndo: boolean;
  canRedo: boolean;
}

const initialState: WorkspaceState = {
  status: "idle",
  fileId: null,
  file: null,
  pageId: null,
  error: null,
  zoom: null,
  vbox: null,
  vport: null,
  selection: [],
  hover: null,
  hoverTopFrameId: null,
  hoverShapeId: null,
  areaSelect: null,
  objects: null,
  dragDelta: null,
  drawPreview: null,
  curvePreview: null,
  transformPreview: null,
  canUndo: false,
  canRedo: false,
};

let state: WorkspaceState = initialState;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

// getServerSnapshot for useSyncExternalStore: the hydration render must
// match the server one.
export function getInitialWorkspaceState(): WorkspaceState {
  return initialState;
}

export function getWorkspaceState(): WorkspaceState {
  return state;
}

export function setWorkspaceState(patch: Partial<WorkspaceState>): void {
  state = { ...state, ...patch };
  notify();
}

export function subscribeWorkspace(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

// finalize-workspace: drop the file slice, so a later mount starts clean
// (and vitest can reset between cases).
export function resetWorkspaceState(): void {
  state = { ...initialState };
  notify();
}

// The viewport slice as the math module's state, or null before the first
// canvas fit.
export function getWorkspaceViewport(): ViewportState | null {
  if (state.zoom === null || state.vbox === null || state.vport === null) return null;
  return { zoom: state.zoom, vbox: state.vbox, vport: state.vport };
}

// Write the viewport slice back in one shot.
export function setWorkspaceViewport(viewport: ViewportState): void {
  setWorkspaceState({ zoom: viewport.zoom, vbox: viewport.vbox, vport: viewport.vport });
}

// --- Selection, hover and area (F9.2) ---------------------------------------

// select-shapes: replace the whole selection (ordered set, duplicates
// dropped).
export function setSelection(ids: readonly string[]): void {
  setWorkspaceState({ selection: orderedUnique(ids) });
}

// select-shape: a plain call replaces the selection with the shape; the
// toggle variant (shift-click) adds or removes it keeping the order.
export function toggleSelection(id: string, toggle = false): void {
  setWorkspaceState({
    selection: selectionAfterClick(getWorkspaceState().selection, id, toggle),
  });
}

// deselect-all.
export function clearSelection(): void {
  setWorkspaceState({ selection: [] });
}

// The hover stack (front-most first); an empty stack normalizes to null,
// the "nothing under the cursor" state.
export function setHover(ids: readonly string[] | null): void {
  setWorkspaceState({ hover: ids === null || ids.length === 0 ? null : [...ids] });
}

export function setHoverTopFrameId(id: string | null): void {
  setWorkspaceState({ hoverTopFrameId: id });
}

// The hover outline follows the single hover shape, not the whole stack.
export function setHoverShapeId(id: string | null): void {
  setWorkspaceState({ hoverShapeId: id });
}

// The marquee rectangle while dragging (world coordinates); null when no
// area selection is running.
export function setAreaSelect(rect: ViewportRect | null): void {
  setWorkspaceState({ areaSelect: rect });
}

// --- Move model and drag preview (F9.3) --------------------------------------

// The JS-side model slice: the canvas fills it on load and replaces it
// after a successful commit; the overlay draws from it.
export function setWorkspaceObjects(objects: WorkspaceObjects | null): void {
  setWorkspaceState({ objects });
}

// The live drag translation the overlay offsets the selection visuals by;
// null between drags.
export function setDragDelta(delta: DragDelta | null): void {
  setWorkspaceState({ dragDelta: delta });
}

// --- Draw preview (F9.5) ----------------------------------------------------

// The dashed box the overlay draws while a draw tool is dragging; null clears
// it (under the threshold, after the release and on every abort).
export function setDrawPreview(preview: DrawPreview | null): void {
  setWorkspaceState({ drawPreview: preview });
}

// The live freehand stroke the overlay draws while a curve gesture runs;
// null clears it (release, cancel and on every abort).
export function setCurvePreview(preview: CurvePreview | null): void {
  setWorkspaceState({ curvePreview: preview });
}

// --- Transform preview (F9.6) -----------------------------------------------

// The live matrix of a running resize/rotate gesture; null clears it on
// release, Escape and pointercancel.
export function setTransformPreview(preview: TransformPreview | null): void {
  setWorkspaceState({ transformPreview: preview });
}

// --- Undo availability (F9.7) -----------------------------------------------

// Mirror the undo/redo cursor of the canvas stack into the store, so the
// main menu rebuilds its disabled states without reading the canvas ref.
export function setUndoAvailability(canUndoValue: boolean, canRedoValue: boolean): void {
  if (state.canUndo === canUndoValue && state.canRedo === canRedoValue) return;
  setWorkspaceState({ canUndo: canUndoValue, canRedo: canRedoValue });
}
