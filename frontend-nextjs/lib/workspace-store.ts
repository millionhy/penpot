// Workspace module store (F9.1): the mutable slice the /workspace route
// shares across its components.
//
// A module-level store rather than React context: the CLJS original keeps
// this state in the potok global atom, and the F7.4 plugin proxy will read
// it from outside React (:current-file-id, :current-page-id,
// :workspace-local...). The React binding is useSyncExternalStore in the
// route components.
//
// Only the read-only slice F9.1 needs lives here; page switching, history
// and the rest of workspace-local arrive with the next slices.

import type { WorkspaceFile } from "@/lib/workspace";
import type { ViewportRect, ViewportState } from "@/lib/workspace-viewport";

export type WorkspaceStatus = "idle" | "loading" | "ready" | "error";

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
