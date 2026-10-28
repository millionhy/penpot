// Page navigation seam for the plugin API (F7.4).
//
// The CLJS page proxy opens a page with go-to-workspace, which rewrites the
// URL and lets the workspace reload its model. The rewrite keeps the open page
// in ?page-id= too, and the /workspace route reads it through the App Router,
// so the only component that can navigate is the shell that owns the router.
// It registers its replace there; a caller before the shell mounts (or in
// vitest) falls back to the store write, which still switches the canvas.

import { getWorkspaceState, setWorkspaceState } from "@/lib/workspace-store";

type PageOpener = (pageId: string) => void;

let opener: PageOpener | null = null;

export function registerWorkspacePageOpener(next: PageOpener | null): void {
  opener = next;
}

// openPage: a page the file does not carry is refused by the caller before
// this runs.
export function openWorkspacePage(pageId: string): void {
  if (getWorkspaceState().pageId === pageId) return;
  if (opener !== null) {
    opener(pageId);
    return;
  }
  setWorkspaceState({ pageId });
}
