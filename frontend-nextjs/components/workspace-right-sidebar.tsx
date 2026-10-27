"use client";

// The workspace right sidebar (right_header.cljs right-header* plus the
// options tab switcher of sidebar/options.cljs): a 48px header with the
// presence pills, the zoom widget, the comments/history buttons and the
// share/viewer links, then the 36px 设计/原型/检查 tab nav, then the options
// area. The shell passes the active tab content as children; the prototype
// and inspect tabs are placeholders for now, so the design tab always
// carries the style panel.
//
// Deviations from the CLJS original, documented:
// - The presence list is a static copy of the two overlapping avatars
//   (active-sessions* needs the live team sessions stream).
// - The comments, history and share buttons render without their CLJS
//   behaviours (drawing tool, history panel, invite dialog); only the
//   viewer link navigates.

import { useState, type ReactNode, type RefObject } from "react";

import type { MenuAnchor } from "@/components/dashboard-menu";
import { CommentsIcon, HistoryIcon, PlayIcon, ShareIcon } from "@/components/workspace-icons";
import { WorkspaceZoomWidget } from "@/components/workspace-zoom-widget";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";

export interface WorkspaceRightSidebarProps {
  canEdit: boolean;
  fileId: string;
  pageId: string;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
  zoomMenuAnchor: MenuAnchor | null;
  onZoomMenuToggle(anchor: MenuAnchor | null): void;
  children?: ReactNode;
}

// presence.cljs active-sessions*: two sessions of the same user; the list
// overlaps the avatars by 4px, mirroring the CLJS markup.
const ACTIVE_USERS = [
  { id: "session-1", color: "#DEE563", name: "MichaelHu" },
  { id: "session-2", color: "#FAA6B7", name: "MichaelHu" },
] as const;

// options.cljs generate-options-tabs: the three right-sidebar modes. The
// keys sit in a labelKey field so scripts/extract-translations.mjs sees them
// (the same data-driven pattern as settingsNav in lib/settings.ts).
const OPTION_TABS = [
  { id: "design", labelKey: "workspace.options.design" },
  { id: "prototype", labelKey: "workspace.options.prototype" },
  { id: "inspect", labelKey: "workspace.options.inspect" },
] as const;

type OptionTabId = (typeof OPTION_TABS)[number]["id"];

export function WorkspaceRightSidebar({
  canEdit,
  fileId,
  pageId,
  canvas,
  zoomMenuAnchor,
  onZoomMenuToggle,
  children,
}: WorkspaceRightSidebarProps) {
  const [tab, setTab] = useState<OptionTabId>("design");

  // dcm/go-to-viewer with :section "interactions": the viewer route.
  const viewerHref = `/view?file-id=${encodeURIComponent(fileId)}&page-id=${encodeURIComponent(pageId)}`;

  return (
    <aside className="pp-workspace-right">
      <header className="pp-workspace-right-header">
        <div className="pp-workspace-users-section">
          <button
            type="button"
            className="pp-workspace-active-users"
            title={ACTIVE_USERS[0].name}
          >
            <ul className="pp-workspace-active-users-list">
              {ACTIVE_USERS.map((user) => (
                <li key={user.id} className="pp-workspace-active-user" title={user.name}>
                  <span
                    className="pp-workspace-active-user-initial"
                    style={{ backgroundColor: user.color }}
                    aria-hidden="true"
                  >
                    M
                  </span>
                </li>
              ))}
            </ul>
          </button>
        </div>

        <div className="pp-workspace-header-separator" role="separator" />

        <div className="pp-workspace-zoom-section">
          <WorkspaceZoomWidget
            canvas={canvas}
            menuAnchor={zoomMenuAnchor}
            onMenuToggle={onZoomMenuToggle}
          />
        </div>

        <div className="pp-workspace-comments-section">
          <button
            type="button"
            className="pp-workspace-header-button"
            title={tr("workspace.toolbar.comments")}
            aria-label={tr("workspace.toolbar.comments")}
          >
            <CommentsIcon />
          </button>
        </div>

        {canEdit ? (
          <div className="pp-workspace-history-section">
            <button
              type="button"
              className="pp-workspace-header-button"
              title={tr("workspace.sidebar.history")}
              aria-label={tr("workspace.sidebar.history")}
            >
              <HistoryIcon />
            </button>
          </div>
        ) : null}

        <button
          type="button"
          className="pp-workspace-viewer-btn"
          title={tr("workspace.header.share")}
          aria-label={tr("workspace.header.share")}
        >
          <ShareIcon />
        </button>

        <a
          className="pp-workspace-viewer-btn"
          title={tr("workspace.header.viewer")}
          aria-label={tr("workspace.header.viewer")}
          href={viewerHref}
        >
          <PlayIcon />
        </a>
      </header>

      <div className="pp-workspace-options-tabs-wrap">
        <nav className="pp-workspace-options-tabs">
          <ul className="pp-workspace-options-tabs-list">
            {OPTION_TABS.map((item) => (
              <li key={item.id} className="pp-workspace-options-tabs-item">
                <button
                  type="button"
                  role="tab"
                  className={
                    tab === item.id
                      ? "pp-workspace-option-tab pp-workspace-option-tab--selected"
                      : "pp-workspace-option-tab"
                  }
                  aria-selected={tab === item.id}
                  onClick={() => setTab(item.id)}
                >
                  <span className="pp-workspace-option-tab-text">{tr(item.labelKey)}</span>
                </button>
              </li>
            ))}
          </ul>
        </nav>
      </div>

      <div className="pp-workspace-right-options">
        {tab === "design" ? children : <p className="pp-workspace-empty">{tr("labels.empty")}</p>}
      </div>
    </aside>
  );
}
