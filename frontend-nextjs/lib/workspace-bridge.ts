// Workspace bridge for the plugin context (F7.4).
//
// The plugin proxies run outside React, while the live page model and every
// write path belong to the workspace canvas component (F9). The canvas
// registers its imperative commands here once it mounts, and the plugin
// context reads them through requireWorkspaceBridge. The reads fall back to
// the module store, so a context built before the canvas mounts still answers
// the file, the page and the persisted model.
//
// Registered deviations from the CLJS:
//   - this registry is the seam the CLJS does not need: its proxies emit
//     events into the global potok store, which every workspace effect
//     watches. The rewrite canvas owns its model and undo stack, so a plugin
//     write has to reach it through these commands.

import type { AlignAxis, DistributeAxis } from "@/lib/workspace-align";
import type { GeometryTarget } from "@/lib/workspace-geometry";
import type { ShapeUpdate } from "@/lib/workspace-multi";
import type { ViewportRect } from "@/lib/workspace-viewport";
import { pageObjects, type WorkspaceFile, type WorkspaceObjects } from "@/lib/workspace";
import { getWorkspaceState } from "@/lib/workspace-store";

// The box a plugin-created shape covers. The CLJS create-shape builds the
// same 100x100 square at the page origin.
export interface PluginDrawBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface PluginViewportSnapshot {
  zoom: number;
  vbox: ViewportRect;
}

// The canvas commands the plugin proxies use. The canvas handle implements
// this interface and adds the shell-facing commands.
export interface WorkspaceBridge {
  // The live JS model of the open page, or null before the canvas loads.
  objects(): WorkspaceObjects | null;
  // One add-obj at the box, under the page root. The id comes from the
  // caller so the plugin proxy can answer before the commit lands (the CLJS
  // mints the id in uuid/next and returns the proxy at once).
  createShape(
    id: string,
    type: "frame" | "rect" | "ellipse",
    box: PluginDrawBox,
  ): Promise<boolean>;
  updateShapeAttrs(id: string, attrs: Record<string, unknown>): Promise<boolean>;
  updateShapesAttrs(updates: readonly ShapeUpdate[]): Promise<boolean>;
  updateShapeGeometry(id: string, target: GeometryTarget): Promise<boolean>;
  // The batch align / distribute of the plugin API: the ids come from the
  // caller, not from the store selection, and the commit is the same one
  // update-file call the style panel sends.
  alignObjects(ids: readonly string[], axis: AlignAxis): Promise<boolean>;
  distributeObjects(ids: readonly string[], axis: DistributeAxis): Promise<boolean>;
  undo(): void;
  redo(): void;
  // One plugin history block: every commit between the two calls becomes one
  // undo entry.
  beginUndoBlock(): void;
  endUndoBlock(): void;
  viewport(): PluginViewportSnapshot | null;
  setZoom(zoom: number): void;
  setCenter(center: { x: number; y: number }): void;
  zoomReset(): void;
  zoomToFitAll(): void;
  zoomIntoView(ids: readonly string[]): void;
  // The page actions of the plugin API. createPage mints the id when the
  // caller does not pass one.
  createPage(id?: string): Promise<string | null>;
  renamePage(id: string, name: string): Promise<boolean>;
  deletePage(id: string): Promise<boolean>;
}

let bridge: WorkspaceBridge | null = null;

// Called by the canvas on mount (and again after a page load rebuilds its
// commands); null unregisters.
export function registerWorkspaceBridge(next: WorkspaceBridge | null): void {
  bridge = next;
}

export function getWorkspaceBridge(): WorkspaceBridge | null {
  return bridge;
}

// The write proxies refuse to run without the editor instead of silently
// dropping the edit; the CLJS always has its workspace effects mounted.
export function requireWorkspaceBridge(name: string): WorkspaceBridge {
  if (bridge === null) {
    throw new Error(
      `[PENPOT PLUGIN] '${name}' needs the workspace editor, which is not open`,
    );
  }
  return bridge;
}

// The model the proxies read: the canvas slice once it loaded, then the
// store slice, then the persisted page (a context built between the file load
// and the canvas mount).
export function liveObjects(): WorkspaceObjects | null {
  const fromBridge = bridge?.objects() ?? null;
  if (fromBridge !== null) return fromBridge;
  const state = getWorkspaceState();
  if (state.objects !== null) return state.objects;
  if (state.file === null) return null;
  const objects = pageObjects(state.file, state.pageId);
  return Object.keys(objects).length === 0 ? null : objects;
}

export function liveFile(): WorkspaceFile | null {
  return getWorkspaceState().file;
}

export function livePageId(): string | null {
  return getWorkspaceState().pageId;
}
