// Workspace frame titles (F9.4): the pure geometry behind the title labels
// drawn over the top-level frames.
//
// Port of title-transform-use-width?, the left/top/right vertex choice and
// title-transform from app.main.ui.workspace.viewport.utils, plus a
// topLevelFrames walk over the root children.
//
// The CLJS returns an SVG transform string. This module returns the parts
// so the caller can compose the same string and the math stays testable:
//
//   rotate(angle, pivotX, pivotY)
//   scale(scale, scale)
//   translate(translateX, translateY)
//
// scale is 1/zoom and the translate is the label position multiplied by
// zoom, so a point placed after the translate lands at a constant screen
// size and the label position stays in world coordinates.
//
// Deviations from the CLJS original, documented:
// - No grid-edition offsets (delta-x 40 / delta-y 50): F9.4 has no grid
//   edition, so the label always sits 10 screen pixels above its vertex.
// - No shape icon and no id suffix; the label is the frame name only.

import { ZERO_UUID } from "@/lib/file-data";
import { isFrameShape } from "@/lib/workspace-selection";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

export interface FrameTitlePoint {
  x: number;
  y: number;
}

export interface FrameTitleTransform {
  angle: number;
  pivotX: number;
  pivotY: number;
  scale: number;
  translateX: number;
  translateY: number;
}

// mth/close? defaults to 0.001; the vertex helpers use 0.01.
const CLOSE_EPSILON = 0.01;

// The label sits 10 screen pixels above the chosen edge.
const LABEL_OFFSET_Y = 10;

function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= CLOSE_EPSILON;
}

// left? / top? / right? of viewport/utils.cljs. Ties on the other axis pick
// a deterministic vertex.
function leftmost(cur: FrameTitlePoint, cand: FrameTitlePoint): FrameTitlePoint {
  if (close(cand.x, cur.x)) return cand.y < cur.y ? cand : cur;
  return cand.x < cur.x ? cand : cur;
}

function topmost(cur: FrameTitlePoint, cand: FrameTitlePoint): FrameTitlePoint {
  if (close(cand.y, cur.y)) return cand.x < cur.x ? cand : cur;
  return cand.y < cur.y ? cand : cur;
}

function rightmost(cur: FrameTitlePoint, cand: FrameTitlePoint): FrameTitlePoint {
  if (close(cand.x, cur.x)) return cand.y < cur.y ? cand : cur;
  return cand.x > cur.x ? cand : cur;
}

function pick(
  points: readonly FrameTitlePoint[],
  select: (cur: FrameTitlePoint, cand: FrameTitlePoint) => FrameTitlePoint,
): FrameTitlePoint | null {
  if (points.length === 0) return null;
  return points.slice(1).reduce((cur, cand) => select(cur, cand), points[0]);
}

// Set removal by value, like the CLJS (remove #{leftmost}).
function without(
  points: readonly FrameTitlePoint[],
  point: FrameTitlePoint,
): FrameTitlePoint[] {
  return points.filter(
    (candidate) => candidate.x !== point.x || candidate.y !== point.y,
  );
}

function angleOf(vector: FrameTitlePoint): number {
  return (Math.atan2(vector.y, vector.x) * 180) / Math.PI;
}

function unit(vector: FrameTitlePoint): FrameTitlePoint {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-4) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

// gpt/perpendicular: (x, y) -> (-y, x).
function perpendicular(vector: FrameTitlePoint): FrameTitlePoint {
  return { x: -vector.y, y: vector.x };
}

// The points of the stored shape, or null when they are not usable.
function pointsOf(shape: WorkspaceShape): FrameTitlePoint[] | null {
  const points = shape.points;
  if (!Array.isArray(points) || points.length < 3) return null;
  const out: FrameTitlePoint[] = [];
  for (const point of points) {
    if (
      point === null ||
      typeof point !== "object" ||
      typeof point.x !== "number" ||
      typeof point.y !== "number" ||
      !Number.isFinite(point.x) ||
      !Number.isFinite(point.y)
    ) {
      return null;
    }
    out.push({ x: point.x, y: point.y });
  }
  return out;
}

// title-transform-use-width?: which side of the frame the title spans. The
// 45-degree boundaries split the four rotations: 0/45/135/180/225/... use
// the width; 46..134 and the like use the height.
export function titleTransformUseWidth(shape: WorkspaceShape): boolean {
  const rotation = typeof shape.rotation === "number" ? shape.rotation : 0;
  const side = Math.ceil((rotation - 45) / 90);
  return side % 2 === 0;
}

export function titleTransform(
  shape: WorkspaceShape,
  zoom: number,
): FrameTitleTransform | null {
  if (!Number.isFinite(zoom) || zoom <= 0) return null;
  const points = pointsOf(shape);
  if (points === null) return null;

  const left = pick(points, leftmost);
  if (left === null) return null;
  const top = pick(without(points, left), topmost);
  if (top === null) return null;
  const right = pick(without(without(points, left), top), rightmost);
  if (right === null) return null;

  // The chosen vertex and edge: the less slanted of left->top and top->right.
  const leftTop = { x: top.x - left.x, y: top.y - left.y };
  const topRight = { x: right.x - top.x, y: right.y - top.y };
  const leftTopAngle = angleOf(leftTop);
  const topRightAngle = angleOf(topRight);
  const chooseLeft = Math.abs(leftTopAngle) < Math.abs(topRightAngle);
  const anchor = chooseLeft ? left : top;
  const angle = chooseLeft ? leftTopAngle : topRightAngle;
  const horizontal = chooseLeft ? leftTop : topRight;
  const vertical = perpendicular(horizontal);

  // Move the label 10 screen pixels away from the vertex along the normal.
  // Dividing by zoom keeps the offset constant on screen.
  const verticalUnit = unit(vertical);
  const pivotX = anchor.x - verticalUnit.x * (LABEL_OFFSET_Y / zoom);
  const pivotY = anchor.y - verticalUnit.y * (LABEL_OFFSET_Y / zoom);

  return {
    angle,
    pivotX,
    pivotY,
    scale: 1 / zoom,
    translateX: pivotX * zoom,
    translateY: pivotY * zoom,
  };
}

// The top-level frames in root order. Nested frames are skipped, like the
// parent-id = zero filter of frame-titles*.
export function topLevelFrames(objects: WorkspaceObjects): WorkspaceShape[] {
  const root = objects[ZERO_UUID];
  if (root === undefined || root === null) return [];
  const frames: WorkspaceShape[] = [];
  for (const id of root.shapes ?? []) {
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    if (isFrameShape(shape)) frames.push(shape);
  }
  return frames;
}
