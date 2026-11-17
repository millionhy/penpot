"use client";

// The share dialog of the viewer (F6.6): the port of
// app.main.ui.viewer.share-link. The dialog docks under the header like the
// CLJS modal (absolute, top 52 / right 12, 500px wide), so it never covers the
// sitemap and the zoom widget can stay in reach.
//
// Deviations from the CLJS original, documented:
// - The delete step matches the link of the current draft and deletes that
//   id. The CLJS seeks by :flags, a key the options map never carries, so it
//   deletes the first link of the file (see lib/viewer-share-links).
// - The page rows are plain checkboxes; the CLJS wraps them in labels with a
//   custom tick, the shell keeps the tick in the row and a visually hidden
//   input, which keeps the same look without its global/checked mixin.
// - Escape closes the dialog (the CLJS modal has the close button only).

import { useEffect, useState } from "react";

import { useNotifications } from "@/components/notifications";
import { ArrowIcon, ClipboardIcon, CloseIcon, StatusTickIcon } from "@/components/viewer-icons";
import { tr } from "@/lib/i18n";
import type { ViewerHrefParams } from "@/lib/viewer";
import {
  findShareLink,
  initialShareLinkDraft,
  isEveryPageSelected,
  shareLinkHref,
  toggleEveryPage,
  toggleSharePage,
  type ShareLink,
  type ShareLinkDraft,
} from "@/lib/viewer-share-links";

export interface SharePage {
  id: string;
  name: string;
}

export interface ViewerShareModalProps {
  // The page the viewer shows: the single-page row and the "current" mark.
  pageId: string;
  pages: SharePage[];
  links: ShareLink[];
  // The current viewer params, the base of the link href.
  query: ViewerHrefParams;
  zoomType: string | null;
  onClose: () => void;
  // create-share-link: the RPC answer (the shell appends it to `links`); null
  // when the call failed.
  onCreate: (params: {
    pages: string[];
    whoComment: string;
    whoInspect: string;
  }) => Promise<ShareLink | null>;
  // delete-share-link: false when the call failed.
  onDelete: (id: string) => Promise<boolean>;
}

// The two policy selects of the dialog.
const ACCESS_OPTIONS = [
  { value: "team", labelKey: "common.share-link.team-members" },
  { value: "all", labelKey: "common.share-link.all-users" },
] as const;

export function ViewerShareModal({
  pageId,
  pages,
  links,
  query,
  zoomType,
  onClose,
  onCreate,
  onDelete,
}: ViewerShareModalProps) {
  const notifications = useNotifications();
  const [draft, setDraft] = useState<ShareLinkDraft>(() => initialShareLinkDraft(pageId));
  const [permsVisible, setPermsVisible] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);

  // The dialog sits inside the viewer header flow, not in a focus trap: the
  // Escape listener lives on the window while the dialog is open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const currentLink = findShareLink(links, draft);
  const href =
    currentLink !== null
      ? shareLinkHref(currentLink, query, pages.map((page) => page.id), zoomType)
      : null;
  const everyPage = isEveryPageSelected(draft, pages.map((page) => page.id));

  // Every pick clears the pending confirmation, like the CLJS handlers.
  const update = (next: ShareLinkDraft) => {
    setConfirm(false);
    setDraft(next);
  };

  const copyLink = async () => {
    if (href === null) return;
    try {
      await navigator.clipboard.writeText(href);
      notifications.info(tr("common.share-link.link-copied-success"), 1000);
    } catch {
      notifications.error(tr("errors.generic"));
    }
  };

  const createLink = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const created = await onCreate({
        pages: [...draft.pages],
        whoComment: draft.whoComment,
        whoInspect: draft.whoInspect,
      });
      if (created === null) notifications.error(tr("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const deleteLink = async () => {
    if (busy || currentLink === null) return;
    setBusy(true);
    try {
      const removed = await onDelete(currentLink.id);
      setConfirm(false);
      if (!removed) notifications.error(tr("errors.generic"));
    } finally {
      setBusy(false);
    }
  };

  const currentPageName = pages.find((page) => page.id === pageId)?.name ?? "";

  return (
    <div className="pp-share-modal" data-testid="viewer-share-modal">
      <div className="pp-share-dialog">
        <div className="pp-share-header">
          <h2 className="pp-modal-title">{tr("common.share-link.title")}</h2>
          <button
            type="button"
            className="pp-modal-close"
            title={tr("labels.close")}
            aria-label={tr("labels.close")}
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        <div className="pp-share-content">
          <div className="pp-share-section">
            {!confirm && href !== null ? (
              <div className="pp-share-input-wrapper">
                <input
                  className="pp-share-input"
                  type="text"
                  readOnly
                  value={href}
                  placeholder={tr("common.share-link.placeholder")}
                  aria-label={tr("common.share-link.title")}
                />
                <button
                  type="button"
                  className="pp-btn-secondary pp-share-copy"
                  title={tr("viewer.header.share.copy-link")}
                  aria-label={tr("viewer.header.share.copy-link")}
                  onClick={() => void copyLink()}
                >
                  <ClipboardIcon />
                </button>
              </div>
            ) : null}

            <div className="pp-share-hint-wrapper">
              {!confirm ? (
                <div className="pp-share-hint">{tr("common.share-link.permissions-hint")}</div>
              ) : null}
              {confirm ? (
                <div className="pp-share-confirm">
                  <div className="pp-share-confirm-description">
                    {tr("common.share-link.confirm-deletion-link-description")}
                  </div>
                  <div className="pp-share-confirm-actions">
                    <button
                      type="button"
                      className="pp-btn-secondary"
                      onClick={() => setConfirm(false)}
                    >
                      {tr("labels.cancel")}
                    </button>
                    <button
                      type="button"
                      className="pp-btn-danger"
                      disabled={busy}
                      onClick={() => void deleteLink()}
                    >
                      {tr("common.share-link.destroy-link")}
                    </button>
                  </div>
                </div>
              ) : currentLink !== null ? (
                <button
                  type="button"
                  className="pp-btn-danger"
                  onClick={() => setConfirm(true)}
                >
                  {tr("common.share-link.destroy-link")}
                </button>
              ) : (
                <button
                  type="button"
                  className="pp-btn-primary"
                  disabled={busy}
                  onClick={() => void createLink()}
                >
                  {tr("common.share-link.get-link")}
                </button>
              )}
            </div>
          </div>

          {!confirm ? (
            <div className="pp-share-permissions">
              <button
                type="button"
                className="pp-share-manage"
                onClick={() => setPermsVisible((value) => !value)}
              >
                <span
                  className={
                    permsVisible
                      ? "pp-share-manage-icon pp-share-manage-icon--open"
                      : "pp-share-manage-icon"
                  }
                >
                  <ArrowIcon />
                </span>
                {tr("common.share-link.manage-ops")}
              </button>

              {permsVisible ? (
                <>
                  <div className="pp-share-pages">
                    <div className="pp-share-subtitle">
                      {tr("common.share-link.permissions-pages")}
                    </div>
                    <div className="pp-share-items">
                      {pages.length === 1 ? (
                        <div className="pp-share-checkbox pp-share-checkbox--checked">
                          <span className="pp-share-check">
                            <StatusTickIcon />
                          </span>
                          <span>{currentPageName}</span>
                          <span className="pp-share-current-tag">
                            {tr("common.share-link.current-tag")}
                          </span>
                        </div>
                      ) : (
                        <>
                          <div className="pp-share-select-all">
                            <label className="pp-share-checkbox">
                              <span
                                className={
                                  everyPage
                                    ? "pp-share-check pp-share-check--checked"
                                    : "pp-share-check"
                                }
                              >
                                {everyPage ? <StatusTickIcon /> : null}
                              </span>
                              <input
                                type="checkbox"
                                className="pp-share-visually-hidden"
                                checked={everyPage}
                                onChange={() => update(toggleEveryPage(draft, pages.map((p) => p.id), pageId))}
                              />
                              {tr("common.share-link.view-all")}
                            </label>
                            <span className="pp-share-count">
                              {tr("common.share-link.page-shared", draft.pages.length)}
                            </span>
                          </div>

                          <ul className="pp-share-page-list">
                            {pages.map((page) => {
                              const checked = draft.pages.includes(page.id);
                              return (
                                <li key={page.id} className="pp-share-page">
                                  <label className="pp-share-checkbox">
                                    <span
                                      className={
                                        checked
                                          ? "pp-share-check pp-share-check--checked"
                                          : "pp-share-check"
                                      }
                                    >
                                      {checked ? <StatusTickIcon /> : null}
                                    </span>
                                    <input
                                      type="checkbox"
                                      className="pp-share-visually-hidden"
                                      checked={checked}
                                      onChange={() =>
                                        update(toggleSharePage(draft, page.id, !checked))
                                      }
                                    />
                                    <span className="pp-share-page-name">{page.name}</span>
                                    {page.id === pageId ? (
                                      <span className="pp-share-current-tag">
                                        {tr("common.share-link.current-tag")}
                                      </span>
                                    ) : null}
                                  </label>
                                </li>
                              );
                            })}
                          </ul>
                        </>
                      )}
                    </div>
                  </div>

                  <div className="pp-share-access">
                    <div className="pp-share-subtitle">
                      {tr("common.share-link.permissions-can-comment")}
                    </div>
                    <div className="pp-share-items">
                      <select
                        className="pp-share-select"
                        value={draft.whoComment}
                        onChange={(event) =>
                          update({ ...draft, whoComment: event.target.value })
                        }
                      >
                        {ACCESS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {tr(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>

                  <div className="pp-share-access">
                    <div className="pp-share-subtitle">
                      {tr("common.share-link.permissions-can-inspect")}
                    </div>
                    <div className="pp-share-items">
                      <select
                        className="pp-share-select"
                        value={draft.whoInspect}
                        onChange={(event) =>
                          update({ ...draft, whoInspect: event.target.value })
                        }
                      >
                        {ACCESS_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {tr(option.labelKey)}
                          </option>
                        ))}
                      </select>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
