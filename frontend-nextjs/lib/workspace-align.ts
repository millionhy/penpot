// The alignment and distribution math of the workspace style panel
// (F9.14): where the align bar moves each selected shape.
//
// Ported from:
// - common/src/app/common/geom/align.cljc (calc-align-pos, align-to-rect,
//   align-to-parent, distribute-space);
// - frontend/src/app/main/data/workspace.cljs (can-align?, can-distribute?,
//   align-objects-list, align-object-to-parent).
//
// A shape enters the math with its wrapping rectangle: the bounding box of
// its stored points, which already carries the rotation (the same box the
// measures menu shows as x/y). A multi selection aligns every shape to the
// box that wraps the whole selection; a single selection aligns to its
// parent, so the parent is read in its own frame and the delta comes back
// through the parent transform. Distribution spreads the gap between the
// wrapping boxes evenly, keeping the first and the last one in place.
//
// The module returns displacements, never shapes: the canvas turns each one
// into a translation matrix and commits one update-file for the batch, which
// is the same path the move drag uses.
//
// Deviations from the CLJS original, documented (AD12):
// - The single-selection path aligns to the parent frame only; a shape whose
//   parent is the root board has nothing to align to (the menu disables the
//   button, like can-align?).
// - Shapes without a selrect drop out of the batch; a text shape keeps its
//   geometry (lib/workspace-transform does not rewrite its position-data),
//   so the canvas commits the shapes it can transform and leaves the rest.
// - The distribution sorts by the wrapping box center, not by the rotated
//   selrect center.

import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { ZERO_UUID } from "@/lib/file-data";
import {
  inverseMatrix,
  shapeTransformMatrix,
  transformPoint,
} from "@/lib/workspace-transform";

export type AlignAxis = "hleft" | "hcenter" | "hright" | "vtop" | "vcenter" | "vbottom";

export type DistributeAxis = "horizontal" | "vertical";

export interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Float noise below this does not count as a move: a shape already aligned
// sends nothing.
const EPSILON = 1e-6;

// The six align axes of the CLJS valid-align-axis set.
export const ALIGN_AXES: readonly AlignAxis[] = [
  "hleft",
  "hcenter",
  "hright",
  "vtop",
  "vcenter",
  "vbottom",
];

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The four stored points, or the selrect corners when the shape carries
// none; the same fallback lib/workspace-geometry uses.
function pointsOf(shape: WorkspaceShape): { x: number; y: number }[] | null {
  const points = shape["points"];
  if (Array.isArray(points) && points.length >= 4) {
    const out: { x: number; y: number }[] = [];
    for (const item of points) {
      const record = recordOf(item);
      if (record === null) break;
      const x = numberAt(record, "x");
      const y = numberAt(record, "y");
      if (x === null || y === null) break;
      out.push({ x, y });
    }
    if (out.length >= 4) return out.slice(0, 4);
  }
  const selrect = recordOf(shape["selrect"]);
  if (selrect === null) return null;
  const x = numberAt(selrect, "x");
  const y = numberAt(selrect, "y");
  const width = numberAt(selrect, "width");
  const height = numberAt(selrect, "height");
  if (x === null || y === null || width === null || height === null) return null;
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function boundsOfPoints(points: readonly { x: number; y: number }[]): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// gsh/shapes->rect for one shape: the world bounding box of its points.
export function boundsOf(shape: WorkspaceShape): Bounds | null {
  const points = pointsOf(shape);
  if (points === null) return null;
  return boundsOfPoints(points);
}

// gsh/shapes->rect for a list: the box that wraps every input box.
export function unionBounds(rects: readonly Bounds[]): Bounds | null {
  if (rects.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.width);
    maxY = Math.max(maxY, rect.y + rect.height);
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

// dw/can-align?: a multi selection always aligns; a single shape aligns to
// its parent, so the root board child has no target.
export function canAlign(objects: WorkspaceObjects, ids: readonly string[]): boolean {
  if (ids.length === 0) return false;
  if (ids.length > 1) return true;
  const shape = objects[ids[0]];
  if (shape === undefined || shape === null) return false;
  const parentId = shape["parent-id"];
  return typeof parentId === "string" && parentId !== ZERO_UUID;
}

// dw/can-distribute?: at least three shapes.
export function canDistribute(ids: readonly string[]): boolean {
  return ids.length >= 3;
}

// calc-align-pos: the wanted top-left of the wrapper box along one axis.
// The other coordinate keeps the box where it is.
function alignPosition(bounds: Bounds, rect: Bounds, axis: AlignAxis): { x: number; y: number } {
  switch (axis) {
    case "hleft":
      return { x: rect.x, y: bounds.y };
    case "hcenter":
      return {
        x: rect.x + rect.width / 2 - bounds.width / 2,
        y: bounds.y,
      };
    case "hright":
      return { x: rect.x + rect.width - bounds.width, y: bounds.y };
    case "vtop":
      return { x: bounds.x, y: rect.y };
    case "vcenter":
      return {
        x: bounds.x,
        y: rect.y + rect.height / 2 - bounds.height / 2,
      };
    case "vbottom":
      return { x: bounds.x, y: rect.y + rect.height - bounds.height };
  }
}

export interface AlignMove {
  id: string;
  dx: number;
  dy: number;
}

function movedBy(id: string, dx: number, dy: number): AlignMove | null {
  if (Math.abs(dx) <= EPSILON && Math.abs(dy) <= EPSILON) return null;
  return { id, dx, dy };
}

// align-object-to-parent: the parent box is read in the parent frame and the
// delta is carried back to world coordinates by the parent transform, so a
// rotated frame aligns its child along its own axes.
function parentMove(
  shape: WorkspaceShape,
  parent: WorkspaceShape,
  axis: AlignAxis,
): AlignMove | null {
  const points = pointsOf(shape);
  const parentSelrect = recordOf(parent["selrect"]);
  if (points === null || parentSelrect === null) return null;
  const px = numberAt(parentSelrect, "x");
  const py = numberAt(parentSelrect, "y");
  const pw = numberAt(parentSelrect, "width");
  const ph = numberAt(parentSelrect, "height");
  if (px === null || py === null || pw === null || ph === null) return null;

  const matrix = shapeTransformMatrix(parent);
  const inverse = inverseMatrix(matrix);
  if (inverse === null) return null;

  const local = boundsOfPoints(points.map((point) => transformPoint(point, inverse)));
  if (local === null) return null;

  const wanted = alignPosition(local, { x: px, y: py, width: pw, height: ph }, axis);
  const localDx = wanted.x - local.x;
  const localDy = wanted.y - local.y;
  if (Math.abs(localDx) <= EPSILON && Math.abs(localDy) <= EPSILON) return null;

  // The local delta as a world vector: the linear part of the parent
  // transform applied to the delta (the translation cancels out).
  const origin = transformPoint({ x: 0, y: 0 }, matrix);
  const moved = transformPoint({ x: localDx, y: localDy }, matrix);
  return movedBy(shape.id, moved.x - origin.x, moved.y - origin.y);
}

// dw/align-objects: a multi selection aligns every shape to the selection
// box, a single shape to its parent.
export function alignMoves(
  objects: WorkspaceObjects,
  ids: readonly string[],
  axis: AlignAxis,
): AlignMove[] {
  if (!canAlign(objects, ids)) return [];

  if (ids.length === 1) {
    const shape = objects[ids[0]];
    if (shape === undefined || shape === null) return [];
    const parentId = shape["parent-id"];
    if (typeof parentId !== "string" || parentId === ZERO_UUID) return [];
    const parent = objects[parentId];
    if (parent === undefined || parent === null) return [];
    const move = parentMove(shape, parent, axis);
    return move === null ? [] : [move];
  }

  const shapes: WorkspaceShape[] = [];
  const boxes: Bounds[] = [];
  for (const id of ids) {
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    const box = boundsOf(shape);
    if (box === null) continue;
    shapes.push(shape);
    boxes.push(box);
  }
  const wrapper = unionBounds(boxes);
  if (wrapper === null) return [];

  const moves: AlignMove[] = [];
  for (let index = 0; index < shapes.length; index += 1) {
    const box = boxes[index];
    const wanted = alignPosition(box, wrapper, axis);
    const move = movedBy(shapes[index].id, wanted.x - box.x, wanted.y - box.y);
    if (move !== null) moves.push(move);
  }
  return moves;
}

// gal/distribute-space: sort by the box center on the axis, then place each
// box after the previous one plus the even unit space. The first and the
// last keep their place because the space is measured from their edges.
export function distributeMoves(
  objects: WorkspaceObjects,
  ids: readonly string[],
  axis: DistributeAxis,
): AlignMove[] {
  if (!canDistribute(ids)) return [];
  const horizontal = axis === "horizontal";

  const entries: { id: string; box: Bounds }[] = [];
  for (const id of ids) {
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    const box = boundsOf(shape);
    if (box === null) continue;
    entries.push({ id, box });
  }
  if (entries.length < 3) return [];

  const wrapper = unionBounds(entries.map((entry) => entry.box));
  if (wrapper === null) return [];

  const sizeOf = (box: Bounds): number => (horizontal ? box.width : box.height);
  const startOf = (box: Bounds): number => (horizontal ? box.x : box.y);
  const centerOf = (box: Bounds): number =>
    horizontal ? box.x + box.width / 2 : box.y + box.height / 2;

  const sorted = [...entries].sort((a, b) => centerOf(a.box) - centerOf(b.box));
  const total = sorted.reduce((sum, entry) => sum + sizeOf(entry.box), 0);
  const wrapperSize = horizontal ? wrapper.width : wrapper.height;
  const unit = (wrapperSize - total) / (sorted.length - 1);

  let cursor = horizontal ? wrapper.x : wrapper.y;
  const moves: AlignMove[] = [];
  for (const entry of sorted) {
    const delta = cursor - startOf(entry.box);
    cursor += sizeOf(entry.box) + unit;
    const move = horizontal
      ? movedBy(entry.id, delta, 0)
      : movedBy(entry.id, 0, delta);
    if (move !== null) moves.push(move);
  }
  return moves;
}
