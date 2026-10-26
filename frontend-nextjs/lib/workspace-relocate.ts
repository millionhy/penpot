// Reparent companions of the workspace shell (F9.3 companion changes): the
// mod-obj changes generate-relocate emits before moving shapes, ported from
// common/src/app/common/logic/shapes.cljc (generate-relocate).
//
// Scope (the F9.3 companion slice of generate-relocate):
// - layout-item: a shape dropped outside a flex/grid layout loses its
//   layout-item data and the tokens applied to it;
// - hide-in-viewer: a frame dropped into another frame is hidden in the
//   viewer (the drop into the zero root leaves the flag alone);
// - component metadata: a drop inside a component instance clears the
//   component-root flag of the moved subtree, a drop outside an instance
//   roots the moved instance heads;
// - flex sizing: every parent the change touches (the target and the old
//   parents) flips its auto width/height to fixed when the new children
//   break the auto sizing (layout.cljc change-h-sizing? / change-v-sizing?).
//
// The mov-objects change always comes last, like change-parent in the CLJS
// chain, and carries the reversed id list. The optional drop index is the
// flex insertion slot of lib/workspace-drop: with it the change re-orders a
// same-parent drop (insert-at-index), without it the backend appends only
// the ids the target does not already own (append-at-the-end), so a
// same-parent drop without a slot stays in place.
//
// Deviations from the CLJS original, documented:
// - The roots pass through the backend `is-valid-move?` filter first
//   (lib/workspace-move), so an invalid drop sends nothing at all. The CLJS
//   emits the companion changes before the mov and lets the backend drop
//   the mov alone, which would leave the companions applied.
// - swap slots are not removed: they travel as a touched group, which this
//   client does not encode yet.
// - the group cleanup (empty groups, mask unmask, detach) stays out: detach
//   is unreachable in the CLJS (it iterates the child heads, which never
//   satisfy in-component-copy-not-head?), and the deroot/reroot updates are
//   already covered by the two component-root bullets, because the backend
//   marks a main instance root with component-root too.
// - the constraints reset, the grid cell assignment, the blocked flag, the
//   variant metadata and resize-parents stay out with their slices.
// - one mod-obj per shape instead of one per update-shapes call: the
//   operations are disjoint, so the backend applies the same result.

import { ZERO_UUID } from "@/lib/file-data";
import type {
  UpdateFileChange,
  UpdateFileMovObjectsChange,
  UpdateFileSetOperation,
} from "@/lib/transit";
import type { WorkspaceObjects } from "@/lib/workspace";
import {
  getChildHeads,
  getChildrenIdsWithSelf,
  getInstanceRoot,
} from "@/lib/workspace-component";
import {
  changeHSizing,
  changeVSizing,
  isAnyLayout,
  layoutItemAttrsToRemove,
  unapplyLayoutItemTokens,
} from "@/lib/workspace-layout";
import { isValidMove, reparentRoots } from "@/lib/workspace-move";
import { insertChildren } from "@/lib/workspace-order";
import { isFrameShape } from "@/lib/workspace-selection";

// One operation accumulator: the insertion order is the order of the
// generate-relocate chain (layout-item, tokens, hide-in-viewer, component
// roots, sizing), which keeps the change readable in the request body.
class OperationList {
  private readonly byShape = new Map<string, UpdateFileSetOperation[]>();

  set(id: string, attr: string, val: unknown): void {
    const operations = this.byShape.get(id);
    const operation: UpdateFileSetOperation = { type: "set", attr, val };
    if (operations === undefined) this.byShape.set(id, [operation]);
    else operations.push(operation);
  }

  // update-shapes compares the old and new shapes: an attribute the shape
  // does not carry (or carries as nil) produces no operation.
  removeIfPresent(objects: WorkspaceObjects, id: string, attr: string): void {
    const shape = objects[id];
    if (shape === undefined || shape === null) return;
    const value = shape[attr];
    if (value === null || value === undefined) return;
    this.set(id, attr, null);
  }

  changes(pageId: string): UpdateFileChange[] {
    const result: UpdateFileChange[] = [];
    for (const [id, operations] of this.byShape) {
      result.push({ type: "mod-obj", "page-id": pageId, id, operations });
    }
    return result;
  }

  get size(): number {
    return this.byShape.size;
  }
}

// The children of one parent after the move, mirroring process-change
// :mov-objects: with an index the roots land at that slot of the target
// (insert-at-index), without one they append at the tail, and they
// disappear from every other parent. `reparentRoots` already dropped the
// entries that would duplicate a child of the target, so a same-parent drop
// only reaches the index branch (the flex re-order) or keeps its place on
// the no-index branch (append-at-the-end is a no-op over ids already
// present).
function childrenAfterMove(
  objects: WorkspaceObjects,
  parentId: string,
  targetFrameId: string,
  roots: readonly string[],
  dropIndex: number | null,
): string[] {
  const parent = objects[parentId];
  const current = parent !== undefined && parent !== null && Array.isArray(parent.shapes)
    ? parent.shapes
    : [];
  if (parentId === targetFrameId) {
    return dropIndex === null ? current : insertChildren(current, dropIndex, roots);
  }
  const moving = new Set(roots);
  return current.filter((id) => !moving.has(id));
}

// generate-relocate: the companion mod-obj changes plus the mov-objects
// change. Empty when the cleanup leaves nothing to move or the target
// parent is missing.
export function buildRelocateChanges(
  objects: WorkspaceObjects,
  selection: readonly string[],
  targetFrameId: string,
  pageId: string,
  dropIndex: number | null = null,
): UpdateFileChange[] {
  const parent = objects[targetFrameId];
  if (parent === undefined || parent === null) return [];
  // The structural guard first: a rejected move sends no companions.
  const roots = reparentRoots(objects, selection, targetFrameId).filter((id) =>
    isValidMove(objects, id, targetFrameId),
  );
  if (roots.length === 0) return [];

  const operations = new OperationList();

  // Remove layout-item properties and tokens when moving a shape outside a
  // layout.
  if (!isAnyLayout(parent)) {
    for (const id of roots) {
      const shape = objects[id];
      if (shape === undefined || shape === null) continue;
      for (const attr of layoutItemAttrsToRemove(shape)) {
        operations.removeIfPresent(objects, id, attr);
      }
      const tokens = unapplyLayoutItemTokens(shape);
      if (tokens !== null) operations.set(id, "applied-tokens", tokens);
    }
  }

  // Hide in the viewer: a frame dropped inside another frame. The CLJS
  // assocs true unconditionally; the change builder then drops the
  // operation when the flag already holds.
  if (targetFrameId !== ZERO_UUID && isFrameShape(parent)) {
    for (const id of roots) {
      const shape = objects[id];
      if (shape === undefined || shape === null) continue;
      if (!isFrameShape(shape)) continue;
      if (shape["hide-in-viewer"] === true) continue;
      operations.set(id, "hide-in-viewer", true);
    }
  }

  // Component metadata: a drop inside an instance clears component-root on
  // the whole moved subtree; a drop outside an instance roots every moved
  // instance head. The two branches are mutually exclusive, like the
  // get-instance-root condition of the CLJS pair.
  if (getInstanceRoot(objects, parent) !== null) {
    for (const root of roots) {
      for (const id of getChildrenIdsWithSelf(objects, root)) {
        operations.removeIfPresent(objects, id, "component-root");
      }
    }
  } else {
    for (const root of roots) {
      for (const head of getChildHeads(objects, root)) {
        if (head["component-root"] === true) continue;
        operations.set(head.id, "component-root", true);
      }
    }
  }

  // Fix the flex sizing of the parents the move touches: the target first,
  // then the old parents in the selection order (a set in the CLJS, so the
  // order across parents is irrelevant; each shape gets one change).
  const parents: string[] = [targetFrameId];
  for (const root of roots) {
    const oldParentId = objects[root]?.["parent-id"];
    if (typeof oldParentId !== "string") continue;
    if (!parents.includes(oldParentId)) parents.push(oldParentId);
  }
  for (const parentId of parents) {
    const frame = objects[parentId];
    if (frame === undefined || frame === null) continue;
    const children = childrenAfterMove(objects, parentId, targetFrameId, roots, dropIndex);
    if (changeHSizing(objects, parentId, children)) {
      operations.set(parentId, "layout-item-h-sizing", "fix");
    }
    if (changeVSizing(objects, parentId, children)) {
      operations.set(parentId, "layout-item-v-sizing", "fix");
    }
  }

  // change-parent: the reversed ids, at the drop slot when the caller
  // resolved one (a flex drop), at the tail otherwise.
  const mov: UpdateFileMovObjectsChange = {
    type: "mov-objects",
    "page-id": pageId,
    "parent-id": targetFrameId,
    shapes: roots.slice().reverse(),
  };
  if (dropIndex !== null) mov.index = dropIndex;
  return [...operations.changes(pageId), mov];
}
