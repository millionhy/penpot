// The transform helpers of app.common.geom.shapes.transforms: the shape
// center, the matrix an SVG transform attribute carries, and the pure
// translation of a move modifier.
//
// The viewer draws its hotspot layer from `transform-str` of the prepared
// shapes; the string is the same `matrix(a, b, c, d, e, f)` the compiled
// build emits (Matrix.toString -> format-precision, six decimals).
//
// translateShape follows apply-transform-move: the points and the selrect
// shift, `x`/`y` follow the selrect except for path and bool shapes (their
// coordinates live in the content), and a text shape also shifts its
// position-data. The prepared map feeds the hotspot layer alone, so the path
// content is not shifted here; add it before using these maps as a render
// source.

import { multiplyMatrix, scaleMatrix, translateMatrix, type Matrix6 } from "./svg";
import { makeRect, type Rect } from "./bounds";
import type { Point } from "./viewport";

type Shape = Record<string, unknown>;

// matrix/format-precision: six decimals, also for -0.
function fixed(value: number): string {
  return value.toFixed(6);
}

function fromValues(values: unknown[]): Matrix6 | null {
  const [a, b, c, d, e, f] = values;
  if (
    typeof a !== "number" ||
    typeof b !== "number" ||
    typeof c !== "number" ||
    typeof d !== "number" ||
    typeof e !== "number" ||
    typeof f !== "number"
  ) {
    return null;
  }
  return [a, b, c, d, e, f];
}

// A decoded matrix is a record with a..f (transit "~#matrix"); an already
// unwrapped array is accepted for hand-built models.
function toMatrix6(value: unknown): Matrix6 | null {
  if (Array.isArray(value)) return fromValues(value.slice(0, 6));
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  return fromValues(["a", "b", "c", "d", "e", "f"].map((key) => record[key]));
}

// shape->center: the center of the selrect, (0, 0) when there is none.
export function shapeCenter(shape: Shape): Point {
  const selrect = shape.selrect;
  if (selrect === null || typeof selrect !== "object") return { x: 0, y: 0 };
  const rect = selrect as Rect;
  if (typeof rect.x !== "number" || typeof rect.y !== "number") return { x: 0, y: 0 };
  const width = typeof rect.width === "number" ? rect.width : 0;
  const height = typeof rect.height === "number" ? rect.height : 0;
  return { x: rect.x + width / 2, y: rect.y + height / 2 };
}

export interface TransformParams {
  // no-flip: apply the flip flags the renderer cannot take from the matrix.
  noFlip?: boolean;
}

// transform-matrix: translate to the center, the shape transform, the
// optional flips and back. The result is what `transform-str` prints.
export function transformMatrix(shape: Shape, params: TransformParams = {}): Matrix6 {
  const center = shapeCenter(shape);
  let matrix = translateMatrix(center.x, center.y);

  const transform = toMatrix6(shape.transform);
  if (transform !== null) {
    matrix = multiplyMatrix(matrix, transform);
  }

  if (params.noFlip === true && shape["flip-x"] === true) {
    matrix = multiplyMatrix(matrix, scaleMatrix(-1, 1));
  }
  if (params.noFlip === true && shape["flip-y"] === true) {
    matrix = multiplyMatrix(matrix, scaleMatrix(1, -1));
  }

  return multiplyMatrix(matrix, translateMatrix(-center.x, -center.y));
}

// transform-str: an empty string when there is neither a transform nor a
// flip to render (the compiled branch).
export function transformMatrixString(shape: Shape, params: TransformParams = {}): string {
  const hasTransform = shape.transform !== null && shape.transform !== undefined;
  const hasFlip =
    params.noFlip === true && (shape["flip-x"] === true || shape["flip-y"] === true);
  if (!hasTransform && !hasFlip) return "";

  const matrix = transformMatrix(shape, params);
  return (
    "matrix(" +
    fixed(matrix[0]) +
    ", " +
    fixed(matrix[1]) +
    ", " +
    fixed(matrix[2]) +
    ", " +
    fixed(matrix[3]) +
    ", " +
    fixed(matrix[4]) +
    ", " +
    fixed(matrix[5]) +
    ")"
  );
}

function numberOr(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

// move-selrect: a pure translation keeps width and height; make-rect keeps
// the 0.01 floor.
function translateSelrect(value: unknown, dx: number, dy: number): unknown {
  if (value === null || typeof value !== "object") return value;
  const rect = value as Record<string, unknown>;
  const x = numberOr(rect.x);
  const y = numberOr(rect.y);
  if (x === undefined || y === undefined) return value;
  const width = numberOr(rect.width) ?? 0.01;
  const height = numberOr(rect.height) ?? 0.01;
  return makeRect(x + dx, y + dy, width, height);
}

function translatePoints(value: unknown, dx: number, dy: number): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((point) => {
    if (point === null || typeof point !== "object") return point;
    const { x, y } = point as { x?: unknown; y?: unknown };
    const px = numberOr(x);
    const py = numberOr(y);
    if (px === undefined || py === undefined) return point;
    return { ...(point as Record<string, unknown>), x: px + dx, y: py + dy };
  });
}

// move-position-data: the cached text layout also carries page coordinates.
function translatePositionData(value: unknown, dx: number, dy: number): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => {
    if (item === null || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    const x = numberOr(record.x);
    const y = numberOr(record.y);
    if (x === undefined || y === undefined) return item;
    return { ...record, x: x + dx, y: y + dy };
  });
}

// apply-transform-move for a pure translation: the same fields the compiled
// transform-shape touches when the modifier matrix has no scale/rotate.
export function translateShape(shape: Shape, dx: number, dy: number): Shape {
  if (dx === 0 && dy === 0) return shape;

  const type = shape.type;
  const out: Shape = { ...shape };
  out.selrect = translateSelrect(shape.selrect, dx, dy);
  out.points = translatePoints(shape.points, dx, dy);

  if (type === "text") {
    out["position-data"] = translatePositionData(shape["position-data"], dx, dy);
  }

  if (type !== "path" && type !== "bool") {
    const x = numberOr(shape.x);
    const y = numberOr(shape.y);
    if (x !== undefined) out.x = x + dx;
    if (y !== undefined) out.y = y + dy;
    const width = numberOr((shape.selrect as Record<string, unknown> | null)?.width);
    const height = numberOr((shape.selrect as Record<string, unknown> | null)?.height);
    if (width !== undefined) out.width = width;
    if (height !== undefined) out.height = height;
  }

  return out;
}
