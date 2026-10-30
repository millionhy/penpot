// The freehand path tool (第2项): the curve branch of the workspace
// drawing handlers.
//
// Ported from:
// - frontend/src/app/main/data/workspace/drawing/curve.cljs
//   (handle-drawing samples the pointer into a ::points list, finish-drawing
//   simplifies it and turns it into path content, then setup-frame and
//   handle-finish-drawing commit one add-shape);
// - frontend/src/app/util/path/path_impl_simplify.js (simplify, the
//   Ramer-Douglas-Peucker pass the CLJS runs with highest-quality true);
// - common/src/app/common/types/path.cljc (points->content and
//   calc-selrect);
// - common/src/app/common/types/shape.cljc (setup-path and
//   minimal-path-attrs: no fills, a 1px centered black stroke).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
//
// Deviations from the CLJS original, documented:
// - The points become straight line-to segments. The CLJS runs a curve fit
//   (path/smooth-points->content) after the simplify pass; the smoothed
//   control points wait for the pen-tool slice.
// - The sampled positions are the raw world points of the pointer events
//   (one per move) instead of the CLJS 10 ms mouse stream.

import { PathData, type PathSegmentSpec } from "@/lib/transit";
import { IDENTITY_TRANSFORM, type WorkspaceShape } from "@/lib/workspace";
import type { DrawPoint, DrawRect } from "@/lib/workspace-draw";

// drawing/curve.cljs simplify-tolerance.
export const CURVE_SIMPLIFY_TOLERANCE = 0.3;

// grc/make-rect clamps both sides to 0.01.
const MIN_SIZE = 0.01;

// A path needs a start point and at least one end point; the CLJS
// finish-drawing marks the shape uninitialized below that, and
// handle-finish-drawing then commits nothing.
const MIN_POINTS = 2;

// shape.cljc minimal-path-attrs: paths use a centered 1px black stroke and
// no fill (clr/black is #000000).
const PATH_STROKE = {
  "stroke-style": "solid",
  "stroke-alignment": "center",
  "stroke-width": 1,
  "stroke-color": "#000000",
  "stroke-opacity": 1,
} as const;

// getSqSegDist: the squared distance from `p` to the segment p1-p2.
function sqSegDist(p: DrawPoint, p1: DrawPoint, p2: DrawPoint): number {
  let x = p1.x;
  let y = p1.y;
  let dx = p2.x - x;
  let dy = p2.y - y;

  if (dx !== 0 || dy !== 0) {
    const t = ((p.x - x) * dx + (p.y - y) * dy) / (dx * dx + dy * dy);
    if (t > 1) {
      x = p2.x;
      y = p2.y;
    } else if (t > 0) {
      x += dx * t;
      y += dy * t;
    }
  }

  dx = p.x - x;
  dy = p.y - y;
  return dx * dx + dy * dy;
}

function simplifyDPStep(
  points: readonly DrawPoint[],
  first: number,
  last: number,
  sqTolerance: number,
  simplified: DrawPoint[],
): void {
  let maxSqDist = sqTolerance;
  let index = -1;
  for (let i = first + 1; i < last; i++) {
    const sqDist = sqSegDist(points[i], points[first], points[last]);
    if (sqDist > maxSqDist) {
      index = i;
      maxSqDist = sqDist;
    }
  }

  if (maxSqDist > sqTolerance) {
    if (index - first > 1) simplifyDPStep(points, first, index, sqTolerance, simplified);
    simplified.push(points[index]);
    if (last - index > 1) simplifyDPStep(points, index, last, sqTolerance, simplified);
  }
}

// simplify (highest-quality branch): Ramer-Douglas-Peucker over the whole
// polyline. Two points or fewer pass through untouched, like the original.
export function simplifyPoints(
  points: readonly DrawPoint[],
  tolerance: number = CURVE_SIMPLIFY_TOLERANCE,
): DrawPoint[] {
  if (points.length <= 2) return [...points];
  const sqTolerance = tolerance * tolerance;
  const simplified: DrawPoint[] = [points[0]];
  simplifyDPStep(points, 0, points.length - 1, sqTolerance, simplified);
  simplified.push(points[points.length - 1]);
  return simplified;
}

// path/points->content: a move-to for the first point and one line-to per
// following point.
export function pathSegmentsFromPoints(points: readonly DrawPoint[]): PathSegmentSpec[] {
  const segments: PathSegmentSpec[] = [];
  points.forEach((point, index) => {
    segments.push(
      index === 0
        ? { command: "move-to", x: point.x, y: point.y }
        : { command: "line-to", x: point.x, y: point.y },
    );
  });
  return segments;
}

// path/calc-selrect over the line-to content: the bounding box of the
// points, with the 0.01 floor of grc/make-rect. A malformed point (NaN)
// poisons the box like the CLJS min/max fold does, so the caller can drop
// the shape by checking the result.
export function pointsRect(points: readonly DrawPoint[]): DrawRect | null {
  if (points.length === 0) return null;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of points) {
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  return {
    x: minX,
    y: minY,
    width: Math.max(maxX - minX, MIN_SIZE),
    height: Math.max(maxY - minY, MIN_SIZE),
  };
}

// grc/rect->points: the four corners, clockwise from the top left. The line
// tools build their `points` the same way.
export function rectPoints(rect: DrawRect): DrawPoint[] {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return [
    { x: rect.x, y: rect.y },
    { x: x2, y: rect.y },
    { x: x2, y: y2 },
    { x: rect.x, y: y2 },
  ];
}

// cts/setup-path over the simplified drawing: the packed content, the
// selrect of that content and the four rect corners as `points`. Answers
// null when the drawing has fewer than two points (the CLJS marks the shape
// uninitialized and commits nothing).
export function createCurveShape(
  rawPoints: readonly DrawPoint[],
  parentId: string,
  id: string,
): WorkspaceShape | null {
  const simplified = simplifyPoints(rawPoints);
  if (simplified.length < MIN_POINTS) return null;
  const rect = pointsRect(simplified);
  if (rect === null) return null;
  const content = PathData.fromSegments(pathSegmentsFromPoints(simplified));
  return {
    id,
    type: "path",
    name: "Path",
    "parent-id": parentId,
    "frame-id": parentId,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    selrect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      x1: rect.x,
      y1: rect.y,
      x2: rect.x + rect.width,
      y2: rect.y + rect.height,
    },
    points: rectPoints(rect),
    content,
    transform: { ...IDENTITY_TRANSFORM },
    "transform-inverse": { ...IDENTITY_TRANSFORM },
    rotation: 0,
    proportion: 1,
    "proportion-lock": false,
    fills: [],
    strokes: [{ ...PATH_STROKE }],
    "grow-type": "fixed",
  };
}
