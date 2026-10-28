"use client";

// The workspace shell (F9.4): the three-column grid of the CLJS workspace
// ("left-sidebar viewport right-sidebar", 318px / 1fr / 318px), the left
// header, the right sidebar and the WASM canvas in the viewport cell.
//
// UI state stays local (review correction to AD5): hideUI, the menu anchor,
// the artboard-name toggle and the active tool live here, not in the module
// store, which keeps only the file, page, viewport, objects, selection and
// draw-preview slice. The Layers panel owns its own query/expanded state;
// the canvas owns its viewport.
//
// The main menu and the zoom widget are mounted here so the menu actions
// cross the canvas handle boundary instead of reaching into the store's
// viewport slice. The View menu toggles hideUI and the artboard names
// through this component, and the toolbar of Task 7 sits inside the
// viewport cell.
//
// Deviations from the CLJS original, documented (AD10):
// - No sidebar resizer, no responsive collapse and no palette bar. The
//   manual left-sidebar collapse (:collapse-left-sidebar) is ported: the
//   whole left column folds into a floating expand button.
// - The right sidebar carries the zoom widget and the F9.5 style panel; the
//   rest of the options toolbox stays out of this slice.

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  menuAnchorFromElement,
  type MenuAnchor,
} from "@/components/dashboard-menu";
import {
  WorkspaceLeftHeader,
  type WorkspaceLeftHeaderHandle,
} from "@/components/workspace-left-header";
import { WorkspaceLayersPanel } from "@/components/workspace-layers-panel";
import { WorkspaceMainMenu } from "@/components/workspace-main-menu";
import { WorkspaceRightSidebar } from "@/components/workspace-right-sidebar";
import { WorkspaceStylePanel } from "@/components/workspace-style-panel";
import { WorkspaceTopToolbar } from "@/components/workspace-top-toolbar";
import {
  WorkspaceWasmCanvas,
  type WorkspaceCanvasHandle,
} from "@/components/workspace-wasm-canvas";
import { ExpandIcon, ChevronIcon } from "@/components/workspace-icons";
import { tr } from "@/lib/i18n";
import { registerWorkspacePageOpener } from "@/lib/workspace-navigation";
import { canEditFile, type WorkspaceFile, type WorkspaceTool } from "@/lib/workspace";

export interface WorkspaceShellProps {
  fileId: string;
  pageId: string;
  file: WorkspaceFile;
  // The project name above the file name (get-project); null until loaded.
  projectName: string | null;
}

// Only one workspace menu is open at a time: the main menu and the zoom
// dropdown share this state, so opening one closes the other.
type WorkspaceMenu =
  | { kind: "main"; anchor: MenuAnchor }
  | { kind: "zoom"; anchor: MenuAnchor };

export function WorkspaceShell({
  fileId,
  pageId,
  file,
  projectName,
}: WorkspaceShellProps) {
  const canEdit = canEditFile(file);
  const router = useRouter();

  const canvasRef = useRef<WorkspaceCanvasHandle | null>(null);
  const leftHeaderRef = useRef<WorkspaceLeftHeaderHandle | null>(null);
  const restoreRef = useRef<HTMLButtonElement | null>(null);
  // The focus effect runs on every hideUI change; this flag skips the
  // initial render so mounting the shell never steals focus.
  const wasHiddenRef = useRef(false);

  const [hideUI, setHideUI] = useState(false);
  // The manual left-sidebar collapse (dw/toggle-layout-flag
  // :collapse-left-sidebar): the column unmounts and a floating button
  // brings it back.
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [menu, setMenu] = useState<WorkspaceMenu | null>(null);
  // Artboard names stay off, like the CLJS show-artboard-names flag.
  const [showFrameTitles, setShowFrameTitles] = useState(false);
  // AD9: the shell owns the active tool; the canvas mirrors it and asks for
  // the move tool when a draw completes or aborts.
  const [activeTool, setActiveTool] = useState<WorkspaceTool>("move");

  // A read-only file cannot draw: drop any active tool back to move.
  useEffect(() => {
    if (!canEdit) setActiveTool("move");
  }, [canEdit]);

  const changeTool = useCallback((next: WorkspaceTool): void => {
    setActiveTool(next);
  }, []);

  const closeMenu = useCallback((): void => setMenu(null), []);

  const collapseLeft = useCallback((): void => {
    setMenu(null);
    setLeftCollapsed(true);
  }, []);

  const expandLeft = useCallback((): void => setLeftCollapsed(false), []);

  // select-page: the open page lives in ?page-id=, so a switch is a URL
  // replace on the same route; the route effect re-resolves the page
  // against the loaded file and the canvas reloads its model.
  const selectPage = useCallback(
    (id: string): void => {
      const params = new URLSearchParams(window.location.search);
      if (params.get("page-id") === id) return;
      params.set("page-id", id);
      router.replace(`${window.location.pathname}?${params.toString()}`, {
        scroll: false,
      });
    },
    [router],
  );

  // F7.4: the plugin page proxies switch pages through openWorkspacePage;
  // the shell owns the URL replace, so it registers the opener here.
  useEffect(() => {
    registerWorkspacePageOpener(selectPage);
    return () => registerWorkspacePageOpener(null);
  }, [selectPage]);

  const toggleUI = useCallback((): void => {
    setMenu(null);
    setHideUI((current) => !current);
  }, []);

  // Stable callbacks: the main menu memoizes its entries on their identity,
  // so a new callback per render would rebuild the menu root on every shell
  // update and reset the drilldown.
  const startRename = useCallback((): void => {
    leftHeaderRef.current?.startRename();
  }, []);

  const toggleFrameTitles = useCallback((): void => {
    setShowFrameTitles((current) => !current);
  }, []);

  const openMenu = useCallback((element: HTMLElement): void => {
    const anchor = menuAnchorFromElement(element);
    setMenu((current) =>
      current?.kind === "main" ? null : { kind: "main", anchor },
    );
  }, []);

  const toggleZoomMenu = useCallback((anchor: MenuAnchor | null): void => {
    setMenu((current) => {
      if (current?.kind === "zoom") return null;
      return anchor === null ? null : { kind: "zoom", anchor };
    });
  }, []);

  // Move focus with the chrome: the restore button while hidden, the menu
  // trigger when the chrome comes back.
  useEffect(() => {
    if (hideUI) {
      wasHiddenRef.current = true;
      restoreRef.current?.focus();
    } else if (wasHiddenRef.current) {
      wasHiddenRef.current = false;
      leftHeaderRef.current?.focusMenuButton();
    }
  }, [hideUI]);

  return (
    <div
      className={
        hideUI
          ? "pp-workspace-shell pp-workspace-shell--hidden-ui"
          : leftCollapsed
            ? "pp-workspace-shell pp-workspace-shell--left-collapsed"
            : "pp-workspace-shell"
      }
    >
      {hideUI || leftCollapsed ? null : (
        <aside className="pp-workspace-left">
          <WorkspaceLeftHeader
            ref={leftHeaderRef}
            file={file}
            projectName={projectName}
            canEdit={canEdit}
            menuOpen={menu?.kind === "main"}
            onMenuClick={openMenu}
          />
          <WorkspaceLayersPanel
            canEdit={canEdit}
            canvas={canvasRef}
            onCollapse={collapseLeft}
            onSelectPage={selectPage}
          />
        </aside>
      )}

      {hideUI || !leftCollapsed ? null : (
        <button
          type="button"
          className="pp-workspace-collapsed-button"
          title={tr("workspace.sidebar.expand")}
          aria-label={tr("workspace.sidebar.expand")}
          onClick={expandLeft}
        >
          <ChevronIcon />
        </button>
      )}

      <main className="pp-workspace-viewport">
        <WorkspaceWasmCanvas
          ref={canvasRef}
          fileId={fileId}
          pageId={pageId}
          file={file}
          showFrameTitles={showFrameTitles}
          tool={activeTool}
          onToolChange={changeTool}
        />
        {hideUI ? null : (
          <WorkspaceTopToolbar
            canEdit={canEdit}
            tool={activeTool}
            onToolChange={changeTool}
          />
        )}
      </main>

      {hideUI ? null : (
        <WorkspaceRightSidebar
          canEdit={canEdit}
          fileId={fileId}
          pageId={pageId}
          canvas={canvasRef}
          zoomMenuAnchor={menu?.kind === "zoom" ? menu.anchor : null}
          onZoomMenuToggle={toggleZoomMenu}
        >
          <WorkspaceStylePanel canEdit={canEdit} canvas={canvasRef} />
        </WorkspaceRightSidebar>
      )}

      {menu?.kind === "main" ? (
        <WorkspaceMainMenu
          anchor={menu.anchor}
          canEdit={canEdit}
          showFrameTitles={showFrameTitles}
          onClose={closeMenu}
          onRename={startRename}
          onToggleHideUI={toggleUI}
          onToggleFrameTitles={toggleFrameTitles}
          canvas={canvasRef}
        />
      ) : null}

      {hideUI ? (
        <button
          ref={restoreRef}
          type="button"
          className="pp-workspace-show-ui"
          title={tr("shortcuts.hide-ui")}
          aria-label={tr("shortcuts.hide-ui")}
          onClick={toggleUI}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              toggleUI();
            }
          }}
        >
          <ExpandIcon />
        </button>
      ) : null}
    </div>
  );
}
