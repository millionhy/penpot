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
// live drag translation; page switching, history and the rest of
// workspace-local arrive with the next slices.

import type { WorkspaceFile, WorkspaceObjects } from "@/lib/workspace";
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
