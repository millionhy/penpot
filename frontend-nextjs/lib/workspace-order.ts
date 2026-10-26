// Workspace z-order (F9.8): the vertical-order commands of the CLJS
// app.main.data.workspace (vertical-order-selected) plus the children
// insertion the local change application shares with the backend.
//
// Semantics mirror the CLJS/common pair exactly:
// - index 0 is the bottom of the parent children list and appending is the
//   top (shape_tree.cljc add-shape, changes.cljc process-change);
// - insert-at-index (app.common.data) splits the list at the index, drops
//   every incoming id from both halves and concatenates before + incoming +
//   after. Re-indexing a shape already in the list therefore works from the
//   pre-move snapshot, which is what the CLJS formulas below assume;
// - the emitted changes are snapshot-based and the backend applies them one
//   at a time, so their order matters (a later index reads the list left by
//   the earlier changes).
//
// Deviations from the CLJS original, documented:
// - A shape whose parent is missing from the model is skipped instead of
//   emitting a change with a nil parent (the CLJS would emit one and let the
//   backend drop it). No F9 path reaches that state.
// - A command over an already-effective position still emits its change,
//   like the CLJS (which never compares positions); the caller skips the
//   request only when no change can be built at all.

import type { UpdateFileMovObjectsChange } from "@/lib/transit";
import type { WorkspaceObjects } from "@/lib/workspace";
import { orderedUnique } from "@/lib/workspace-selection";

// The :up/:down/:top/:bottom locations of vertical-order-selected.
export type VerticalOrderLocation = "up" | "down" | "top" | "bottom";

// app.common.data/insert-at-index: split-at index, then remove every
// incoming id from both halves, then concat before + incoming + after. The
// split clamps the index: a negative value lands at 0 and a past-the-end
// value at the current length.
export function insertChildren(
  children: readonly string[],
  index: number,
  ids: readonly string[],
): string[] {
  const at = Number.isFinite(index)
    ? Math.max(0, Math.min(Math.trunc(index), children.length))
    : children.length;
  const incoming = new Set(ids);
  const before = children.slice(0, at).filter((id) => !incoming.has(id));
  const after = children.slice(at).filter((id) => !incoming.has(id));
  return [...before, ...ids, ...after];
}

// vertical-order-selected: one mov-objects per selected shape, every index
// resolved against the pre-command snapshot (the change builder's
// with-objects). :top sends the shape past the last sibling, :up swaps it
// with the next one, :down with the previous one (the max 0 clamp keeps a
// bottom shape home), and :bottom uses the position inside the selection, so
// a multi-selection keeps its own relative order at the bottom.
export function buildVerticalOrderChanges(
  objects: WorkspaceObjects,
  selection: readonly string[],
  location: VerticalOrderLocation,
  pageId: string,
): UpdateFileMovObjectsChange[] {
  const selectedIds = orderedUnique(selection);
  const changes: UpdateFileMovObjectsChange[] = [];
  for (const id of selectedIds) {
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    const parentId = shape["parent-id"];
    if (typeof parentId !== "string") continue;
    const parent = objects[parentId];
    if (parent === undefined || parent === null) continue;
    const siblings = Array.isArray(parent.shapes) ? parent.shapes : [];
    const currentIndex = siblings.indexOf(id);
    let newIndex: number;
    switch (location) {
      case "top":
        newIndex = siblings.length;
        break;
      case "up":
        newIndex = Math.min(siblings.length, currentIndex + 2);
        break;
      case "down":
        newIndex = Math.max(0, currentIndex - 1);
        break;
      case "bottom":
        newIndex = selectedIds.indexOf(id);
        break;
    }
    changes.push({
      type: "mov-objects",
      "page-id": pageId,
      "parent-id": parentId,
      shapes: [id],
      index: newIndex,
    });
  }
  return changes;
}
