// Drop-index of the workspace move (F9.3 drop-index): the insertion position
// a shape dropped into a flex frame takes, ported from
// common/src/app/common/geom/shapes/flex_layout/drop_area.cljc
// (get-drop-index / layout-drop-areas / drop-child-areas).
//
// The CLJS splits every layout line at the center of each visible,
// non-absolute child and answers the children index of the half under the
// pointer. The child order it enumerates is the parent list, whose tail is
// the first item of the flow: a normal row/column lays the children from the
// list tail to the list head, a row-reverse/column-reverse from the head to
// the tail. That gives the index mapping of this port:
// - normal direction: the first flow child whose center is at or past the
//   pointer maps to its list index + 1 (the slot before it); the far end of
//   the flow (no such child) maps to 0;
// - reverse direction: the same child maps to its list index; the far end
//   maps to the children count.
// An exact center hit belongs to the half before the center, like the CLJS
// seek over the [start, end] areas.
//
// Deviations from the CLJS original, documented:
// - Only the main axis of one layout line is considered. The wrap lines,
//   the gap half-splits, the frame rotation/flip (the CLJS transforms the
//   point by transform-inverse) and the grid cell (get-drop-cell) stay out.
//   A rotated frame compares on the world axes, like the draw geometry of
//   F9.5.
// - The index counts every entry of parent.shapes, hidden and absolute
//   children included, because insert-at-index operates on that list. The
//   CLJS enumerates the children after removing the hidden ones.
// - The child position comes from the selrect, or from x/y + width/height
//   when the selrect is incomplete, instead of the parent-coords points.
// - A missing frame, a non-flex frame, no usable flow child or no usable
//   geometry returns null: the callers then keep the tail append of the
//   change (the CLJS get-drop-index answers nil and change-parent omits the
//   index).

import { isColumnLayout, isFlexLayout, isPositionAbsolute } from "@/lib/workspace-layout";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

export interface DropPoint {
  x: number;
  y: number;
}

// The main-axis center of one flow child: selrect first, the x/y and
// width/height pair otherwise. Null when neither carries four numbers.
function mainAxisCenter(shape: WorkspaceShape, column: boolean): number | null {
  const selrect = shape["selrect"];
  if (selrect !== null && typeof selrect === "object") {
    const { x, y, width, height } = selrect as Record<string, unknown>;
    if (
      typeof x === "number" &&
      typeof y === "number" &&
      typeof width === "number" &&
      typeof height === "number"
    ) {
      return column ? y + height / 2 : x + width / 2;
    }
  }
  const x = shape["x"];
  const y = shape["y"];
  const width = shape["width"];
  const height = shape["height"];
  if (
    typeof x === "number" &&
    typeof y === "number" &&
    typeof width === "number" &&
    typeof height === "number"
  ) {
    return column ? y + height / 2 : x + width / 2;
  }
  return null;
}

function isReverseLayout(shape: WorkspaceShape): boolean {
  return (
    shape["layout-flex-dir"] === "row-reverse" ||
    shape["layout-flex-dir"] === "column-reverse"
  );
}

// get-drop-index for one flex frame: the list index the dropped shape takes,
// or null when the frame is not a flex layout or the flow has no usable
// child.
export function dropIndexForFrame(
  objects: WorkspaceObjects,
  frameId: string,
  point: DropPoint,
): number | null {
  const frame = objects[frameId];
  if (frame === undefined || frame === null || !isFlexLayout(frame)) return null;
  const children = Array.isArray(frame.shapes) ? frame.shapes : [];
  if (children.length === 0) return null;

  const column = isColumnLayout(frame);
  const reverse = isReverseLayout(frame);
  const position = column ? point.y : point.x;

  // The flow children with their list index and main-axis center. Hidden
  // and absolute children do not take part in the flow.
  const flow: Array<{ index: number; center: number }> = [];
  for (let index = 0; index < children.length; index += 1) {
    const child = objects[children[index]];
    if (child === undefined || child === null) continue;
    if (isPositionAbsolute(child)) continue;
    const center = mainAxisCenter(child, column);
    if (center === null || !Number.isFinite(center)) continue;
    flow.push({ index, center });
  }
  if (flow.length === 0) return null;
  flow.sort((a, b) => a.center - b.center);

  // The first child whose center is at or past the pointer owns the slot.
  for (const item of flow) {
    if (item.center >= position) {
      return reverse ? item.index : item.index + 1;
    }
  }
  return reverse ? children.length : 0;
}
