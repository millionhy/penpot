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
// - The sitemap has no drag-to-relocate UI, but withPageMoved exists for the
//   remote :mov-page application (lib/workspace-file-change). Separator
//   pages still wait for a later pass.
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

// The page attributes a :mod-page change may carry. A null value removes the
// attribute, matching the explicit-nil half of changes.cljc process-change
// :mod-page; an absent key keeps the current value.
export interface WorkspacePagePatch {
  name?: string;
  background?: string | null;
  "background-token"?: string | null;
  "pixel-grid-color"?: string | null;
  "pixel-grid-opacity"?: number | null;
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
  return withPageModified(file, id, { name });
}

// process-change :mod-page: name is assoc-only, while the background and
// pixel-grid attrs also accept an explicit nil to remove the override. The
// page map is copied but its objects map keeps the same reference, so a
// rename or a background edit does not reload the canvas model.
export function withPageModified(
  file: WorkspaceFile,
  id: string,
  patch: WorkspacePagePatch,
): WorkspaceFile {
  const index = file.data["pages-index"] ?? {};
  const page = index[id];
  if (page === undefined || page === null) return file;

  const draft: WorkspacePageData = { ...page };
  const attrs = draft as Record<string, unknown>;
  let changed = false;
  const has = (key: keyof WorkspacePagePatch): boolean =>
    Object.prototype.hasOwnProperty.call(patch, key);

  if (has("name") && typeof patch.name === "string" && patch.name !== page.name) {
    draft.name = patch.name;
    changed = true;
  }

  const removeOrSet = (
    key: "background" | "background-token" | "pixel-grid-color" | "pixel-grid-opacity",
    value: string | number | null | undefined,
  ): void => {
    if (value === undefined) return;
    if (value === null) {
      if (!Object.prototype.hasOwnProperty.call(attrs, key)) return;
      delete attrs[key];
      changed = true;
      return;
    }
    if (attrs[key] === value) return;
    attrs[key] = value;
    changed = true;
  };

  if (has("background")) removeOrSet("background", patch.background);
  if (has("background-token")) removeOrSet("background-token", patch["background-token"]);
  if (has("pixel-grid-color")) removeOrSet("pixel-grid-color", patch["pixel-grid-color"]);
  if (has("pixel-grid-opacity")) {
    removeOrSet("pixel-grid-opacity", patch["pixel-grid-opacity"]);
  }

  if (!changed) return file;
  return {
    ...file,
    data: {
      ...file.data,
      "pages-index": { ...index, [id]: draft },
    },
  };
}

// d/insert-at-index: the id leaves the list first, the index counts on the
// remaining ids, and an out-of-range index appends or prepends like split-at.
export function withPageMoved(
  file: WorkspaceFile,
  id: string,
  index: number,
): WorkspaceFile {
  const pages = file.data.pages ?? [];
  if (!pages.includes(id)) return file;
  const kept = pages.filter((pageId) => pageId !== id);
  const at = Math.max(0, Math.min(index, kept.length));
  const moved = [...kept.slice(0, at), id, ...kept.slice(at)];
  // A move to the position the page already holds is a store no-op.
  if (
    moved.length === pages.length &&
    moved.every((pageId, position) => pageId === pages[position])
  ) {
    return file;
  }
  return {
    ...file,
    data: {
      ...file.data,
      pages: moved,
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
