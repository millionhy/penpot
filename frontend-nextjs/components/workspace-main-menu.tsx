"use client";

// The workspace main menu (F9.4): the four groups of the CLJS menu (File,
// Edit, View, Help) rendered through DashboardMenu's drilldown. The CLJS
// side-by-side dropdown becomes a drilldown, as AD10 documents.
//
// Wired in this slice: rename (when the file is editable), back to the
// dashboard, select all (root children), deselect all, undo/redo through
// the canvas handle (F9.7), the four z-order commands of the selection
// (F9.8), the five zoom commands, hide UI, the artboard-name toggle and the
// help link. Export, version history, shortcuts and about stay disabled;
// menu shortcut labels are display only and no global handler is installed.
//
// The menu reads selection and objects from the store so its enabled
// states stay correct even if the shell is memoized later. The page keeps
// re-rendering at the store rate, but entries are memoized: a hover update
// does not rebuild the menu root.

import { useMemo, useSyncExternalStore, type RefObject } from "react";
import { useRouter } from "next/navigation";

import {
  DashboardMenu,
  type MenuAnchor,
  type MenuEntry,
} from "@/components/dashboard-menu";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import { commandToTooltip, isMacos, metaLabel } from "@/lib/shortcuts";
import { immediateChildren } from "@/lib/workspace";
import {
  clearSelection,
  getInitialWorkspaceState,
  getWorkspaceState,
  setSelection,
  subscribeWorkspace,
} from "@/lib/workspace-store";

const noop = (): void => undefined;

const HELP_CENTER_URL = "https://help.penpot.app";

export interface WorkspaceMainMenuProps {
  anchor: MenuAnchor;
  canEdit: boolean;
  showFrameTitles: boolean;
  onClose(): void;
  onRename(): void;
  onToggleHideUI(): void;
  onToggleFrameTitles(): void;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
}

export function WorkspaceMainMenu({
  anchor,
  canEdit,
  showFrameTitles,
  onClose,
  onRename,
  onToggleHideUI,
  onToggleFrameTitles,
  canvas,
}: WorkspaceMainMenuProps) {
  const router = useRouter();
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
  const macos = isMacos();

  const entries = useMemo<MenuEntry[]>(() => {
    // Select all selects the root children of the page, the documented
    // deviation from the CLJS select-all.
    const selectAll = (): void => {
      const objects = getWorkspaceState().objects ?? {};
      setSelection(immediateChildren(objects).map((shape) => shape.id));
    };

    return [
      {
        type: "submenu",
        id: "workspace-menu-file",
        label: tr("workspace.header.menu.option.file"),
        items: [
          {
            type: "item",
            id: "workspace-menu-rename",
            label: tr("labels.rename"),
            disabled: !canEdit,
            onSelect: onRename,
          },
          {
            type: "item",
            id: "workspace-menu-dashboard",
            label: tr("labels.dashboard"),
            onSelect: () => router.push("/dashboard/recent"),
          },
          { type: "separator", id: "workspace-menu-file-separator" },
          {
            type: "item",
            id: "workspace-menu-export",
            label: tr("labels.export"),
            disabled: true,
            onSelect: noop,
          },
          {
            type: "item",
            id: "workspace-menu-history",
            label: tr("dashboard.show-version-history"),
            disabled: true,
            onSelect: noop,
          },
        ],
      },
      {
        type: "submenu",
        id: "workspace-menu-edit",
        label: tr("workspace.header.menu.option.edit"),
        items: [
          {
            type: "item",
            id: "workspace-menu-select-all",
            label: tr("workspace.header.menu.select-all"),
            shortcut: metaLabel("A", macos),
            disabled: !hasShapes,
            onSelect: selectAll,
          },
          {
            type: "item",
            id: "workspace-menu-deselect-all",
            label: tr("shortcuts.deselect-all"),
            disabled: !hasSelection,
            onSelect: clearSelection,
          },
          { type: "separator", id: "workspace-menu-edit-separator" },
          {
            type: "item",
            id: "workspace-menu-undo",
            label: tr("workspace.header.menu.undo"),
            shortcut: metaLabel("Z", macos),
            disabled: !state.canUndo,
            onSelect: () => canvas.current?.undo(),
          },
          {
            type: "item",
            id: "workspace-menu-redo",
            label: tr("workspace.header.menu.redo"),
            shortcut: metaLabel("Shift+Z", macos),
            disabled: !state.canRedo,
            onSelect: () => canvas.current?.redo(),
          },
          { type: "separator", id: "workspace-menu-edit-order-separator" },
          {
            type: "item",
            id: "workspace-menu-forward",
            label: tr("workspace.shape.menu.forward"),
            shortcut: commandToTooltip("command+up", macos) ?? undefined,
            disabled: !canEdit || !hasSelection,
            onSelect: () => canvas.current?.orderSelection("up"),
          },
          {
            type: "item",
            id: "workspace-menu-front",
            label: tr("workspace.shape.menu.front"),
            shortcut: commandToTooltip("command+shift+up", macos) ?? undefined,
            disabled: !canEdit || !hasSelection,
            onSelect: () => canvas.current?.orderSelection("top"),
          },
          {
            type: "item",
            id: "workspace-menu-backward",
            label: tr("workspace.shape.menu.backward"),
            shortcut: commandToTooltip("command+down", macos) ?? undefined,
            disabled: !canEdit || !hasSelection,
            onSelect: () => canvas.current?.orderSelection("down"),
          },
          {
            type: "item",
            id: "workspace-menu-back",
            label: tr("workspace.shape.menu.back"),
            shortcut: commandToTooltip("command+shift+down", macos) ?? undefined,
            disabled: !canEdit || !hasSelection,
            onSelect: () => canvas.current?.orderSelection("bottom"),
          },
        ],
      },
      {
        type: "submenu",
        id: "workspace-menu-view",
        label: tr("workspace.header.menu.option.view"),
        items: [
          {
            type: "item",
            id: "workspace-menu-zoom-in",
            label: tr("shortcuts.increase-zoom"),
            onSelect: () => canvas.current?.zoomIn(),
          },
          {
            type: "item",
            id: "workspace-menu-zoom-out",
            label: tr("shortcuts.decrease-zoom"),
            onSelect: () => canvas.current?.zoomOut(),
          },
          {
            type: "item",
            id: "workspace-menu-reset-zoom",
            label: tr("workspace.header.reset-zoom"),
            onSelect: () => canvas.current?.resetZoom(),
          },
          { type: "separator", id: "workspace-menu-view-separator" },
          {
            type: "item",
            id: "workspace-menu-fit-all",
            label: tr("workspace.header.zoom-fit-all"),
            disabled: !hasShapes,
            onSelect: () => canvas.current?.zoomToFitAll(),
          },
          {
            type: "item",
            id: "workspace-menu-fit-selected",
            label: tr("workspace.header.zoom-selected"),
            disabled: !hasSelection,
            onSelect: () => canvas.current?.zoomToSelection(),
          },
          { type: "separator", id: "workspace-menu-view-separator-2" },
          {
            type: "item",
            id: "workspace-menu-hide-ui",
            label: tr("shortcuts.hide-ui"),
            shortcut: metaLabel("\\", macos),
            onSelect: onToggleHideUI,
          },
          {
            type: "item",
            id: "workspace-menu-frame-titles",
            label: showFrameTitles
              ? tr("workspace.header.menu.hide-artboard-names")
              : tr("workspace.header.menu.show-artboard-names"),
            onSelect: onToggleFrameTitles,
          },
        ],
      },
      {
        type: "submenu",
        id: "workspace-menu-help",
        label: tr("workspace.header.menu.option.help-info"),
        items: [
          {
            type: "item",
            id: "workspace-menu-help-center",
            label: tr("labels.help-center"),
            onSelect: () => {
              window.open(HELP_CENTER_URL, "_blank", "noopener,noreferrer");
            },
          },
          {
            type: "item",
            id: "workspace-menu-shortcuts",
            label: tr("label.shortcuts"),
            disabled: true,
            onSelect: noop,
          },
          {
            type: "item",
            id: "workspace-menu-about",
            label: tr("labels.about-penpot"),
            disabled: true,
            onSelect: noop,
          },
        ],
      },
    ];
  }, [
    canEdit,
    canvas,
    hasSelection,
    hasShapes,
    macos,
    onRename,
    onToggleFrameTitles,
    onToggleHideUI,
    router,
    showFrameTitles,
    state.canRedo,
    state.canUndo,
  ]);

  return (
    <DashboardMenu
      anchor={anchor}
      entries={entries}
      onClose={onClose}
      ariaLabel={tr("shortcuts.subsection.main-menu")}
    />
  );
}
