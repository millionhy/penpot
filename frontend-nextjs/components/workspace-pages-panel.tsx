"use client";

// The workspace page panel (F9.13): the sitemap slice of the left sidebar,
// the port of app.main.ui.workspace.sidebar.sitemap.
//
// The list reads the file's :pages order and the open page from the module
// store; the actions cross the canvas handle (createPage / renamePage /
// deletePage), which commits one page change through the shared write path.
// The panel owns only its UI state: collapsed, the inline rename draft and
// the pending delete confirmation.
//
// Deviations from the CLJS original, documented:
// - No drag reorder, no separator pages, no context menu and no keyboard
//   page cycling: this slice lists, selects, creates, renames and deletes.
// - The delete confirmation is an inline row instead of the modal, so the
//   panel keeps no dependency on the modal layer.
// - The collapsed flag is component state, not the persisted
//   ::sitemap-collapsed of the CLJS.
// - A created page keeps its generated name; the CLJS opens the name editor
//   right after the create.

import {
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent as ReactKeyboardEvent,
  type RefObject,
} from "react";

import { ChevronIcon, PlusIcon, TrashIcon } from "@/components/workspace-icons";
import type { WorkspaceCanvasHandle } from "@/components/workspace-wasm-canvas";
import { tr } from "@/lib/i18n";
import {
  normalizePageName,
  pageInfos,
  validPageName,
  type WorkspacePageInfo,
} from "@/lib/workspace-pages";
import {
  getInitialWorkspaceState,
  getWorkspaceState,
  subscribeWorkspace,
} from "@/lib/workspace-store";

export interface WorkspacePagesPanelProps {
  canEdit: boolean;
  canvas: RefObject<WorkspaceCanvasHandle | null>;
  onSelectPage: (id: string) => void;
}

export function WorkspacePagesPanel({
  canEdit,
  canvas,
  onSelectPage,
}: WorkspacePagesPanelProps) {
  const state = useSyncExternalStore(
    subscribeWorkspace,
    getWorkspaceState,
    getInitialWorkspaceState,
  );

  const [collapsed, setCollapsed] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape asks the blur handler to drop the draft instead of committing.
  const cancelRenameRef = useRef(false);

  const pages = state.file === null ? [] : pageInfos(state.file);

  const selectPage = (id: string): void => {
    if (busy) return;
    setConfirmId(null);
    if (id !== state.pageId) onSelectPage(id);
  };

  const startRename = (page: WorkspacePageInfo): void => {
    if (!canEdit || busy) return;
    setConfirmId(null);
    setEditingId(page.id);
    setDraft(page.name);
  };

  // Enter blurs the input, so one path commits the draft; Escape sets the
  // cancel flag first. A blank or unchanged draft is dropped silently.
  const finishRename = async (id: string, value: string): Promise<void> => {
    const cancel = cancelRenameRef.current;
    cancelRenameRef.current = false;
    setEditingId(null);
    setDraft("");
    if (cancel) return;
    const next = normalizePageName(value);
    const page = pages.find((entry) => entry.id === id);
    if (page === undefined || !validPageName(next) || next === page.name) return;
    const handle = canvas.current;
    if (handle === null) return;
    setBusy(true);
    setError(null);
    const ok = await handle.renamePage(id, next);
    setBusy(false);
    if (!ok) setError(tr("errors.generic"));
  };

  const createPage = async (): Promise<void> => {
    const handle = canvas.current;
    if (handle === null || busy) return;
    setError(null);
    setConfirmId(null);
    setBusy(true);
    const id = await handle.createPage();
    setBusy(false);
    if (id === null) {
      setError(tr("errors.generic"));
      return;
    }
    onSelectPage(id);
  };

  const removePage = async (id: string): Promise<void> => {
    const handle = canvas.current;
    if (handle === null || busy) return;
    const previousPageId = state.pageId;
    setError(null);
    setBusy(true);
    const ok = await handle.deletePage(id);
    setBusy(false);
    setConfirmId(null);
    if (!ok) {
      setError(tr("errors.generic"));
      return;
    }
    // Deleting the open page moves it to the first remaining one inside the
    // canvas store write; follow that page in the URL.
    const nextPageId = getWorkspaceState().pageId;
    if (nextPageId !== null && nextPageId !== previousPageId) onSelectPage(nextPageId);
  };

  const onDraftKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault();
      event.currentTarget.blur();
    } else if (event.key === "Escape") {
      event.preventDefault();
      cancelRenameRef.current = true;
      event.currentTarget.blur();
    }
  };

  return (
    <section
      className="pp-workspace-pages"
      aria-label={tr("workspace.sidebar.sitemap")}
    >
      <div className="pp-workspace-pages-header">
        <button
          type="button"
          className={
            collapsed
              ? "pp-workspace-pages-toggle pp-workspace-pages-toggle--collapsed"
              : "pp-workspace-pages-toggle"
          }
          aria-expanded={!collapsed}
          aria-label={tr("workspace.sidebar.sitemap")}
          onClick={() => setCollapsed((current) => !current)}
        >
          <ChevronIcon />
        </button>
        <h2 className="pp-workspace-pages-title">
          {tr("workspace.sidebar.sitemap")}
        </h2>
        {canEdit ? (
          <button
            type="button"
            className="pp-workspace-pages-add"
            title={tr("workspace.sidebar.sitemap.add-page")}
            aria-label={tr("workspace.sidebar.sitemap.add-page")}
            disabled={busy}
            onClick={() => void createPage()}
          >
            <PlusIcon />
          </button>
        ) : null}
      </div>

      {collapsed ? null : (
        <div className="pp-workspace-pages-body">
          <ul className="pp-workspace-pages-list">
            {pages.map((page) => {
              const active = page.id === state.pageId;
              if (editingId === page.id) {
                return (
                  <li
                    key={page.id}
                    className="pp-workspace-page-item"
                    data-page-id={page.id}
                  >
                    <input
                      type="text"
                      className="pp-workspace-page-input"
                      value={draft}
                      autoFocus
                      aria-label={tr("workspace.sidebar.sitemap")}
                      onChange={(event) => setDraft(event.currentTarget.value)}
                      onKeyDown={(event) => onDraftKeyDown(event)}
                      onBlur={(event) =>
                        void finishRename(page.id, event.currentTarget.value)
                      }
                    />
                  </li>
                );
              }
              if (confirmId === page.id) {
                return (
                  <li
                    key={page.id}
                    className="pp-workspace-page-item pp-workspace-page-item--confirm"
                    data-page-id={page.id}
                  >
                    <div
                      className="pp-workspace-page-confirm"
                      role="alertdialog"
                      aria-label={tr("modals.delete-page.title")}
                    >
                      <p className="pp-workspace-page-confirm-body">
                        {tr("modals.delete-page.body")}
                      </p>
                      <div className="pp-workspace-page-confirm-actions">
                        <button
                          type="button"
                          className="pp-workspace-page-confirm-delete"
                          disabled={busy}
                          onClick={() => void removePage(page.id)}
                        >
                          {tr("labels.delete")}
                        </button>
                        <button
                          type="button"
                          className="pp-workspace-page-confirm-cancel"
                          onClick={() => setConfirmId(null)}
                        >
                          {tr("labels.cancel")}
                        </button>
                      </div>
                    </div>
                  </li>
                );
              }
              return (
                <li
                  key={page.id}
                  className="pp-workspace-page-item"
                  data-page-id={page.id}
                >
                  <button
                    type="button"
                    className={
                      active
                        ? "pp-workspace-page-name pp-workspace-page-name--active"
                        : "pp-workspace-page-name"
                    }
                    aria-current={active ? "page" : undefined}
                    title={page.name}
                    onClick={() => selectPage(page.id)}
                    onDoubleClick={() => startRename(page)}
                  >
                    {page.name}
                  </button>
                  {canEdit && pages.length > 1 ? (
                    <button
                      type="button"
                      className="pp-workspace-page-delete"
                      title={tr("modals.delete-page.title")}
                      aria-label={tr("modals.delete-page.title")}
                      disabled={busy}
                      onClick={() => {
                        setEditingId(null);
                        setConfirmId(page.id);
                      }}
                    >
                      <TrashIcon />
                    </button>
                  ) : null}
                </li>
              );
            })}
          </ul>
          {error === null ? null : (
            <p className="pp-workspace-pages-error" role="alert">
              {error}
            </p>
          )}
        </div>
      )}
    </section>
  );
}
