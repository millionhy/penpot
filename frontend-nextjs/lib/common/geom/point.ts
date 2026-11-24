// TypeScript mirror of app.common.geom.point.
//
// The Clojure branch stays in common/ until backend-rust replaces the JVM
// backend. This file keeps the CLJS conventions: plain {x, y} objects, angles
// in degrees at the public boundary, and the same numeric tolerances
// (almost-zero 1e-4, close? 1e-3).

export interface Point {
  x: number;
  y: number;
}

const ALMOST_ZERO = 1e-4;
const CLOSE_PRECISION = 1e-3;

export function almostZero(value: number): boolean {
  return Math.abs(value) < ALMOST_ZERO;
}

export function closeTo(a: number, b: number, precision = CLOSE_PRECISION): boolean {
  return Math.abs(a - b) <= precision;
}

export function isPointLike(value: unknown): value is Point {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<Point>;
  return typeof candidate.x === "number" && typeof candidate.y === "number";
}

export function point(): Point;
export function point(value: number): Point;
export function point(value: Point): Point;
export function point(x: number, y: number): Point;
export function point(value: number | Point = 0, y?: number): Point {
  if (typeof value === "number") {
    return { x: value, y: y ?? value };
  }
  if (isPointLike(value)) return { x: value.x, y: value.y };
  throw new Error("invalid arguments (on point constructor)");
}

// decode-point: "x,y" or {x, y}.
export function decodePoint(value: unknown): Point | undefined {
  if (isPointLike(value)) return point(value);
  if (typeof value === "string") {
    const [rawX, rawY] = value.split(",");
    const x = Number.parseFloat(rawX ?? "");
    const y = Number.parseFloat(rawY ?? "");
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }
  return undefined;
}

export function pointToString(value: Point): string {
  return value.x + "," + value.y;
}

export function pointsClose(p1: Point, p2: Point): boolean {
  return closeTo(p1.x, p2.x) && closeTo(p1.y, p2.y);
}

export function angleToPoint(origin: Point, angle: number, distance: number): Point {
  // gpt/angle->point receives radians. Its callers convert degrees first.
  return {
    x: origin.x + distance * Math.cos(angle),
    y: origin.y - distance * Math.sin(angle),
  };
}

export function add(p1: Point, p2: Point): Point {
  return { x: p1.x + p2.x, y: p1.y + p2.y };
}

export function subtract(p1: Point, p2: Point): Point {
  return { x: p1.x - p2.x, y: p1.y - p2.y };
}

export function multiply(p1: Point, p2: Point): Point {
  return { x: p1.x * p2.x, y: p1.y * p2.y };
}

export function divide(p1: Point, p2: Point): Point {
  return { x: p1.x / p2.x, y: p1.y / p2.y };
}

export function minPoint(p1: Point, p2: Point): Point {
  return { x: Math.min(p1.x, p2.x), y: Math.min(p1.y, p2.y) };
}

export function maxPoint(p1: Point, p2: Point): Point {
  return { x: Math.max(p1.x, p2.x), y: Math.max(p1.y, p2.y) };
}

export function inverse(p: Point): Point {
  return { x: 1 / p.x, y: 1 / p.y };
}

export function negate(p: Point): Point {
  return { x: -p.x, y: -p.y };
}

export function distance(p1: Point, p2: Point): number {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

export function distanceVector(p1: Point, p2: Point): Point {
  return { x: Math.abs(p1.x - p2.x), y: Math.abs(p1.y - p2.y) };
}

export function length(p: Point): number {
  return Math.hypot(p.x, p.y);
}

const toDegrees = (radians: number): number => (radians * 180) / Math.PI;
const toRadians = (degrees: number): number => (degrees * Math.PI) / 180;

export function angle(p: Point, center?: Point): number {
  if (center === undefined) return toDegrees(Math.atan2(p.y, p.x));
  return toDegrees(Math.atan2(p.y - center.y, p.x - center.x));
}

export function angleWithOther(p1: Point, p2: Point): number {
  const length1 = length(p1);
  const length2 = length(p2);
  if (almostZero(length1) || almostZero(length2)) return 0;
  const raw = (p1.x * p2.x + p1.y * p2.y) / (length1 * length2);
  const clamped = Math.min(1, Math.max(-1, raw));
  const result = toDegrees(Math.acos(clamped));
  return Number.isNaN(result) ? 0 : result;
}

export function angleSign(p1: Point, p2: Point): number {
  return p1.y * p2.x > p1.x * p2.y ? -1 : 1;
}

export function signedAngleWithOther(v1: Point, v2: Point): number {
  return angleSign(v1, v2) * angleWithOther(v1, v2);
}

export function updateAngle(p: Point, degrees: number): Point {
  const radians = toRadians(degrees);
  const len = length(p);
  return { x: Math.cos(radians) * len, y: Math.sin(radians) * len };
}

export function quadrant(p: Point): number {
  if (p.x >= 0) return p.y >= 0 ? 1 : 4;
  return p.y >= 0 ? 2 : 3;
}

function precision(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

export function roundPoint(p: Point, decimals = 0): Point {
  return { x: precision(p.x, decimals), y: precision(p.y, decimals) };
}

export function roundStep(p: Point, step: number): Point {
  const round = (value: number) => Math.round(value / step) * step;
  return { x: round(p.x), y: round(p.y) };
}

export function transformPoint(p: Point, matrix: MatrixLike | undefined): Point {
  if (matrix === undefined) return p;
  return {
    x: p.x * matrix.a + p.y * matrix.c + matrix.e,
    y: p.x * matrix.b + p.y * matrix.d + matrix.f,
  };
}

// matrix->point: the translation part of a matrix.
export function matrixToPoint(matrix: MatrixLike): Point {
  return { x: matrix.e, y: matrix.f };
}

export function toVec(p1: Point, p2: Point): Point {
  return subtract(p2, p1);
}

export function scalePoint(p: Point, scalar: number): Point {
  return { x: p.x * scalar, y: p.y * scalar };
}

export function dot(p1: Point, p2: Point): number {
  return p1.x * p2.x + p1.y * p2.y;
}

export function unit(p: Point): Point {
  const len = length(p);
  if (almostZero(len)) return { x: 0, y: 0 };
  return { x: p.x / len, y: p.y / len };
}

export function perpendicular(p: Point): Point {
  return { x: -p.y, y: p.x };
}

export function project(v1: Point, v2: Point): Point {
  const v2Unit = unit(v2);
  return scalePoint(v2Unit, dot(v1, v2Unit));
}

export function centerPoints(points: readonly Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  return points.reduce(
    (acc, current) => add(acc, { x: current.x / points.length, y: current.y / points.length }),
    { x: 0, y: 0 },
  );
}

export function normalLeft(p: Point): Point {
  return unit({ x: -p.y, y: p.x });
}

export function normalRight(p: Point): Point {
  return unit({ x: p.y, y: -p.x });
}

export function pointLineDistance(p: Point, line1: Point, line2: Point): number {
  const numerator = Math.abs(
    p.x * (line2.y - line1.y) - p.y * (line2.x - line1.x) + line2.x * line1.y - line2.y * line1.x,
  );
  return numerator / distance(line2, line1);
}

export function almostZeroPoint(p: Point): boolean {
  return almostZero(p.x) && almostZero(p.y);
}

export function isZero(p: Point): boolean {
  return p.x === 0 && p.y === 0;
}

export function lerpPoint(p1: Point, p2: Point, t: number): Point {
  return {
    x: (1 - t) * p1.x + t * p2.x,
    y: (1 - t) * p1.y + t * p2.y,
  };
}

export function rotatePoint(p: Point, center: Point, degrees: number): Point {
  const radians = toRadians(degrees);
  const sin = Math.sin(radians);
  const cos = Math.cos(radians);
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  return {
    x: cos * dx - sin * dy + center.x,
    y: sin * dx + cos * dy + center.y,
  };
}

export function scaleFrom(p: Point, center: Point, value: number): Point {
  return add(p, scalePoint(unit(toVec(center, p)), value));
}

export function noZeros(p: Point): Point {
  return {
    x: almostZero(p.x) ? 0.001 : p.x,
    y: almostZero(p.y) ? 0.001 : p.y,
  };
}

export function resizeVector(vector: Point, newLength: number): Point {
  return scalePoint(vector, newLength / length(vector));
}

export function absPoint(p: Point): Point {
  return { x: Math.abs(p.x), y: Math.abs(p.y) };
}

export interface MatrixLike {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}
