"use client";

// The workspace zoom widget (F9.4): the percentage button of the right
// sidebar header plus a compact -/+ pair. The percentage opens a drilldown
// menu with the five zoom commands; every command goes through the canvas
// handle, so the viewport math stays inside the canvas and the store write
// path stays the single applyViewport.
//
// The widget reads zoom, selection and objects from the store. The page
// already re-renders at the store rate, but the local subscription keeps
// the percentage correct if the shell is memoized later; the menu entries
// are memoized so a hover update does not rebuild them.
//
// The menu anchor is controlled by the shell: it shares one state with the
// main menu, so only one workspace menu is open at a time.

import { useMemo, useSyncExternalStore, type RefObject } from "react";

import {
  DashboardMenu,
  menuAnchorFromElement,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import { MinusIcon, PlusIcon } from "@/components/workspace-icons";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import { immediateChildren } from "@/lib/workspace";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

export interface WorkspaceZoomWidgetProps {
  canvas: RefObject<WorkspaceCanvasHandle | null>;
  menuAnchor: MenuAnchor | null;
  onMenuToggle(anchor: MenuAnchor | null): void;
}

export function WorkspaceZoomWidget({
  canvas,
  menuAnchor,
  onMenuToggle,
}: WorkspaceZoomWidgetProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  const hasShapes = useMemo(
    () => immediateChildren(state.objects ?? {}).length > 0,
    [state.objects],
  );
  const hasSelection = state.selection.length > 0;
  // fmt/format-percent with precision 0: the CLJS shows the integer percent.
  const percent = state.zoom === null ? "100%" : `${Math.round(state.zoom * 100)}%`;

  const entries = useMemo<MenuEntry[]>(
    () => [
      {
        type: "item",
        id: "workspace-zoom-in",
        label: tr("shortcuts.increase-zoom"),
        onSelect: () => canvas.current?.zoomIn(),
      },
      {
        type: "item",
        id: "workspace-zoom-out",
        label: tr("shortcuts.decrease-zoom"),
        onSelect: () => canvas.current?.zoomOut(),
      },
      {
        type: "item",
        id: "workspace-zoom-reset",
        label: tr("workspace.header.reset-zoom"),
        onSelect: () => canvas.current?.resetZoom(),
      },
      { type: "separator", id: "workspace-zoom-separator" },
      {
        type: "item",
        id: "workspace-zoom-fit-all",
        label: tr("workspace.header.zoom-fit-all"),
        disabled: !hasShapes,
        onSelect: () => canvas.current?.zoomToFitAll(),
      },
      {
        type: "item",
        id: "workspace-zoom-fit-selected",
        label: tr("workspace.header.zoom-selected"),
        disabled: !hasSelection,
        onSelect: () => canvas.current?.zoomToSelection(),
      },
    ],
    [canvas, hasSelection, hasShapes],
  );

  return (
    <>
      <div className="pp-workspace-zoom-widget">
        <button
          type="button"
          className="pp-workspace-zoom-button"
          title={tr("shortcuts.decrease-zoom")}
          aria-label={tr("shortcuts.decrease-zoom")}
          onClick={() => canvas.current?.zoomOut()}
        >
          <MinusIcon />
        </button>
        <button
          type="button"
          className="pp-workspace-zoom-value"
          title={tr("workspace.header.zoom")}
          aria-label={tr("workspace.header.zoom")}
          aria-haspopup="menu"
          aria-expanded={menuAnchor !== null}
          // Keep DashboardMenu's document mousedown listener from closing
          // the menu before this click toggles it.
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            const element = event.currentTarget;
            onMenuToggle(
              menuAnchor === null
                ? menuAnchorFromElement(element, "bottom-end")
                : null,
            );
          }}
        >
          {percent}
        </button>
        <button
          type="button"
          className="pp-workspace-zoom-button"
          title={tr("shortcuts.increase-zoom")}
          aria-label={tr("shortcuts.increase-zoom")}
          onClick={() => canvas.current?.zoomIn()}
        >
          <PlusIcon />
        </button>
      </div>

      {menuAnchor !== null ? (
        <DashboardMenu
          anchor={menuAnchor}
          entries={entries}
          onClose={() => onMenuToggle(null)}
          ariaLabel={tr("workspace.header.zoom")}
        />
      ) : null}
    </>
  );
}
