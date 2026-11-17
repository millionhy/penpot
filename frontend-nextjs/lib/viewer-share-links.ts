// The share-link pieces of the viewer (F6.6): the port of the pure helpers
// of app.main.ui.viewer.share-link. The dialog itself lives in
// components/viewer-share-modal.tsx.
//
// The options state of the CLJS is {pages-mode, all-pages, pages, who-comment,
// who-inspect}; only pages / who-comment / who-inspect reach the RPC
// (prepare-params), the other two drive the permission checkboxes. The shell
// keeps the drafts as a plain object and derives the two flags.
//
// Deviations from the CLJS original, documented:
// - The CLJS compares the stored pages (a set) with `=`, and looks up the link
//   to delete by matching :flags — the options map has no flags, so the seek
//   matches the first link whose flags are nil. The shell matches the draft's
//   pages / who-* instead, and deletes that link.
// - Page membership compares by value in file page order, where the CLJS set
//   iteration is unordered.

import { viewerHref, type ViewerHrefParams } from "@/lib/viewer";

export interface ShareLink {
  id: string;
  "who-comment"?: string;
  "who-inspect"?: string;
  pages?: string[];
  [key: string]: unknown;
}

// The options map of the dialog: the three fields prepare-params sends, plus
// the current page the "current page" fallback returns to.
export interface ShareLinkDraft {
  pages: string[];
  whoComment: string;
  whoInspect: string;
}

export const SHARE_ACCESS = ["team", "all"] as const;
export type ShareAccess = (typeof SHARE_ACCESS)[number];

export function isShareAccess(value: string): value is ShareAccess {
  return (SHARE_ACCESS as readonly string[]).includes(value);
}

// The initial options of the dialog: the current page only, both policies
// restricted to the team.
export function initialShareLinkDraft(currentPageId: string): ShareLinkDraft {
  return {
    pages: [currentPageId],
    whoComment: "team",
    whoInspect: "team",
  };
}

export function prepareShareParams(draft: ShareLinkDraft): {
  pages: string[];
  "who-comment": string;
  "who-inspect": string;
} {
  return {
    pages: [...draft.pages],
    "who-comment": draft.whoComment,
    "who-inspect": draft.whoInspect,
  };
}

function linkPages(link: ShareLink): string[] {
  return Array.isArray(link.pages) ? link.pages : [];
}

// Two page collections hold the same ids, independent of order.
export function samePages(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const values = new Set(right);
  return left.every((id) => values.has(id));
}

// The link the dialog shows: the first stored link with the same policies and
// the same page set.
export function findShareLink(
  links: readonly ShareLink[],
  draft: ShareLinkDraft,
): ShareLink | null {
  for (const link of links) {
    if (
      link["who-comment"] === draft.whoComment &&
      link["who-inspect"] === draft.whoInspect &&
      samePages(linkPages(link), draft.pages)
    ) {
      return link;
    }
  }
  return null;
}

// The pages select-all row: checked when the draft covers every file page.
export function isEveryPageSelected(
  draft: ShareLinkDraft,
  pageIds: readonly string[],
): boolean {
  return pageIds.length > 0 && samePages(draft.pages, pageIds);
}

// on-toggle-all: checking selects every page, unchecking returns to the
// current page alone.
export function toggleEveryPage(
  draft: ShareLinkDraft,
  pageIds: readonly string[],
  currentPageId: string,
): ShareLinkDraft {
  if (isEveryPageSelected(draft, pageIds)) {
    return { ...draft, pages: [currentPageId] };
  }
  return { ...draft, pages: [...pageIds] };
}

// on-mark-checked-page: the CLJS should-change? guard refuses to uncheck the
// only selected page, so the dialog always keeps at least one page checked.
export function toggleSharePage(
  draft: ShareLinkDraft,
  pageId: string,
  checked: boolean,
): ShareLinkDraft {
  const isOnlyPage = draft.pages.length === 1 && draft.pages[0] === pageId;
  if (isOnlyPage) return draft;
  const pages = checked
    ? draft.pages.includes(pageId)
      ? draft.pages
      : [...draft.pages, pageId]
    : draft.pages.filter((id) => id !== pageId);
  return { ...draft, pages };
}

// The href of a stored link: share-id + the first file page the link carries
// + index 0, and the zoom style only when it is set (the CLJS dissoc when
// zoom-type is nil). viewerHref drops the null fields.
export function shareLinkHref(
  link: ShareLink,
  query: ViewerHrefParams,
  pageIds: readonly string[],
  zoomType: string | null,
): string {
  const carried = linkPages(link);
  const pageId = pageIds.find((id) => carried.includes(id)) ?? null;
  return viewerHref({
    ...query,
    pageId,
    shareId: link.id,
    index: 0,
    zoom: zoomType,
  });
}
