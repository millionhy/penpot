// Layout predicates and the layout-item cleanup of the workspace shell
// (F9.3 companion changes), ported from
// common/src/app/common/types/shape/layout.cljc and
// common/src/app/common/types/token.cljc. They feed two callers:
// - `reparentRoots` (lib/workspace-move), which drops the selection entries
//   the CLJS cleanup-invalid-moving-shapes would drop for a layout parent;
// - `buildRelocateChanges` (lib/workspace-relocate), which removes the
//   layout-item data of shapes leaving a layout and fixes the sizing of the
//   flex parents the change touches.
//
// Semantics mirror the CLJS exactly, including two asymmetries that look
// like bugs but are the shipped behavior:
// - change-h-sizing? ignores the absolutely positioned children on both the
//   column `every?` and the row `some` branch, while change-v-sizing?
//   ignores them on neither (it does not filter the children at all);
// - CLJS `every?` over an empty list answers true, so an auto-width column
//   flex with no (non-absolute) children still reports a sizing change.
//
// Deviations from the CLJS original, documented:
// - The functions take the shape (or the objects map plus the frame id)
//   directly: the shell has no keywords, so every enum compares as the
//   string the model carries ("flex", "column", "fill", ...).
// - `remove-layout-item-data` is split into the attribute list
//   (`layoutItemAttrsToRemove`) and the token pruning
//   (`unapplyLayoutItemTokens`): the relocate builder turns them into one
//   mod-obj per shape instead of one change per update-shapes call.

import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { isFrameShape } from "@/lib/workspace-selection";

// The cljs truthiness of `^boolean` coercions (nil and false are falsy).
function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

// layout.cljc flex-layout?: a frame whose :layout is :flex.
export function isFlexLayout(shape: WorkspaceShape | null): boolean {
  return shape !== null && isFrameShape(shape) && shape["layout"] === "flex";
}

// layout.cljc grid-layout?: a frame whose :layout is :grid.
export function isGridLayout(shape: WorkspaceShape | null): boolean {
  return shape !== null && isFrameShape(shape) && shape["layout"] === "grid";
}

// layout.cljc any-layout?: the flex and grid frames.
export function isAnyLayout(shape: WorkspaceShape | null): boolean {
  return isFlexLayout(shape) || isGridLayout(shape);
}

// layout.cljc col?: the column directions (reverse included).
export function isColumnLayout(shape: WorkspaceShape | null): boolean {
  if (shape === null) return false;
  return shape["layout-flex-dir"] === "column" || shape["layout-flex-dir"] === "column-reverse";
}

// layout.cljc row?: the row directions (reverse included).
export function isRowLayout(shape: WorkspaceShape | null): boolean {
  if (shape === null) return false;
  return shape["layout-flex-dir"] === "row" || shape["layout-flex-dir"] === "row-reverse";
}

// layout.cljc fill-width? / fill-height?.
export function isFillWidth(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["layout-item-h-sizing"] === "fill";
}

export function isFillHeight(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["layout-item-v-sizing"] === "fill";
}

// layout.cljc auto-width? / auto-height?: the sizing inherited from the
// layout position instead of a fixed value.
export function isAutoWidth(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["layout-item-h-sizing"] === "auto";
}

export function isAutoHeight(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["layout-item-v-sizing"] === "auto";
}

// layout.cljc position-absolute?: an item pulled out of the layout flow, or
// any hidden shape (the CLJS reuses the same predicate for the layout
// sizing checks).
export function isPositionAbsolute(shape: WorkspaceShape | null): boolean {
  if (shape === null) return false;
  return shape["layout-item-absolute"] === true || truthy(shape["hidden"]);
}

// layout.cljc change-h-sizing?: the flex frame auto-sizes horizontally but
// the moved children break that (every width-filling child of a column, or
// any width-filling child of a row). `childrenIds` must be the parent's
// children after the move, like the CLJS reads `(:shapes parent)` off the
// change builder; the child attributes come from `objects`.
export function changeHSizing(
  objects: WorkspaceObjects,
  frameId: string,
  childrenIds: readonly string[],
): boolean {
  const frame = objects[frameId] ?? null;
  if (!isFlexLayout(frame) || !isAutoWidth(frame)) return false;
  const children: WorkspaceShape[] = [];
  for (const id of childrenIds) {
    const child = objects[id];
    if (child !== undefined && child !== null) children.push(child);
  }
  if (isColumnLayout(frame)) {
    return children.filter((child) => !isPositionAbsolute(child)).every(isFillWidth);
  }
  return isRowLayout(frame) && children.some(isFillWidth);
}

// layout.cljc change-v-sizing?: the vertical twin. Unlike the horizontal
// one, neither branch filters the absolutely positioned children.
export function changeVSizing(
  objects: WorkspaceObjects,
  frameId: string,
  childrenIds: readonly string[],
): boolean {
  const frame = objects[frameId] ?? null;
  if (!isFlexLayout(frame) || !isAutoHeight(frame)) return false;
  const children: WorkspaceShape[] = [];
  for (const id of childrenIds) {
    const child = objects[id];
    if (child !== undefined && child !== null) children.push(child);
  }
  if (isColumnLayout(frame)) return children.some(isFillHeight);
  return isRowLayout(frame) && children.every(isFillHeight);
}

// The nine attributes remove-layout-item-data always drops: the margins,
// the min/max sizes, the alignment, the absolute flag and the z-index.
const LAYOUT_ITEM_ATTRS = [
  "layout-item-margin",
  "layout-item-margin-type",
  "layout-item-max-h",
  "layout-item-min-h",
  "layout-item-max-w",
  "layout-item-min-w",
  "layout-item-align-self",
  "layout-item-absolute",
  "layout-item-z-index",
] as const;

// remove-layout-item-data: the nine attributes plus h/v sizing, which
// survive only when the shape is itself a layout and does not fill that
// axis (a nested layout keeps the sizing the parent imposes on it). The
// result is the candidate list; the caller only emits the ones the shape
// actually has.
export function layoutItemAttrsToRemove(shape: WorkspaceShape): string[] {
  const attrs: string[] = [...LAYOUT_ITEM_ATTRS];
  const layout = isAnyLayout(shape);
  if (!layout || shape["layout-item-h-sizing"] === "fill") {
    attrs.push("layout-item-h-sizing");
  }
  if (!layout || shape["layout-item-v-sizing"] === "fill") {
    attrs.push("layout-item-v-sizing");
  }
  return attrs;
}

// token.cljc sizing-layout-item-keys + spacing-margin-keys: the applied
// tokens that belong to the layout-item data.
export const LAYOUT_ITEM_TOKEN_KEYS = [
  "layout-item-min-w",
  "layout-item-max-w",
  "layout-item-min-h",
  "layout-item-max-h",
  "m1",
  "m2",
  "m3",
  "m4",
] as const;

// unapply-layout-item-tokens: the applied-tokens map without the
// layout-item keys, or null when the shape has no such token applied (the
// CLJS update-shapes produces no operation in that case).
export function unapplyLayoutItemTokens(
  shape: WorkspaceShape,
): Record<string, unknown> | null {
  const applied = shape["applied-tokens"];
  if (applied === null || typeof applied !== "object" || Array.isArray(applied)) return null;
  const tokens = applied as Record<string, unknown>;
  const present = LAYOUT_ITEM_TOKEN_KEYS.filter((key) =>
    Object.prototype.hasOwnProperty.call(tokens, key),
  );
  if (present.length === 0) return null;
  const next: Record<string, unknown> = { ...tokens };
  for (const key of present) delete next[key];
  return next;
}
