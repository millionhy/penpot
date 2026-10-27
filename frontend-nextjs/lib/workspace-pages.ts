// The workspace page list (F9.13): the pure half of the sitemap, the port of
// app.main.data.workspace.pages and the helpers it leans on.
//
// The file data keeps the page order in :pages and the page maps in
// :pages-index (common/src/app/common/types/pages_list.cljc). Every helper
// here returns a new WorkspaceFile instead of mutating the loaded one, so the
// store's useSyncExternalStore subscribers see the change and the canvas
// reload effect can key on the file identity.
//
// The change builders carry the same maps the CLJS builders push (add-empty-
// page / mod-page / del-page); lib/transit encodes them for update-file.
//
// Deviations from the CLJS original, documented:
// - Only add, rename and delete: the CLJS also relocates pages by drag
//   (:mov-page) and creates separator pages, which the sitemap slice leaves
//   for a later pass.
// - A page change is committed outside the undo stack: the F9.7 stack
//   inverts shape changes from the model and has no page inverse, so the
//   sidebar sends these changes with recordUndo false.
// - The generated name is the English "Page N" whatever the locale, exactly
//   like cfh/generate-unique-name (the base name is a literal there too).

import { ZERO_UUID } from "@/lib/file-data";
import type { UpdateFileChange } from "@/lib/transit";
import type {
  WorkspaceFile,
  WorkspacePageData,
  WorkspaceShape,
} from "@/lib/workspace";

export interface WorkspacePageInfo {
  id: string;
  name: string;
}

// The pages of the file in file order; a page missing from pages-index keeps
// the empty name the CLJS page-item falls back to.
export function pageInfos(file: WorkspaceFile): WorkspacePageInfo[] {
  const index = file.data["pages-index"] ?? {};
  const out: WorkspacePageInfo[] = [];
  for (const id of file.data.pages ?? []) {
    const page = index[id];
    out.push({ id, name: typeof page?.name === "string" ? page.name : "" });
  }
  return out;
}

// cfh/generate-unique-name "Page" unames :immediate-suffix? true: the bare
// base counts as taken, so the first free candidate is "Page 1".
export function uniquePageName(names: readonly string[]): string {
  const used = new Set(names);
  let counter = 1;
  while (used.has(`Page ${counter}`)) counter += 1;
  return `Page ${counter}`;
}

// ctp/normalize-page-name: the stored name is the trimmed input.
export function normalizePageName(name: string): string {
  return name.trim();
}

// ctp/valid-page-name?: a blank name is rejected (the CLJS treats it as a
// separator delete only when the page is empty).
export function validPageName(name: string): boolean {
  return normalizePageName(name).length > 0;
}

// ctp/make-empty-page: one root frame under the zero uuid. The root of a page
// carries only per-page data (no children), so the current page's root is the
// exact template the backend would build; its children list is cleared.
export function emptyPage(
  id: string,
  name: string,
  root?: WorkspaceShape | null,
): WorkspacePageData {
  const template: WorkspaceShape =
    root !== undefined && root !== null
      ? {
          ...root,
          id: ZERO_UUID,
          type: "frame",
          "parent-id": ZERO_UUID,
          "frame-id": ZERO_UUID,
          shapes: [],
        }
      : {
          id: ZERO_UUID,
          type: "frame",
          name: "Root Frame",
          "parent-id": ZERO_UUID,
          "frame-id": ZERO_UUID,
          shapes: [],
        };
  return { id, name, objects: { [ZERO_UUID]: template } };
}

// ctpl/add-page: appends the id to :pages and stores the page map. Adding an
// id already present is a no-op, like the CLJS.
export function withPageAdded(
  file: WorkspaceFile,
  page: WorkspacePageData,
): WorkspaceFile {
  const pages = file.data.pages ?? [];
  if (pages.includes(page.id)) return file;
  return {
    ...file,
    data: {
      ...file.data,
      pages: [...pages, page.id],
      "pages-index": { ...(file.data["pages-index"] ?? {}), [page.id]: page },
    },
  };
}

// mod-page :name: only the name changes; the page map keeps its objects
// reference, so the canvas does not see a new objects map for the rename
// target.
export function withPageRenamed(
  file: WorkspaceFile,
  id: string,
  name: string,
): WorkspaceFile {
  const index = file.data["pages-index"] ?? {};
  const page = index[id];
  if (page === undefined || page === null || page.name === name) return file;
  return {
    ...file,
    data: {
      ...file.data,
      "pages-index": { ...index, [id]: { ...page, name } },
    },
  };
}

// ctpl/delete-page: filters the id out of :pages and dissocs the page map.
export function withPageDeleted(file: WorkspaceFile, id: string): WorkspaceFile {
  const pages = file.data.pages ?? [];
  if (!pages.includes(id)) return file;
  const index = { ...(file.data["pages-index"] ?? {}) };
  delete index[id];
  return {
    ...file,
    data: {
      ...file.data,
      pages: pages.filter((pageId) => pageId !== id),
      "pages-index": index,
    },
  };
}

// The update-file changes of one page action. The CLJS builders attach the
// undo half; the shell sends recordUndo false, see the deviation above.
export function addPageChange(id: string, name: string): UpdateFileChange {
  return { type: "add-page", id, name };
}

export function renamePageChange(id: string, name: string): UpdateFileChange {
  return { type: "mod-page", id, name };
}

export function deletePageChange(id: string): UpdateFileChange {
  return { type: "del-page", id };
}
