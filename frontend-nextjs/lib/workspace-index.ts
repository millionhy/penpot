// Workspace hit-testing index (F9.2). Headless port of the worker selection
// index used by the CLJS workspace: create-index/query-index of
// frontend/src/app/worker/selection.cljs, the quadtree of
// frontend/src/app/util/quadtree.js and the intersect geometry they call.
// Runs entirely on the plain objects lib/workspace decodes (see
// lib/transit.ts), so vitest exercises it without the CLJS runtime.
//
// Ported from (read-only references):
// - frontend/src/app/util/quadtree.js (create/insert/search/remove-all)
// - frontend/src/app/worker/selection.cljs (padding-percent, index-shape,
//   objects-bounds, add-padding-bounds, create-index, query-index)
// - common/src/app/common/files/{indices,helpers}.cljc
// - common/src/app/common/geom/{rect,point,matrix}.cljc
// - common/src/app/common/geom/shapes/{intersect,text,common,transforms}.cljc
// - common/src/app/common/types/path/{segment,helpers}.cljc
//
// The T1 probe found overlaps?/rect-contains-shape?/overlaps-path?/
// shape->bounds and the files.indices builders inlined away (absent from
// $APP), so everything here is the small TS port announced by the plan.
//
// Deviations from the CLJS original, documented:
// - qdt/remove (which only walked the top node, so it silently dropped the
//   split subtrees) is not ported; only remove-all is, which is what both
//   CLJS update paths call.
// - create-index assumes every shape has :points; shapes with no computable
//   bounds are skipped here instead of crashing.
// - add-padding-bounds also updates the x1/y1/x2/y2 corner fields and keeps
//   :y unchanged (only :y1/:y2 are padded); the four geometry fields
//   reproduce the resulting quadtree bounds faithfully, y quirk included.
// - an empty page falls back to the make-rect default bounds
//   {0, 0, 0.01, 0.01} instead of failing on nil bounds.
// - overlaps-ellipse? keeps the original quirk: the CLJS writes
//   :transform-inverse into the ellipse data but the readers destructure
//   :transform, so no transform is ever applied. This port reproduces the
//   reader side: with no transform in the data the ellipse math runs on the
//   raw coordinates.
// - path->lines is a full port (curve->lines with 10 segments), not an
//   approximation; the "simple?" bbox fallback for paths over 100 segments
//   matches the CLJS.
// - quadtree remove-all rebuilds the tree exactly like the CLJS (searching
//   the whole bounds and re-inserting), so the node order is preserved.
// - the get-immediate-children invalid-geometry? filter is reproduced with
//   the js/isNaN coercion (nil-valued keys are NaN-checked as false).
// - viewportRect/shapesRect/pointsToRect/rectCenter are reused from
//   lib/workspace-viewport (same CLJS primitives).

import { ZERO_UUID } from "@/lib/file-data";
import { isPathData, type PathSegment } from "@/lib/transit";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import {
  pointsToRect,
  rectCenter,
  shapesRect,
  type ViewportPoint,
  type ViewportRect,
} from "@/lib/workspace-viewport";

export type Bounds = ViewportRect;
export type Point = ViewportPoint;

// --- Small helpers ----------------------------------------------------------

// cljs arithmetic reads nil as 0 (JS null in arithmetic); missing or null
// numeric fields coerce the same way.
function num(value: unknown): number {
  if (typeof value === "number") return value;
  return value === null || value === undefined ? 0 : Number(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isNonEmptyArray(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

function hasOwn(value: unknown, key: string): boolean {
  return (
    value !== null &&
    value !== undefined &&
    (typeof value === "object" || typeof value === "string") &&
    Object.prototype.hasOwnProperty.call(value, key)
  );
}

// almost-zero? in app.common.math.
function isAlmostZero(value: number): boolean {
  return Math.abs(value) < 1e-4;
}

// js/isNaN coercion: nil (null here) reads as 0 like the cljs nil.
function nanLike(value: unknown): boolean {
  if (value === null || value === undefined) return false;
  return Number.isNaN(Number(value));
}

// --- Rect primitives (app.common.geom.rect) ---------------------------------

function isBoundsLike(value: unknown): value is Bounds {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const rect = value as Record<string, unknown>;
  return (
    isFiniteNumber(rect["x"]) &&
    isFiniteNumber(rect["y"]) &&
    isFiniteNumber(rect["width"]) &&
    isFiniteNumber(rect["height"])
  );
}

// make-rect (4-arity): non-numeric fields fall back to the 0.01 default rect
// and width/height are floored at 0.01.
function makeRect(x: number, y: number, width: number, height: number): Bounds {
  if (
    isFiniteNumber(x) &&
    isFiniteNumber(y) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height)
  ) {
    return { x, y, width: Math.max(width, 0.01), height: Math.max(height, 0.01) };
  }
  return { x: 0, y: 0, width: 0.01, height: 0.01 };
}

// rect->points: the four corners, nil when x/y are not numeric (d/num?).
function rectToPoints(rect: Bounds | null | undefined): Point[] | null {
  if (rect === null || rect === undefined) return null;
  const x = num(rect.x);
  const y = num(rect.y);
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  const w = Math.max(num(rect.width), 0.01);
  const h = Math.max(num(rect.height), 0.01);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

// rect->center with the d/num? guard (returns null for non-numeric rects).
function rectCenterChecked(rect: unknown): Point | null {
  if (!isBoundsLike(rect)) return null;
  return rectCenter(rect);
}

// center->rect: nil when any field is not numeric (d/num?); the callers
// never hit it for valid shapes, the make-rect default is the fallback.
function centerToRect(center: Point, width: number, height: number): Bounds {
  if (
    isFiniteNumber(center.x) &&
    isFiniteNumber(center.y) &&
    isFiniteNumber(width) &&
    isFiniteNumber(height)
  ) {
    return makeRect(center.x - width / 2, center.y - height / 2, width, height);
  }
  return { x: 0, y: 0, width: 0.01, height: 0.01 };
}

// --- Matrix helpers (app.common.geom.matrix/point) --------------------------

interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

// gmt/matrix? for the transit-decoded plain values: the CLJS works with
// Matrix records, the shell with the same six numeric fields.
function isMatrixValue(value: unknown): value is Matrix {
  if (value === null || value === undefined || typeof value !== "object") return false;
  const m = value as Record<string, unknown>;
  return (
    isFiniteNumber(m["a"]) &&
    isFiniteNumber(m["b"]) &&
    isFiniteNumber(m["c"]) &&
    isFiniteNumber(m["d"]) &&
    isFiniteNumber(m["e"]) &&
    isFiniteNumber(m["f"])
  );
}

function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

function translationMatrix(x: number, y: number): Matrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

// gpt/transform: x' = a*x + c*y + e, y' = b*x + d*y + f.
function transformPoint(p: Point, m: Matrix): Point {
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
}

// gco/transform-points with a center: mtx = T(center) M T(-center).
function transformPointsWithCenter(
  points: readonly Point[],
  center: Point | null | undefined,
  matrix: unknown,
): Point[] {
  if (!isMatrixValue(matrix) || points.length === 0) return [...points];
  let mtx = matrix;
  if (center !== null && center !== undefined) {
    mtx = multiplyMatrices(
      multiplyMatrices(translationMatrix(center.x, center.y), matrix),
      translationMatrix(-center.x, -center.y),
    );
  }
  return points.map((point) => transformPoint(point, mtx));
}

// gmt/transform-in: T(pt) M T(-pt).
function transformIn(point: Point, matrix: Matrix): Matrix {
  return multiplyMatrices(
    multiplyMatrices(translationMatrix(point.x, point.y), matrix),
    translationMatrix(-point.x, -point.y),
  );
}

// gtr/transform-matrix: T(center) M T(-center) around the shape center
// (origin when the selrect is not numeric); a missing transform reads as the
// unit matrix.
function shapeTransformMatrix(shape: WorkspaceShape): Matrix {
  const center = shapeCenter(shape) ?? { x: 0, y: 0 };
  let mtx = translationMatrix(center.x, center.y);
  const transform = shape["transform"];
  if (isMatrixValue(transform)) mtx = multiplyMatrices(mtx, transform);
  return multiplyMatrices(mtx, translationMatrix(-center.x, -center.y));
}

// gco/shape->center: the center of the selrect, nil when it is not numeric.
function shapeCenter(shape: WorkspaceShape): Point | null {
  return rectCenterChecked(shape.selrect);
}

// --- Quadtree (frontend/src/app/util/quadtree.js) ---------------------------

export interface QuadtreeNode<D> {
  id: string;
  bounds: Bounds;
  data: D;
}

export interface Quadtree<D> {
  maxObjects: number;
  maxLevels: number;
  level: number;
  bounds: Bounds;
  objects: QuadtreeNode<D>[];
  indexes: Quadtree<D>[];
}

export function createQuadtree<D>(bounds: Bounds): Quadtree<D> {
  return { maxObjects: 10, maxLevels: 4, level: 0, bounds, objects: [], indexes: [] };
}

function quadtreeSplit<D>(tree: Quadtree<D>): void {
  const nextLevel = tree.level + 1;
  const subWidth = tree.bounds.width / 2;
  const subHeight = tree.bounds.height / 2;
  const x = tree.bounds.x;
  const y = tree.bounds.y;
  const level = (bounds: Bounds): Quadtree<D> => ({
    maxObjects: tree.maxObjects,
    maxLevels: tree.maxLevels,
    level: nextLevel,
    bounds,
    objects: [],
    indexes: [],
  });
  tree.indexes[0] = level({ x: x + subWidth, y, width: subWidth, height: subHeight });
  tree.indexes[1] = level({ x, y, width: subWidth, height: subHeight });
  tree.indexes[2] = level({ x, y: y + subHeight, width: subWidth, height: subHeight });
  tree.indexes[3] = level({
    x: x + subWidth,
    y: y + subHeight,
    width: subWidth,
    height: subHeight,
  });
}

function quadtreeIndexesFor<D>(tree: Quadtree<D>, rect: Bounds): Quadtree<D>[] {
  const verticalMidpoint = tree.bounds.x + tree.bounds.width / 2;
  const horizontalMidpoint = tree.bounds.y + tree.bounds.height / 2;

  const startIsNorth = rect.y < horizontalMidpoint;
  const startIsWest = rect.x < verticalMidpoint;
  const endIsEast = rect.x + rect.width > verticalMidpoint;
  const endIsSouth = rect.y + rect.height > horizontalMidpoint;

  const out: Quadtree<D>[] = [];
  if (startIsNorth && endIsEast) out.push(tree.indexes[0]);
  if (startIsWest && startIsNorth) out.push(tree.indexes[1]);
  if (startIsWest && endIsSouth) out.push(tree.indexes[2]);
  if (endIsEast && endIsSouth) out.push(tree.indexes[3]);
  return out;
}

function quadtreeInsertNode<D>(tree: Quadtree<D>, node: QuadtreeNode<D>): void {
  if (tree.indexes.length > 0) {
    for (const index of quadtreeIndexesFor(tree, node.bounds)) {
      quadtreeInsertNode(index, node);
    }
  } else {
    tree.objects.push(node);

    if (tree.objects.length > tree.maxObjects && tree.level < tree.maxLevels) {
      if (tree.indexes.length === 0) quadtreeSplit(tree);
      for (const object of tree.objects) {
        for (const index of quadtreeIndexesFor(tree, object.bounds)) {
          quadtreeInsertNode(index, object);
        }
      }
      tree.objects = [];
    }
  }
}

export function quadtreeInsert<D>(
  tree: Quadtree<D>,
  id: string,
  bounds: Bounds,
  data: D,
): Quadtree<D> {
  quadtreeInsertNode(tree, { id, bounds, data });
  return tree;
}

function quadtreeCollect<D>(
  tree: Quadtree<D>,
  rect: Bounds,
  out: QuadtreeNode<D>[],
  seen: Set<QuadtreeNode<D>>,
): void {
  if (tree.indexes.length === 0) {
    for (const object of tree.objects) {
      if (!seen.has(object)) {
        seen.add(object);
        out.push(object);
      }
    }
  } else {
    for (const index of quadtreeIndexesFor(tree, rect)) {
      quadtreeCollect(index, rect, out, seen);
    }
  }
}

// qdt/search: every node that may overlap the rect (the caller still has to
// run the precise overlap check); nodes living in several quadrants are
// yielded only once.
export function quadtreeSearch<D>(tree: Quadtree<D>, rect: Bounds): QuadtreeNode<D>[] {
  const out: QuadtreeNode<D>[] = [];
  quadtreeCollect(tree, rect, out, new Set());
  return out;
}

// qdt/count: sums the leaf objects; a node straddling a split boundary lives
// in every matching quadrant, so it is counted once per copy (CLJS behaviour,
// the callers never use it as a unique-object count).
export function quadtreeCount<D>(tree: Quadtree<D>): number {
  if (tree.indexes.length === 0) return tree.objects.length;
  let sum = 0;
  for (const index of tree.indexes) sum += quadtreeCount(index);
  return sum;
}

export function quadtreeClear<D>(tree: Quadtree<D>): Quadtree<D> {
  tree.objects = [];
  tree.indexes = [];
  return tree;
}

// qdt/remove-all: rebuilds the tree without the given ids (the CLJS FIXME
// about the inefficiency is inherited on purpose).
export function quadtreeRemoveAll<D>(tree: Quadtree<D>, ids: Iterable<string>): Quadtree<D> {
  const excluded = new Set(ids);
  const result = createQuadtree<D>(tree.bounds);
  for (const node of quadtreeSearch(tree, tree.bounds)) {
    if (!excluded.has(node.id)) {
      quadtreeInsert(result, node.id, node.bounds, node.data);
    }
  }
  return result;
}

// --- Shape predicates (app.common.files.helpers) ----------------------------

function isFrameShape(shape: WorkspaceShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape.type === "frame";
}

function isBoolShape(shape: WorkspaceShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape.type === "bool";
}

function isTextShape(shape: WorkspaceShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape.type === "text";
}

function isPathShape(shape: WorkspaceShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape.type === "path";
}

function isCircleShape(shape: WorkspaceShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && shape.type === "circle";
}

// cfh/root-frame? (shape arity): a frame whose frame-id is the root.
function isRootFrame(shape: WorkspaceShape): boolean {
  return (
    shape.id !== ZERO_UUID && shape.type === "frame" && shape["frame-id"] === ZERO_UUID
  );
}

// --- Intersect geometry (app.common.geom.shapes.intersect) ------------------

type Line = [Point, Point];

type Orientation = "cw" | "ccw" | "coplanar";

function orientation(p1: Point, p2: Point, p3: Point): Orientation {
  const value = (p2.y - p1.y) * (p3.x - p2.x) - (p3.y - p2.y) * (p2.x - p1.x);
  if (value > 0) return "cw";
  if (value < 0) return "ccw";
  return "coplanar";
}

function onSegment(q: Point, p: Point, r: Point): boolean {
  return (
    q.x <= Math.max(p.x, r.x) &&
    q.x >= Math.min(p.x, r.x) &&
    q.y <= Math.max(p.y, r.y) &&
    q.y >= Math.min(p.y, r.y)
  );
}

function intersectSegments([first, second]: [Line, Line]): boolean {
  const [p1, q1] = first;
  const [p2, q2] = second;
  const o1 = orientation(p1, q1, p2);
  const o2 = orientation(p1, q1, q2);
  const o3 = orientation(p2, q2, p1);
  const o4 = orientation(p2, q2, q1);

  return (
    (o1 !== o2 && o3 !== o4) ||
    (o1 === "coplanar" && onSegment(p2, p1, q1)) ||
    (o2 === "coplanar" && onSegment(q2, p1, q1)) ||
    (o3 === "coplanar" && onSegment(p1, p2, q2)) ||
    (o4 === "coplanar" && onSegment(q1, p2, q2))
  );
}

// points->lines (closed): the polygon edges of a point list.
function pointsToLines(points: readonly Point[]): Line[] {
  const lines: Line[] = [];
  for (let index = 0; index < points.length; index += 1) {
    const next = index + 1 < points.length ? points[index + 1] : points[0];
    lines.push([points[index], next]);
  }
  return lines;
}

function intersectsLines(linesA: readonly Line[], linesB: readonly Line[]): boolean {
  for (const lineA of linesA) {
    for (const lineB of linesB) {
      if (intersectSegments([lineA, lineB])) return true;
    }
  }
  return false;
}

function intersectRay({ x: px, y: py }: Point, [p1, p2]: Line): boolean {
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;
  if ((y1 <= py && y2 > py) || (y1 > py && y2 <= py)) {
    const vt = (py - y1) / (y2 - y1);
    const ix = x1 + vt * (x2 - x1);
    return px < ix;
  }
  return false;
}

function isPointInsideEvenOdd(p: Point, lines: readonly Line[]): boolean {
  let count = 0;
  for (const line of lines) {
    if (intersectRay(p, line)) count += 1;
  }
  return count % 2 === 1;
}

function nextWindup(wn: number, { x: px, y: py }: Point, [p1, p2]: Line): number {
  const { x: x1, y: y1 } = p1;
  const { x: x2, y: y2 } = p2;
  const lineSide = (x2 - x1) * (py - y1) - (px - x1) * (y2 - y1);
  if (y1 <= py) {
    // Upward crossing.
    return y2 > py && lineSide > 0 ? wn + 1 : wn;
  }
  // Downward crossing.
  return y2 <= py && lineSide < 0 ? wn - 1 : wn;
}

function isPointInsideNonzero(p: Point, lines: readonly Line[]): boolean {
  let wn = 0;
  for (const line of lines) wn = nextWindup(wn, p, line);
  return wn !== 0;
}

function overlapsRectPoints(rect: Bounds, points: readonly Point[]): boolean {
  const rectPoints = rectToPoints(rect) ?? [];
  const rectLines = pointsToLines(rectPoints);
  const pointsLines = pointsToLines(points);

  if (rectPoints.length > 0 && isPointInsideEvenOdd(rectPoints[0], pointsLines)) return true;
  if (points.length > 0 && isPointInsideEvenOdd(points[0], rectLines)) return true;
  return intersectsLines(rectLines, pointsLines);
}

// rect->lines of the rect (nil for a non-numeric rect, read as no lines).
function rectToLines(rect: Bounds): Line[] {
  const points = rectToPoints(rect);
  return points === null ? [] : pointsToLines(points);
}

// gsh/rect-contains-shape?: every point of the shape inside the rect (a shape
// without points is contained, like (every? f nil) => true).
export function rectContainsShape(rect: Bounds, shape: WorkspaceShape): boolean {
  const points = shape.points;
  if (!Array.isArray(points)) return true;
  const lines = rectToLines(rect);
  return points.every((point) => isPointInsideEvenOdd(point, lines));
}

// --- Path geometry (types/path/{segment,helpers}) ---------------------------

const CURVE_NUM_SEGMENTS = 10;

// helpers/curve-values: cubic bezier (Bernstein form) at t.
function curveValues(start: Point, end: Point, h1: Point, h2: Point, t: number): Point {
  const t2 = t * t;
  const t3 = t2 * t;

  const startV = -t3 + 3 * t2 - 3 * t + 1;
  const h1V = 3 * t3 - 6 * t2 + 3 * t;
  const h2V = -3 * t3 + 3 * t2;
  const endV = t3;

  return {
    x: start.x * startV + h1.x * h1V + h2.x * h2V + end.x * endV,
    y: start.y * startV + h1.y * h1V + h2.y * h2V + end.y * endV,
  };
}

// helpers/curve->lines: the bezier approximated by 10 straight segments.
function curveToLines(start: Point, end: Point, h1: Point, h2: Point): Line[] {
  const offset = 1 / CURVE_NUM_SEGMENTS;
  const lines: Line[] = [];
  let from = 0;
  for (;;) {
    const to = Math.min(1, from + offset);
    lines.push([curveValues(start, end, h1, h2, from), curveValues(start, end, h1, h2, to)]);
    if (to >= 1) return lines;
    from = to;
  }
}

// The packed content of lib/transit (PathData); other shapes carry no path.
function contentSegments(content: unknown): PathSegment[] {
  return isPathData(content) ? content.toSegments() : [];
}

// path->lines: the polyline approximating the path content. Lines with a nil
// endpoint (a malformed leading segment) are dropped: the CLJS keeps them but
// they never intersect (NaN comparisons), so the result is the same.
function pathToLines(segments: readonly PathSegment[]): Line[] {
  const lines: Line[] = [];
  let lastStart: Point | null = null;
  let prevPoint: Point | null = null;

  for (const segment of segments) {
    const point: Point =
      segment.command === "close-path"
        ? (lastStart ?? { x: 0, y: 0 })
        : { x: num(segment.params["x"]), y: num(segment.params["y"]) };

    if (segment.command === "line-to" && prevPoint !== null) {
      lines.push([prevPoint, point]);
    } else if (segment.command === "curve-to" && prevPoint !== null) {
      const h1 = { x: num(segment.params["c1x"]), y: num(segment.params["c1y"]) };
      const h2 = { x: num(segment.params["c2x"]), y: num(segment.params["c2y"]) };
      lines.push(...curveToLines(prevPoint, point, h1, h2));
    } else if (segment.command === "move-to" && lastStart !== null && prevPoint !== null) {
      lines.push([prevPoint, lastStart]);
    }

    if (segment.command === "move-to") lastStart = point;
    prevPoint = point;
  }

  if (prevPoint !== null && lastStart !== null) lines.push([prevPoint, lastStart]);
  return lines;
}

// gsh/overlaps-path?: the rect against the path polyline (with the bbox
// fallback for paths over 100 segments).
function overlapsPath(
  shape: WorkspaceShape,
  rect: Bounds,
  includeContent: boolean,
): boolean {
  const segments = contentSegments(shape["content"]);
  if (segments.length === 0) return false;

  const simple = segments.length > 100;
  const rectPoints = rectToPoints(rect) ?? [];
  const rectLines = pointsToLines(rectPoints);
  const pathLines = simple
    ? pointsToLines(Array.isArray(shape.points) ? shape.points : [])
    : pathToLines(segments);

  if (intersectsLines(rectLines, pathLines)) return true;
  if (!includeContent) return false;

  const first = segments[0];
  const startPoint: Point = {
    x: num(first?.params["x"]),
    y: num(first?.params["y"]),
  };
  if (rectPoints.length > 0 && isPointInsideNonzero(rectPoints[0], pathLines)) return true;
  return isPointInsideNonzero(startPoint, rectLines);
}

// --- Ellipse geometry -------------------------------------------------------

interface EllipseData {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  // Quirk: the CLJS ellipse data carries :transform-inverse but the readers
  // destructure :transform, so no transform is ever applied. This field is
  // what the readers actually see (nil); it is kept so the ported math is
  // explicit about the reader side.
  transform?: Matrix;
}

function isPointInsideEllipse(
  point: Point,
  ellipse: EllipseData,
): boolean {
  const center = { x: ellipse.cx, y: ellipse.cy };
  const transform = ellipse.transform;
  const mtx = transform !== undefined ? transformIn(center, transform) : undefined;
  const p = mtx !== undefined ? transformPoint(point, mtx) : point;
  const value =
    ((p.x - ellipse.cx) ** 2) / (ellipse.rx ** 2) +
    ((p.y - ellipse.cy) ** 2) / (ellipse.ry ** 2);
  return value <= 1;
}

function intersectsLineEllipse(
  [first, second]: Line,
  ellipse: EllipseData,
): boolean {
  const { x: x1, y: y1 } = first;
  const { x: x2, y: y2 } = second;
  const { cx, cy, rx, ry } = ellipse;

  const a =
    ((x2 - x1) ** 2) / (rx ** 2) + ((y2 - y1) ** 2) / (ry ** 2);
  const b =
    (2 * x1 * (x2 - x1) - 2 * cx * (x2 - x1)) / (rx ** 2) +
    (2 * y1 * (y2 - y1) - 2 * cy * (y2 - y1)) / (ry ** 2);
  const c =
    (x1 ** 2 + cx ** 2 - 2 * x1 * cx) / (rx ** 2) +
    (y1 ** 2 + cy ** 2 - 2 * y1 * cy) / (ry ** 2) -
    1;

  // B^2 - 4AC.
  const determ = b ** 2 - 4 * a * c;

  if (isAlmostZero(a)) {
    if (isAlmostZero(b)) return false;
    const t = -c / b;
    return t >= 0 && t <= 1;
  }
  if (determ >= 0) {
    const root = Math.sqrt(determ);
    const t1 = (-b + root) / (2 * a);
    const t2 = (-b - root) / (2 * a);
    return (t1 >= 0 && t1 <= 1) || (t2 >= 0 && t2 <= 1);
  }
  return false;
}

function intersectsLinesEllipse(
  lines: readonly Line[],
  ellipse: EllipseData,
): boolean {
  const center = { x: ellipse.cx, y: ellipse.cy };
  const transform = ellipse.transform;
  const mtx = transform !== undefined ? transformIn(center, transform) : undefined;
  for (const [p1, p2] of lines) {
    const first = mtx !== undefined ? transformPoint(p1, mtx) : p1;
    const second = mtx !== undefined ? transformPoint(p2, mtx) : p2;
    if (intersectsLineEllipse([first, second], ellipse)) return true;
  }
  return false;
}

// gsh/overlaps-ellipse?: the shape's x/y/width/height ellipse against the
// rect (no transform applied, see the EllipseData quirk).
function overlapsEllipse(shape: WorkspaceShape, rect: Bounds): boolean {
  const rectPoints = rectToPoints(rect) ?? [];
  const rectLines = pointsToLines(rectPoints);

  const x = num(shape["x"]);
  const y = num(shape["y"]);
  const width = num(shape["width"]);
  const height = num(shape["height"]);
  const center = { x: x + width / 2, y: y + height / 2 };

  const ellipse: EllipseData = {
    cx: center.x,
    cy: center.y,
    rx: width / 2,
    ry: height / 2,
  };

  if (rectPoints.length > 0 && isPointInsideEvenOdd(center, rectLines)) return true;
  if (rectPoints.length > 0 && isPointInsideEllipse(rectPoints[0], ellipse)) return true;
  return intersectsLinesEllipse(rectLines, ellipse);
}

// --- Text overlaps (gsh/overlaps-text?) -------------------------------------

// position-data->rect: y - height (the data stores the baseline-ish bottom).
function positionDataRect(entry: unknown): Bounds {
  const data = (entry ?? {}) as Record<string, unknown>;
  return makeRect(
    num(data["x"]),
    num(data["y"]) - num(data["height"]),
    num(data["width"]),
    num(data["height"]),
  );
}

function overlapsText(shape: WorkspaceShape, rect: Bounds): boolean {
  const positionData = shape["position-data"];
  if (isNonEmptyArray(positionData)) {
    const center = shapeCenter(shape);
    const transform = shape["transform"];
    return positionData.some((entry) => {
      const rectPoints = rectToPoints(positionDataRect(entry));
      if (rectPoints === null) return false;
      const points = transformPointsWithCenter(rectPoints, center, transform);
      return overlapsRectPoints(rect, points);
    });
  }
  return overlapsRectPoints(rect, Array.isArray(shape.points) ? shape.points : []);
}

// --- General overlaps (gsh/overlaps?) ---------------------------------------

function overlapsGeneral(shape: WorkspaceShape | null | undefined, rect: Bounds): boolean {
  if (shape === null || shape === undefined) return true;

  // The half stroke width widens the query rect before the check.
  const swidth = num(shape["stroke-width"]) / 2;
  const expanded: Bounds = {
    x: rect.x - swidth,
    y: rect.y - swidth,
    width: rect.width + 2 * swidth,
    height: rect.height + 2 * swidth,
  };
  const points = Array.isArray(shape.points) ? shape.points : [];

  if (isPathShape(shape) || isBoolShape(shape)) {
    return overlapsRectPoints(expanded, points) && overlapsPath(shape, expanded, true);
  }
  if (isCircleShape(shape)) {
    return overlapsRectPoints(expanded, points) && overlapsEllipse(shape, expanded);
  }
  if (isTextShape(shape)) {
    return overlapsText(shape, expanded);
  }
  return overlapsRectPoints(expanded, points);
}

// --- Ring overlaps (worker-selection local overlaps?) -----------------------

// The stroke padding of a shape: center strokes pad by their width, outer
// ones by the double for the outer ring and by zero for the inner one
// (swapped for the inner ring).
function strokeRingPadding(shape: WorkspaceShape, alignment: "outer" | "inner"): number {
  const strokes = shape["strokes"];
  let padding = 0;
  if (Array.isArray(strokes)) {
    for (const stroke of strokes) {
      const entry = (stroke ?? {}) as Record<string, unknown>;
      const strokeAlignment = entry["stroke-alignment"] ?? "center";
      const strokeWidth = num(entry["stroke-width"]);
      let value: number;
      if (strokeAlignment === "center") value = strokeWidth;
      else if (strokeAlignment === alignment) value = 2 * strokeWidth;
      else value = 0;
      padding = Math.max(padding, value);
    }
  }
  return padding;
}

// gco/points->center: the center of the points bounding box.
function pointsCenter(points: readonly Point[]): Point {
  let minx = Infinity;
  let miny = Infinity;
  let maxx = -Infinity;
  let maxy = -Infinity;
  for (const point of points) {
    minx = Math.min(minx, point.x);
    miny = Math.min(miny, point.y);
    maxx = Math.max(maxx, point.x);
    maxy = Math.max(maxy, point.y);
  }
  return { x: (minx + maxx) / 2, y: (miny + maxy) / 2 };
}

// The scaled view of a shape: what transform-shape with a resize modifier
// around the shape center leaves behind for the overlap readers — the scaled
// points and the recalculated selrect/x/y/width/height (calculate-selrect
// keeps the bounding center and the rotated-edge lengths). The new
// transform/transform-inverse/rotation are never read by the ring checks, so
// they are not recomputed.
function scaleShapeView(
  shape: WorkspaceShape,
  scaleX: number,
  scaleY: number,
): WorkspaceShape | null {
  const center = shapeCenter(shape);
  const points = shape.points;
  if (center === null || !Array.isArray(points) || points.length < 4) return null;

  const scaledPoints: Point[] = points.map((point) => ({
    x: center.x + (point.x - center.x) * scaleX,
    y: center.y + (point.y - center.y) * scaleY,
  }));
  const bboxCenter = pointsCenter(scaledPoints);
  const p0 = scaledPoints[0];
  const p1 = scaledPoints[1];
  const p3 = scaledPoints[3];
  const width = Math.hypot(p1.x - p0.x, p1.y - p0.y);
  const height = Math.hypot(p0.x - p3.x, p0.y - p3.y);
  const selrect = centerToRect(bboxCenter, width, height);

  return {
    ...shape,
    points: scaledPoints,
    selrect,
    x: selrect.x,
    y: selrect.y,
    width: selrect.width,
    height: selrect.height,
  };
}

function overlapsOuterShape(shape: WorkspaceShape, rect: Bounds): boolean {
  const padding = strokeRingPadding(shape, "outer");
  const width = num(shape["width"]);
  const height = num(shape["height"]);
  const view = scaleShapeView(shape, (width + padding) / width, (height + padding) / height);
  if (view === null) return false;
  return overlapsGeneral(view, rect);
}

function overlapsInnerShape(shape: WorkspaceShape, rect: Bounds): boolean {
  const padding = strokeRingPadding(shape, "inner");
  const width = num(shape["width"]);
  const height = num(shape["height"]);
  const view = scaleShapeView(shape, (width - padding) / width, (height - padding) / height);
  if (view === null) return false;
  return overlapsGeneral(view, rect);
}

// The path probe of the worker: a small rect around the query center (the
// stroke width at least 5, capped by half the selrect) against the path.
function overlapsPathProbe(shape: WorkspaceShape, rect: Bounds): boolean {
  let padding = 5;
  const strokes = shape["strokes"];
  if (Array.isArray(strokes)) {
    for (const stroke of strokes) {
      const entry = (stroke ?? {}) as Record<string, unknown>;
      const strokeWidth = entry["stroke-width"];
      if (strokeWidth !== null && strokeWidth !== undefined) {
        padding = Math.max(padding, num(strokeWidth));
      }
    }
  }

  const selrect = isBoundsLike(shape.selrect) ? shape.selrect : null;
  const width = selrect?.width ?? 1;
  const height = selrect?.height ?? 1;
  padding = Math.min(padding, Math.max(width, height) / 2);

  const center = rectCenterChecked(rect);
  if (center === null) return false;
  const probe = makeRect(
    center.x - padding / 2,
    center.y - padding / 2,
    padding,
    padding,
  );
  return overlapsPath(shape, probe, false);
}

// The worker-local overlaps?: an unfilled (and svg-fill-less) shape is hit
// through its stroke ring (rect/circle), its path (bool/path) or the general
// check; using-selrect? disables the ring logic.
export function overlapsShape(
  shape: WorkspaceShape,
  rect: Bounds,
  usingSelrect = false,
): boolean {
  const svgAttrs = shape["svg-attrs"];
  const style =
    svgAttrs !== null && typeof svgAttrs === "object"
      ? (svgAttrs as Record<string, unknown>)["style"]
      : undefined;
  const noFills =
    !isNonEmptyArray(shape["fills"]) && !hasOwn(svgAttrs, "fill") && !hasOwn(style, "fill");

  if (usingSelrect === false && noFills) {
    if (shape.type === "rect" || shape.type === "circle") {
      return overlapsOuterShape(shape, rect) && !overlapsInnerShape(shape, rect);
    }
    if (shape.type === "bool" || shape.type === "path") {
      return overlapsPathProbe(shape, rect);
    }
  }
  return overlapsGeneral(shape, rect);
}

// --- Index construction (worker-selection create-index) ---------------------

const PADDING_PERCENT = 0.10;

// gco/invalid-geometry?: NaN-ish selrect fields or point coordinates.
function invalidGeometry(shape: WorkspaceShape): boolean {
  const selrect = shape.selrect as Record<string, unknown> | undefined;
  if (
    selrect !== undefined &&
    selrect !== null &&
    (nanLike(selrect["x"]) ||
      nanLike(selrect["y"]) ||
      nanLike(selrect["width"]) ||
      nanLike(selrect["height"]))
  ) {
    return true;
  }
  const points = shape.points;
  return (
    Array.isArray(points) &&
    points.some((point) => nanLike(point?.x) || nanLike(point?.y))
  );
}

// cfh/get-immediate-children of the root (default flags): the resolved
// children of the root, dropping the shapes with invalid geometry.
function rootChildren(objects: WorkspaceObjects): WorkspaceShape[] {
  const ids = objects[ZERO_UUID]?.shapes ?? [];
  const out: WorkspaceShape[] = [];
  for (const id of ids) {
    const child = objects[id];
    if (child === undefined || child === null) continue;
    if (!invalidGeometry(child)) out.push(child);
  }
  return out;
}

// cfi/generate-child-all-parents-index (whole objects, the 1-arity): every
// shape id (root included) mapped to its parent chain, nearest first.
export function generateChildAllParentsIndex(
  objects: WorkspaceObjects,
): Record<string, string[]> {
  const index: Record<string, string[]> = {};
  const walk = (id: string, parents: string[]): void => {
    index[id] = parents;
    const children = objects[id]?.shapes;
    if (children === undefined || children === null) return;
    const nextParents = [id, ...parents];
    for (const childId of children) walk(childId, nextParents);
  };
  walk(ZERO_UUID, []);
  return index;
}

// cfi/create-clip-index: for every shape, the ancestors that clip it — the
// root frame without show-content and the boolean operations among its
// parents, plus the mask shape of a masked group (a nil first child — an
// empty masked group — is skipped here; the CLJS keeps a nil that reads as
// always-overlapping, so the result is the same).
export function createClipIndex(
  objects: WorkspaceObjects,
  parentsIndex: Record<string, string[]>,
): Record<string, WorkspaceShape[]> {
  const clipParentsFor = (shape: WorkspaceShape | null | undefined): WorkspaceShape[] => {
    if (shape === null || shape === undefined) return [];
    const out: WorkspaceShape[] = [];
    if (
      (isFrameShape(shape) && !shape["show-content"] && shape.id !== ZERO_UUID) ||
      isBoolShape(shape)
    ) {
      out.push(shape);
    }
    if (shape["masked-group"]) {
      const firstChildId = (shape.shapes ?? [])[0];
      const firstChild = firstChildId === undefined ? undefined : objects[firstChildId];
      if (firstChild !== undefined) out.push(firstChild);
    }
    return out;
  };

  const out: Record<string, WorkspaceShape[]> = {};
  for (const [id, parents] of Object.entries(parentsIndex)) {
    const clipParents: WorkspaceShape[] = [];
    for (const parentId of parents) clipParents.push(...clipParentsFor(objects[parentId]));
    out[id] = clipParents;
  }
  return out;
}

// gst/shape->bounds: the position-data rects (y - height) through the shape
// transform matrix, or points->rect for every other shape.
export function shapeBounds(shape: WorkspaceShape): Bounds | null {
  const positionData = shape["position-data"];
  if (isTextShape(shape) && isNonEmptyArray(positionData)) {
    const points: Point[] = [];
    for (const entry of positionData) {
      const rectPoints = rectToPoints(positionDataRect(entry));
      if (rectPoints !== null) points.push(...rectPoints);
    }
    const matrix = shapeTransformMatrix(shape);
    const transformed = transformPointsWithCenter(points, null, matrix);
    return pointsToRect(transformed);
  }
  return pointsToRect(shape.points ?? null);
}

// worker-selection index-shape: insert one shape with its precomputed frame,
// clip parents and parents attached.
function indexShape(
  objects: WorkspaceObjects,
  parentsIndex: Record<string, string[]>,
  clipIndex: Record<string, WorkspaceShape[]>,
  quadtree: Quadtree<IndexEntry>,
  shape: WorkspaceShape,
): void {
  const bounds = shapeBounds(shape);
  // create-index assumes every shape has :points; shapes without computable
  // bounds (corrupt geometry) are skipped instead of crashing.
  if (bounds === null) return;

  const id = shape.id;
  const frameId = shape["frame-id"];
  const frame =
    shape.type !== "frame" && typeof frameId === "string" && frameId !== ZERO_UUID
      ? (objects[frameId] ?? null)
      : null;

  quadtreeInsert(quadtree, id, bounds, {
    id,
    bounds,
    shape,
    frame,
    clipParents: clipIndex[id] ?? [],
    parents: parentsIndex[id] ?? [],
  });
}

// add-padding-bounds: 10% of width/height added on both sides. The CLJS also
// updates the x1/y1/x2/y2 corner fields and keeps :y unchanged (only :y1 and
// :y2 are padded), so the quadtree top edge is the unpadded y; the four
// fields here reproduce exactly what the quadtree reads.
function paddingBounds(bounds: Bounds | null): Bounds {
  if (bounds === null) return { x: 0, y: 0, width: 0.01, height: 0.01 };
  const widthPad = bounds.width * PADDING_PERCENT;
  const heightPad = bounds.height * PADDING_PERCENT;
  return {
    x: bounds.x - widthPad,
    y: bounds.y,
    width: bounds.width + widthPad + widthPad,
    height: bounds.height + heightPad + heightPad,
  };
}

export interface IndexEntry {
  id: string;
  bounds: Bounds;
  shape: WorkspaceShape;
  // The resolved frame of the shape (nil for frames and top-level shapes).
  frame: WorkspaceShape | null;
  // The clipping ancestors of the shape (frames without show-content, bool
  // operations, mask shapes), nearest first.
  clipParents: WorkspaceShape[];
  // The parent chain of the shape, nearest first (root included).
  parents: string[];
}

export interface WorkspaceIndex {
  quadtree: Quadtree<IndexEntry>;
  bounds: Bounds;
  parentsIndex: Record<string, string[]>;
  clipIndex: Record<string, WorkspaceShape[]>;
}

// worker-selection create-index: the parents/clip indexes, the padded
// bounds of the root children and the quadtree with every shape (the root
// itself excluded) inserted.
export function createWorkspaceIndex(objects: WorkspaceObjects): WorkspaceIndex {
  const parentsIndex = generateChildAllParentsIndex(objects);
  const clipIndex = createClipIndex(objects, parentsIndex);
  const bounds = paddingBounds(shapesRect(rootChildren(objects)));
  const quadtree = createQuadtree<IndexEntry>(bounds);

  for (const id of Object.keys(objects)) {
    if (id === ZERO_UUID) continue;
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    indexShape(objects, parentsIndex, clipIndex, quadtree, shape);
  }

  return { quadtree, bounds, parentsIndex, clipIndex };
}

// --- Query (worker-selection query-index) -----------------------------------

export interface QuerySelectionOptions {
  // Only the shapes of this frame.
  frameId?: string | null;
  // Frames need to be fully contained (the CLJS full-frame? selection).
  fullFrame?: boolean;
  // Include the frames themselves in the result.
  includeFrames?: boolean;
  // Exclude groups and bools from the result.
  ignoreGroups?: boolean;
  // When false (the mod-key deep selection), the clipping of frames is
  // relaxed but bool/mask clips are still applied.
  clipChildren?: boolean;
  // Disable the stroke-ring hit logic and use the live geometry.
  usingSelrect?: boolean;
}

interface MatchOptions {
  frameId: string | null;
  fullFrame: boolean;
  includeFrames: boolean;
  ignoreGroups: boolean;
}

// worker-selection match-criteria? (using the general overlaps? in the
// full-frame branch, like the CLJS does).
function matchCriteria(shape: WorkspaceShape, rect: Bounds, options: MatchOptions): boolean {
  if (shape["hidden"]) return false;
  if (options.frameId !== null && shape["frame-id"] !== options.frameId) return false;

  const type = shape.type;
  if (type === "frame" && !options.includeFrames) return false;
  if ((type === "bool" || type === "group") && options.ignoreGroups) return false;

  if (!options.fullFrame) return true;

  if (!options.ignoreGroups && hasOwn(shape, "component-id")) return true;
  if (!options.ignoreGroups && !isRootFrame(shape)) return true;

  const shapes = shape.shapes;
  if (isNonEmptyArray(shapes) && rectContainsShape(rect, shape)) return true;
  if (!isNonEmptyArray(shapes) && overlapsGeneral(shape, rect)) return true;
  return false;
}

// worker-selection overlaps-parent?: every clip parent must overlap the
// query rect; with clip-children? false (deep selection) only the frame
// clips are still enforced.
function overlapsClipParents(
  clipParents: readonly WorkspaceShape[],
  rect: Bounds,
  clipChildren: boolean,
  usingSelrect: boolean,
): boolean {
  return clipParents.every((parent) => {
    if (!clipChildren && !isFrameShape(parent)) return true;
    return overlapsShape(parent, rect, usingSelrect);
  });
}

// worker-selection query: the ids of the shapes overlapping the rect in
// insertion order (the ordered-set semantics), with the CLJS defaults
// (full-frame? false, include-frames? false, clip-children? true,
// using-selrect? false).
export function querySelection(
  index: WorkspaceIndex,
  rect: Bounds,
  options: QuerySelectionOptions = {},
): string[] {
  const frameId = options.frameId ?? null;
  const fullFrame = options.fullFrame ?? false;
  const includeFrames = options.includeFrames ?? false;
  const ignoreGroups = options.ignoreGroups ?? false;
  const clipChildren = options.clipChildren ?? true;
  const usingSelrect = options.usingSelrect ?? false;

  const out: string[] = [];
  const seen = new Set<string>();
  for (const node of quadtreeSearch(index.quadtree, rect)) {
    const entry = node.data;
    const shape = entry.shape;
    if (!matchCriteria(shape, rect, { frameId, fullFrame, includeFrames, ignoreGroups })) {
      continue;
    }
    if (!overlapsShape(shape, rect, usingSelrect)) continue;
    if (!overlapsClipParents(entry.clipParents, rect, clipChildren, usingSelrect)) continue;
    if (!seen.has(shape.id)) {
      seen.add(shape.id);
      out.push(shape.id);
    }
  }
  return out;
}
