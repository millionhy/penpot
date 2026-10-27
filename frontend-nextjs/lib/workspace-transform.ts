// Workspace resize/rotate geometry (F9.6): the pure rules behind the
// selection handles — the selection frame, the handle layout, the resize
// and rotate gestures, the generic transform application and the
// update-file change building. Ported from:
// - frontend/src/app/main/data/workspace/transforms.cljs
//   (get-handler-multiplier / get-handler-resize-origin / fix-init-point /
//    the local-frame math of start-resize and start-rotate);
// - common/src/app/common/types/modifiers.cljc (transform-resize! /
//   transform-rotate!);
// - common/src/app/common/geom/shapes/transforms.cljc
//   (transform-points-matrix / calculate-selrect / calculate-transform /
//    adjust-shape-flips / apply-transform-generic);
// - common/src/app/common/types/path/impl.cljc (impl-transform over the
//   packed 28-byte segments);
// - common/src/app/common/geom/{matrix,point,rect}.cljc and
//   geom/shapes/common.cljc (multiply / inverse / transform-point /
//   points->center / shapes->rect).
//
// The gesture works with one world matrix per shape: the preview (wasm
// set-modifiers) and the commit (applyTransformToShape) read the same six
// numbers, so the overlay, the renderer and the stored geometry cannot
// drift apart.
//
// Deviations from the CLJS original, documented:
// - Single-selection geometry uses the shape selrect plus its
//   center-wrapped transform (get-selrect); a multi-selection uses the
//   union of the rotated points (shapes->rect), so the frame follows the
//   actual painted bounds.
// - The resize matrix is built in the selection frame:
//   tf · T(origin) · S(scale) · T(-origin) · tf⁻¹ with the origin converted
//   from get-handler-resize-origin. The CLJS transform-resize! applies the
//   centerless shape transform around an origin already wrapped in the
//   shape center; both agree for unrotated shapes and the selection-frame
//   form stays self-consistent for rotated ones.
// - Alt (center) resizes around the selection frame center, the fixed point
//   of T(center) · S · T(-center); the CLJS reaches the same matrix with a
//   move modifier in front of the resize modifier.
// - Text and unsupported types show no handles: apply-transform-generic
//   updates the box but not the text position-data, so scaling text would
//   leave its content behind. This module only builds the matrix of the
//   selected shapes: the subtree and the constraint spread of a container
//   live in lib/workspace-constraints.ts, which the commits call before
//   they build their changes.
// - No snap guides, pixel grid, grow-type changes, image-fill bounds
//   resize, scale-text mode or flip-aware cursor rotation.

import {
  isPathData,
  PathData,
  type UpdateFileModObjChange,
  type UpdateFileSetOperation,
} from "@/lib/transit";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { sameValue } from "@/lib/workspace-move";

// --- Matrices ---------------------------------------------------------------

// The (a, b, c, d, e, f) tuple of a penpot matrix (the same slot order the
// wasm modifier ABI uses): x' = a*x + c*y + e, y' = b*x + d*y + f.
export type Matrix6 = readonly [number, number, number, number, number, number];

// The transit form of a matrix: app.common.types.shape stores {a..f}.
export interface MatrixRecord {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY_MATRIX: Matrix6 = [1, 0, 0, 1, 0, 0];

export function multiplyMatrix(m1: Matrix6, m2: Matrix6): Matrix6 {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

export function translationMatrix(x: number, y: number): Matrix6 {
  return [1, 0, 0, 1, x, y];
}

export function scaleMatrix(x: number, y: number): Matrix6 {
  return [x, 0, 0, y, 0, 0];
}

// gmt/rotate-matrix: clockwise degrees in the y-down screen frame
// (a = cos, b = sin, c = -sin, d = cos).
export function rotationMatrix(degrees: number): Matrix6 {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return [cos, sin, -sin, cos, 0, 0];
}

// gmt/inverse over an affine matrix; null when the determinant vanishes.
export function inverseMatrix(matrix: Matrix6): Matrix6 | null {
  const determinant = matrix[0] * matrix[3] - matrix[1] * matrix[2];
  if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) return null;
  const a = matrix[3] / determinant;
  const b = -matrix[1] / determinant;
  const c = -matrix[2] / determinant;
  const d = matrix[0] / determinant;
  return [a, b, c, d, -(a * matrix[4] + c * matrix[5]), -(b * matrix[4] + d * matrix[5])];
}

export interface Point {
  x: number;
  y: number;
}

export function transformPoint(point: Point, matrix: Matrix6): Point {
  return {
    x: point.x * matrix[0] + point.y * matrix[2] + matrix[4],
    y: point.x * matrix[1] + point.y * matrix[3] + matrix[5],
  };
}

export function matrixRecord(matrix: Matrix6): MatrixRecord {
  return { a: matrix[0], b: matrix[1], c: matrix[2], d: matrix[3], e: matrix[4], f: matrix[5] };
}

export function matrixToString(matrix: Matrix6): string {
  return `matrix(${matrix[0]},${matrix[1]},${matrix[2]},${matrix[3]},${matrix[4]},${matrix[5]})`;
}

// gmt/matrix? over the transit-decoded values.
function matrixFromValue(value: unknown): Matrix6 | null {
  if (value === null || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const keys = ["a", "b", "c", "d", "e", "f"] as const;
  if (keys.some((key) => typeof record[key] !== "number")) return null;
  return [record.a, record.b, record.c, record.d, record.e, record.f] as Matrix6;
}

function matrixFromShape(shape: WorkspaceShape, key: string): Matrix6 {
  return matrixFromValue(shape[key]) ?? IDENTITY_MATRIX;
}

function closeTo(value: number, expected: number): boolean {
  return Math.abs(value - expected) < 0.001;
}

function isUnitMatrix(matrix: Matrix6): boolean {
  return (
    closeTo(matrix[0], 1) &&
    closeTo(matrix[1], 0) &&
    closeTo(matrix[2], 0) &&
    closeTo(matrix[3], 1) &&
    closeTo(matrix[4], 0) &&
    closeTo(matrix[5], 0)
  );
}

// mth/almost-zero? (1e-4): a collapse below this is a degenerate scale.
function almostZero(value: number): boolean {
  return Math.abs(value) < 1e-4;
}

// gpt/no-zeros: a vanished scale component becomes 0.001 so the matrix
// stays invertible.
function noZeros(value: number): number {
  return almostZero(value) ? 0.001 : value;
}

function roundToZero(value: number): number {
  return almostZero(value) ? 0 : value;
}

function mod360(value: number): number {
  return ((value % 360) + 360) % 360;
}

// --- Rect and point readers -------------------------------------------------

// A complete penpot rect (grc/defrecord Rect): x/y/width/height plus the
// derived edges.
export interface GeometryRect {
  x: number;
  y: number;
  width: number;
  height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

function makeRect(x: number, y: number, width: number, height: number): GeometryRect {
  const w = Math.max(width, 0.01);
  const h = Math.max(height, 0.01);
  return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
}

function rectOf(shape: WorkspaceShape): GeometryRect | null {
  const selrect = shape["selrect"];
  if (selrect === null || typeof selrect !== "object") return null;
  const { x, y, width, height } = selrect as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return makeRect(x, y, width, height);
}

function rectCenter(rect: GeometryRect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// The four corner points of a shape: the stored rotated points, or the
// selrect corners when the shape carries none.
function shapePoints(shape: WorkspaceShape): Point[] | null {
  const points = shape["points"];
  if (Array.isArray(points) && points.length >= 4) {
    const out: Point[] = [];
    for (const point of points as unknown[]) {
      if (point === null || typeof point !== "object") break;
      const { x, y } = point as Record<string, unknown>;
      if (typeof x !== "number" || typeof y !== "number") break;
      out.push({ x, y });
    }
    if (out.length >= 4) return out.slice(0, 4);
  }
  const rect = rectOf(shape);
  if (rect === null) return null;
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ];
}

// gco/points->center: the midpoint of the points bounding box.
function pointsCenter(points: readonly Point[]): Point {
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
  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };
}

// gtr/transform-matrix: T(center) · shape.transform · T(-center), the matrix
// that takes the selrect to the painted (rotated/flipped) shape.
export function shapeTransformMatrix(shape: WorkspaceShape): Matrix6 {
  const rect = rectOf(shape);
  const center = rect === null ? { x: 0, y: 0 } : rectCenter(rect);
  const transform = matrixFromShape(shape, "transform");
  return multiplyMatrix(
    multiplyMatrix(translationMatrix(center.x, center.y), transform),
    translationMatrix(-center.x, -center.y),
  );
}

// --- The selection frame ----------------------------------------------------

export interface SelectionGeometry {
  // The rect in the selection's own frame: the single shape selrect, or the
  // union of the rotated points for a multi-selection.
  rect: GeometryRect;
  // The matrix that takes the rect to world coordinates (the identity for a
  // multi-selection).
  transform: Matrix6;
  // The selection center in world coordinates (rotation pivot).
  center: Point;
  // The single shape rotation; 0 for a multi-selection.
  rotation: number;
  // The shape proportion-lock flag (single selection only).
  proportionLock: boolean;
}

export type ResizeHandler =
  | "top-left"
  | "top"
  | "top-right"
  | "right"
  | "bottom-right"
  | "bottom"
  | "bottom-left"
  | "left";

export type RotationCorner = "top-left" | "top-right" | "bottom-right" | "bottom-left";

// The shape types the handles accept. Text stays out (its position-data is
// not recomputed here); path/bool move their packed content.
const TRANSFORMABLE_TYPES = new Set(["rect", "circle", "frame", "group", "path", "bool", "image"]);

export function isTransformableShape(shape: WorkspaceShape | null | undefined): boolean {
  return (
    shape !== null &&
    shape !== undefined &&
    shape["blocked"] !== true &&
    TRANSFORMABLE_TYPES.has(shape.type)
  );
}

// dsh/get-selrect over the JS model. A single selection keeps the shape
// frame (selrect + center-wrapped transform); a multi-selection builds the
// rotated-points union with a plain world frame (shapes->rect). Null when an
// id is missing or a shape cannot be transformed, so the caller draws no
// handles.
export function selectionGeometry(
  objects: WorkspaceObjects,
  selection: readonly string[],
): SelectionGeometry | null {
  if (selection.length === 0) return null;
  const shapes: WorkspaceShape[] = [];
  for (const id of selection) {
    const shape = objects[id];
    if (shape === undefined || shape === null) return null;
    if (!isTransformableShape(shape)) return null;
    shapes.push(shape);
  }

  if (shapes.length === 1) {
    const shape = shapes[0];
    const rect = rectOf(shape);
    if (rect === null) return null;
    const transform = shapeTransformMatrix(shape);
    return {
      rect,
      transform,
      center: transformPoint(rectCenter(rect), transform),
      rotation: typeof shape["rotation"] === "number" ? shape["rotation"] : 0,
      proportionLock: shape["proportion-lock"] === true,
    };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const shape of shapes) {
    const points = shapePoints(shape);
    if (points === null) return null;
    for (const point of points) {
      minX = Math.min(minX, point.x);
      minY = Math.min(minY, point.y);
      maxX = Math.max(maxX, point.x);
      maxY = Math.max(maxY, point.y);
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const rect = makeRect(minX, minY, maxX - minX, maxY - minY);
  return {
    rect,
    transform: IDENTITY_MATRIX,
    center: rectCenter(rect),
    rotation: 0,
    proportionLock: false,
  };
}

// The four world corners of the frame under a preview matrix (null when the
// frame has no usable transform).
export function frameCorners(
  geometry: SelectionGeometry,
  preview: Matrix6 | null = null,
): Point[] {
  const rect = geometry.rect;
  const transform =
    preview === null ? geometry.transform : multiplyMatrix(preview, geometry.transform);
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x + rect.width, y: rect.y },
    { x: rect.x + rect.width, y: rect.y + rect.height },
    { x: rect.x, y: rect.y + rect.height },
  ].map((point) => transformPoint(point, transform));
}

export interface HandlePoint {
  handler: ResizeHandler;
  x: number;
  y: number;
}

// The eight resize handles at the frame corners and edge midpoints.
export function resizeHandlePoints(
  geometry: SelectionGeometry,
  preview: Matrix6 | null = null,
): HandlePoint[] {
  const rect = geometry.rect;
  const midX = rect.x + rect.width / 2;
  const midY = rect.y + rect.height / 2;
  const local: Array<[ResizeHandler, number, number]> = [
    ["top-left", rect.x, rect.y],
    ["top", midX, rect.y],
    ["top-right", rect.x + rect.width, rect.y],
    ["right", rect.x + rect.width, midY],
    ["bottom-right", rect.x + rect.width, rect.y + rect.height],
    ["bottom", midX, rect.y + rect.height],
    ["bottom-left", rect.x, rect.y + rect.height],
    ["left", rect.x, midY],
  ];
  const transform =
    preview === null ? geometry.transform : multiplyMatrix(preview, geometry.transform);
  return local.map(([handler, x, y]) => {
    const point = transformPoint({ x, y }, transform);
    return { handler, x: point.x, y: point.y };
  });
}

export interface RotationZone {
  corner: RotationCorner;
  points: Point[];
}

// The four rotation zones: a size x size square just outside each corner
// (rotation-handler in viewport/selection.cljs).
export function rotationZonePoints(
  geometry: SelectionGeometry,
  size: number,
  preview: Matrix6 | null = null,
): RotationZone[] {
  const rect = geometry.rect;
  const x = rect.x;
  const y = rect.y;
  const ex = rect.x + rect.width;
  const ey = rect.y + rect.height;
  const local: Array<[RotationCorner, Point[]]> = [
    ["top-left", [
      { x: x - size, y: y - size },
      { x, y: y - size },
      { x, y },
      { x: x - size, y },
    ]],
    ["top-right", [
      { x: ex, y: y - size },
      { x: ex + size, y: y - size },
      { x: ex + size, y },
      { x: ex, y },
    ]],
    ["bottom-right", [
      { x: ex, y: ey },
      { x: ex + size, y: ey },
      { x: ex + size, y: ey + size },
      { x: ex, y: ey + size },
    ]],
    ["bottom-left", [
      { x: x - size, y: ey },
      { x, y: ey },
      { x, y: ey + size },
      { x: x - size, y: ey + size },
    ]],
  ];
  const transform =
    preview === null ? geometry.transform : multiplyMatrix(preview, geometry.transform);
  return local.map(([corner, points]) => ({
    corner,
    points: points.map((point) => transformPoint(point, transform)),
  }));
}

// --- Resize -----------------------------------------------------------------

// get-handler-multiplier: the axis direction a handler grows toward.
function handlerMultiplier(handler: ResizeHandler): Point {
  switch (handler) {
    case "right":
      return { x: 1, y: 0 };
    case "bottom":
      return { x: 0, y: 1 };
    case "left":
      return { x: -1, y: 0 };
    case "top":
      return { x: 0, y: -1 };
    case "top-right":
      return { x: 1, y: -1 };
    case "top-left":
      return { x: -1, y: -1 };
    case "bottom-right":
      return { x: 1, y: 1 };
    case "bottom-left":
      return { x: -1, y: 1 };
  }
}

// get-handler-resize-origin: the opposite edge/corner, kept fixed.
function handlerResizeOrigin(rect: GeometryRect, handler: ResizeHandler): Point {
  const sx = rect.x;
  const sy = rect.y;
  const mx = rect.x + rect.width / 2;
  const my = rect.y + rect.height / 2;
  const ex = rect.x + rect.width;
  const ey = rect.y + rect.height;
  switch (handler) {
    case "right":
      return { x: sx, y: my };
    case "bottom":
      return { x: mx, y: sy };
    case "left":
      return { x: ex, y: my };
    case "top":
      return { x: mx, y: ey };
    case "top-right":
      return { x: sx, y: ey };
    case "top-left":
      return { x: ex, y: ey };
    case "bottom-right":
      return { x: sx, y: sy };
    case "bottom-left":
      return { x: ex, y: sy };
  }
}

// fix-init-point: snap the start point to the handled edge so an off-center
// press still scales from the pressed side.
function fixInitPoint(initial: Point, handler: ResizeHandler, rect: GeometryRect): Point {
  const ex = rect.x + rect.width;
  const ey = rect.y + rect.height;
  switch (handler) {
    case "left":
      return { x: rect.x, y: initial.y };
    case "right":
      return { x: ex, y: initial.y };
    case "top":
      return { x: initial.x, y: rect.y };
    case "bottom":
      return { x: initial.x, y: ey };
    case "top-left":
      return { x: rect.x, y: rect.y };
    case "top-right":
      return { x: ex, y: rect.y };
    case "bottom-left":
      return { x: rect.x, y: ey };
    case "bottom-right":
      return { x: ex, y: ey };
  }
}

export interface ResizeOptions {
  // Shift or the shape proportion-lock flag: both scale components follow
  // the largest one.
  lock?: boolean;
  // Alt: scale around the frame center, not the opposite corner.
  center?: boolean;
}

export interface ResizeResult {
  scale: Point;
  matrix: Matrix6;
  // The adjusted origin in the selection frame (null when degenerate).
  origin: Point | null;
}

// start-resize: convert both world points into the selection frame, scale
// the frame, and return the world matrix tf · T(origin) · S · T(-origin) ·
// tf⁻¹. Returns null when the frame or its transform is degenerate.
export function resizeGesture(
  geometry: SelectionGeometry,
  handler: ResizeHandler,
  initialWorld: Point,
  currentWorld: Point,
  options: ResizeOptions = {},
): ResizeResult | null {
  const inverse = inverseMatrix(geometry.transform);
  if (inverse === null) return null;
  const rect = geometry.rect;
  if (rect.width <= 0 || rect.height <= 0) return null;

  const initialLocal = transformPoint(initialWorld, inverse);
  const currentLocal = transformPoint(currentWorld, inverse);
  const fixed = fixInitPoint(initialLocal, handler, rect);
  const multiplier = handlerMultiplier(handler);
  const delta = {
    x: (currentLocal.x - fixed.x) * multiplier.x,
    y: (currentLocal.y - fixed.y) * multiplier.y,
  };

  let scaleX = noZeros((rect.width + delta.x) / rect.width);
  let scaleY = noZeros((rect.height + delta.y) / rect.height);

  if (options.lock === true) {
    let locked: number;
    if (handler === "left" || handler === "right") locked = scaleX;
    else if (handler === "top" || handler === "bottom") locked = scaleY;
    else locked = Math.max(scaleX, scaleY);
    scaleX = locked;
    scaleY = locked;
  }

  // Alt keeps the frame center fixed: the only fixed point of
  // T(o) · S · T(-o) is o, so the origin becomes the center.
  const adjustedOrigin =
    options.center === true ? rectCenter(rect) : handlerResizeOrigin(rect, handler);

  const matrix = multiplyMatrix(
    multiplyMatrix(
      multiplyMatrix(
        multiplyMatrix(
          geometry.transform,
          translationMatrix(adjustedOrigin.x, adjustedOrigin.y),
        ),
        scaleMatrix(scaleX, scaleY),
      ),
      translationMatrix(-adjustedOrigin.x, -adjustedOrigin.y),
    ),
    inverse,
  );

  return { scale: { x: scaleX, y: scaleY }, matrix, origin: adjustedOrigin };
}

// --- Rotation ---------------------------------------------------------------

export interface RotateOptions {
  // mod: snap to 45 degree steps.
  snap45?: boolean;
  // shift: snap to 15 degree steps.
  snap15?: boolean;
}

export interface RotateResult {
  angle: number;
  matrix: Matrix6;
}

// gpt/angle in degrees around the pivot (atan2, y down).
function angleAround(point: Point, center: Point): number {
  return (Math.atan2(point.y - center.y, point.x - center.x) * 180) / Math.PI;
}

// start-rotate with the wasm branch: the delta angle against the press
// angle, normalized to [0, 360), snapped 45/15, applied around the
// selection center.
export function rotateGesture(
  center: Point,
  initialWorld: Point,
  currentWorld: Point,
  options: RotateOptions = {},
): RotateResult {
  const initialAngle = angleAround(initialWorld, center);
  let angle = angleAround(currentWorld, center) - initialAngle;
  if (angle < 0) angle += 360;
  if (angle === 360) angle = 0;
  if (options.snap45 === true) angle = Math.floor(angle / 45) * 45;
  if (options.snap15 === true) angle = Math.floor(angle / 15) * 15;
  const matrix = multiplyMatrix(
    multiplyMatrix(translationMatrix(center.x, center.y), rotationMatrix(angle)),
    translationMatrix(-center.x, -center.y),
  );
  return { angle, matrix };
}

// --- Generic transform application ------------------------------------------

// transform-points-matrix: the affine map that takes the new selrect back to
// the transformed points (the special-case inverse solve of the CLJS).
function transformPointsMatrix(selrect: GeometryRect, points: readonly Point[]): Matrix6 | null {
  const x1 = roundToZero(selrect.x1);
  const y1 = roundToZero(selrect.y1);
  const x2 = roundToZero(selrect.x2);
  const y2 = roundToZero(selrect.y2);
  const det = (y1 - y2) * (x1 - x2);
  if (!Number.isFinite(det) || det === 0) return null;

  const d1 = points[0];
  const d2 = points[1];
  const d4 = points[3];
  const ma0 = roundToZero(d1.x);
  const ma1 = roundToZero(d2.x);
  const ma2 = roundToZero(d4.x);
  const ma3 = roundToZero(d1.y);
  const ma4 = roundToZero(d2.y);
  const ma5 = roundToZero(d4.y);

  const mb0 = (y1 - y2) / det;
  const mb1 = (x1 - x2) / det;
  const mb2 = (x2 * y2 - x1 * y1) / det;
  const mb3 = (y2 - y1) / det;
  const mb4 = 0;
  const mb5 = (x1 * y1 - x1 * y2) / det;
  const mb6 = 0;
  const mb7 = (x2 - x1) / det;
  const mb8 = (x1 * y1 - x2 * y1) / det;

  return [
    ma0 * mb0 + ma1 * mb3 + ma2 * mb6,
    ma3 * mb0 + ma4 * mb3 + ma5 * mb6,
    ma0 * mb1 + ma1 * mb4 + ma2 * mb7,
    ma3 * mb1 + ma4 * mb4 + ma5 * mb7,
    ma0 * mb2 + ma1 * mb5 + ma2 * mb8,
    ma3 * mb2 + ma4 * mb5 + ma5 * mb8,
  ];
}

// calculate-selrect: the AABB of the transformed points (hypot side
// lengths) centered on their bounds center.
function calculateSelrect(points: readonly Point[], center: Point): GeometryRect {
  const width = Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y);
  const height = Math.hypot(points[0].x - points[3].x, points[0].y - points[3].y);
  return makeRect(center.x - width / 2, center.y - height / 2, width, height);
}

// calculate-transform: the matrix in center coordinates (T(-c)·M·T(c)),
// normalized to the unit matrix when the round-trip lands on identity.
function calculateTransform(
  points: readonly Point[],
  center: Point,
  selrect: GeometryRect,
): Matrix6 | null {
  const raw = transformPointsMatrix(selrect, points);
  if (raw === null) return null;
  const around = multiplyMatrix(
    multiplyMatrix(translationMatrix(-center.x, -center.y), raw),
    translationMatrix(center.x, center.y),
  );
  return isUnitMatrix(around) ? IDENTITY_MATRIX : around;
}

function vector(from: Point, to: Point): Point {
  return { x: to.x - from.x, y: to.y - from.y };
}

function dotProduct(a: Point, b: Point): number {
  return a.x * b.x + a.y * b.y;
}

// apply-transform-generic: transform the four points, toggle the flips
// whose axis turned around, recompute the selrect/transform and add the
// rotation delta. Path/bool shapes carry the matrix into their packed
// content instead of x/y/width/height.
export function applyTransformToShape(
  shape: WorkspaceShape,
  matrix: Matrix6,
  rotationDelta = 0,
): WorkspaceShape {
  const points = shapePoints(shape);
  if (points === null) return shape;
  const nextPoints = points.map((point) => transformPoint(point, matrix));

  const dotX = dotProduct(vector(points[0], points[1]), vector(nextPoints[0], nextPoints[1]));
  const dotY = dotProduct(vector(points[0], points[3]), vector(nextPoints[0], nextPoints[3]));
  const flipX = dotX < 0;
  const flipY = dotY < 0;

  let rotation = typeof shape["rotation"] === "number" ? shape["rotation"] : 0;
  // An odd number of flips mirrors the shape: negate the stored rotation
  // before adding the gesture delta (adjust-shape-flips).
  if (flipX !== flipY) rotation = -rotation;
  rotation = mod360(rotation + rotationDelta);

  const center = pointsCenter(nextPoints);
  const selrect = calculateSelrect(nextPoints, center);
  const transform =
    calculateTransform(nextPoints, center, selrect) ?? matrixFromShape(shape, "transform");
  const transformInverse =
    inverseMatrix(transform) ?? matrixFromShape(shape, "transform-inverse");

  const patch: Record<string, unknown> = {
    selrect,
    points: nextPoints,
    transform: matrixRecord(transform),
    "transform-inverse": matrixRecord(transformInverse),
    rotation,
  };
  if (flipX) patch["flip-x"] = !(shape["flip-x"] === true);
  if (flipY) patch["flip-y"] = !(shape["flip-y"] === true);

  if (shape.type === "path" || shape.type === "bool") {
    const content = shape["content"];
    if (isPathData(content)) {
      patch["content"] = new PathData(transformPathBytes(content.bytes, matrix));
    }
  } else {
    patch["x"] = selrect.x;
    patch["y"] = selrect.y;
    patch["width"] = selrect.width;
    patch["height"] = selrect.height;
  }

  return { ...shape, ...patch };
}

// The attrs one transform actually changes (the same per-attribute diff
// buildMoveChanges uses).
const TRANSFORM_ATTRS = [
  "x",
  "y",
  "width",
  "height",
  "selrect",
  "points",
  "transform",
  "transform-inverse",
  "rotation",
  "flip-x",
  "flip-y",
  "content",
] as const;

export function transformShapePatch(
  shape: WorkspaceShape,
  matrix: Matrix6,
  rotationDelta = 0,
): Record<string, unknown> {
  const next = applyTransformToShape(shape, matrix, rotationDelta);
  const patch: Record<string, unknown> = {};
  for (const attr of TRANSFORM_ATTRS) {
    const value = next[attr];
    if (value === undefined) continue;
    if (sameValue(shape[attr], value)) continue;
    patch[attr] = value;
  }
  return patch;
}

// One shape of a transform: a resize spreads a different matrix per child
// (lib/workspace-constraints.ts), so the gesture commits a list rather than
// one matrix for every id.
export interface TransformEntry {
  id: string;
  matrix: Matrix6;
  // The rotation delta of a rotate gesture; 0 for a resize.
  rotation: number;
}

// The entries of a gesture that moves every id by the same matrix.
export function transformEntries(
  ids: readonly string[],
  matrix: Matrix6,
  rotationDelta: number,
): TransformEntry[] {
  return ids.map((id) => ({ id, matrix, rotation: rotationDelta }));
}

// The update-file changes of one transform: one mod-obj per shape whose
// attributes changed, carrying only those attributes. The first entry of an
// id wins, so a parent that already carries its subtree skips the repeated
// selection entry.
export function buildTransformEntryChanges(
  objects: WorkspaceObjects,
  entries: readonly TransformEntry[],
  pageId: string,
): UpdateFileModObjChange[] {
  const changes: UpdateFileModObjChange[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const shape = objects[entry.id];
    if (shape === undefined || shape === null) continue;
    const patch = transformShapePatch(shape, entry.matrix, entry.rotation);
    const operations: UpdateFileSetOperation[] = [];
    for (const attr of Object.keys(patch)) {
      operations.push({ type: "set", attr, val: patch[attr] });
    }
    if (operations.length === 0) continue;
    changes.push({ type: "mod-obj", "page-id": pageId, id: entry.id, operations });
  }
  return changes;
}

// The model application of a committed transform: only the transformed ids
// are replaced; every other entry keeps its reference. The first entry of
// an id wins (see buildTransformEntryChanges).
export function applyTransformEntries(
  objects: WorkspaceObjects,
  entries: readonly TransformEntry[],
): WorkspaceObjects {
  const out: WorkspaceObjects = { ...objects };
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    const shape = out[entry.id];
    if (shape === undefined || shape === null) continue;
    out[entry.id] = applyTransformToShape(shape, entry.matrix, entry.rotation);
  }
  return out;
}

// --- Packed path content ----------------------------------------------------

// SEGMENT-U8-SIZE and the segment enum (types/path/impl.cljc).
const SEGMENT_U8_SIZE = 28;
const MOVE_TO = 1;
const LINE_TO = 2;
const CURVE_TO = 3;
const C1X = 4;
const C1Y = 8;
const C2X = 12;
const C2Y = 16;
const END_X = 20;
const END_Y = 24;

// impl-transform over a packed path copy: move/line endpoints, curve
// handles and endpoints go through the matrix; close segments carry no
// coordinates. Floats stay little-endian.
export function transformPathBytes(bytes: Uint8Array, matrix: Matrix6): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const count = Math.floor(out.byteLength / SEGMENT_U8_SIZE);
  const apply = (xOffset: number, yOffset: number): void => {
    const x = view.getFloat32(xOffset, true);
    const y = view.getFloat32(yOffset, true);
    view.setFloat32(xOffset, x * matrix[0] + y * matrix[2] + matrix[4], true);
    view.setFloat32(yOffset, x * matrix[1] + y * matrix[3] + matrix[5], true);
  };
  for (let index = 0; index < count; index++) {
    const offset = index * SEGMENT_U8_SIZE;
    const type = view.getUint16(offset, true);
    if (type === MOVE_TO || type === LINE_TO) {
      apply(offset + END_X, offset + END_Y);
    } else if (type === CURVE_TO) {
      apply(offset + C1X, offset + C1Y);
      apply(offset + C2X, offset + C2Y);
      apply(offset + END_X, offset + END_Y);
    }
  }
  return out;
}

// True when the matrix leaves every point untouched (the gesture released
// without movement): the commit sends nothing in that case.
export function isIdentityMatrix(matrix: Matrix6): boolean {
  return isUnitMatrix(matrix);
}
