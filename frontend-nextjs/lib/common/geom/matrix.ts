// TypeScript mirror of app.common.geom.matrix.
//
// Matrices are plain {a, b, c, d, e, f} objects, the same shape Transit
// decodes. Angles are degrees at the public boundary; the CLJS precision
// defaults (close? 1e-3, almost-zero 1e-4, round 4 digits) are kept.

import { almostZero, closeTo, negate, type Point } from "./point";

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const UNIT_MATRIX: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function unitMatrix(): Matrix {
  return { ...UNIT_MATRIX };
}

export function matrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0): Matrix {
  return { a, b, c, d, e, f };
}

// decode-matrix for an object or a matrix(...) string.
export function matrixOf(value: unknown): Matrix {
  if (typeof value === "string") return parseMatrix(value);
  if (value === null || typeof value !== "object") return unitMatrix();
  const source = value as Partial<Matrix>;
  const read = (key: keyof Matrix): number =>
    typeof source[key] === "number" ? (source[key] as number) : UNIT_MATRIX[key];
  return { a: read("a"), b: read("b"), c: read("c"), d: read("d"), e: read("e"), f: read("f") };
}

// format-precision: "matrix(a, b, c, d, e, f)".
export function formatMatrix(value: Matrix, digits = 6): string {
  const parts = [value.a, value.b, value.c, value.d, value.e, value.f].map((n) => n.toFixed(digits));
  return "matrix(" + parts.join(", ") + ")";
}

// str->matrix: read every number the string contains.
export function parseMatrix(value: string): Matrix {
  const numbers = value.match(/[+-]?\d*\.?\d+(?:[eE][+-]?\d+)?/g) ?? [];
  const part = (index: number): number => {
    const parsed = Number.parseFloat(numbers[index] ?? "");
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return matrix(part(0), part(1), part(2), part(3), part(4), part(5));
}

export function matrixClose(m1: Matrix, m2: Matrix): boolean {
  return (
    closeTo(m1.a, m2.a) &&
    closeTo(m1.b, m2.b) &&
    closeTo(m1.c, m2.c) &&
    closeTo(m1.d, m2.d) &&
    closeTo(m1.e, m2.e) &&
    closeTo(m1.f, m2.f)
  );
}

export function isUnitMatrix(m1: Matrix | null | undefined): boolean {
  if (m1 === null || m1 === undefined) return false;
  return (
    closeTo(m1.a, 1) &&
    closeTo(m1.b, 0) &&
    closeTo(m1.c, 0) &&
    closeTo(m1.d, 1) &&
    closeTo(m1.e, 0) &&
    closeTo(m1.f, 0)
  );
}

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function multiplyAll(...matrices: Matrix[]): Matrix {
  return matrices.reduce((acc, current) => multiply(acc, current), unitMatrix());
}

export function addTranslate(m1: Matrix, m2: Matrix): Matrix {
  return matrix(1, 0, 0, 1, m1.e + m2.e, m1.f + m2.f);
}

export function subtract(m1: Matrix, m2: Matrix): Matrix {
  return matrix(m1.a - m2.a, m1.b - m2.b, m1.c - m2.c, m1.d - m2.d, m1.e - m2.e, m1.f - m2.f);
}

export function translateMatrix(x: number | Point, y?: number): Matrix {
  if (typeof x === "number") return matrix(1, 0, 0, 1, x, y ?? 0);
  return matrix(1, 0, 0, 1, x.x, x.y);
}

export function translateMatrixNeg(x: number | Point, y?: number): Matrix {
  if (typeof x === "number") return matrix(1, 0, 0, 1, -x, -(y ?? 0));
  return matrix(1, 0, 0, 1, -x.x, -x.y);
}

export function scaleMatrix(scale: Point, center?: Point): Matrix {
  if (center === undefined) return matrix(scale.x, 0, 0, scale.y, 0, 0);
  return matrix(
    scale.x,
    0,
    0,
    scale.y,
    center.x - center.x * scale.x,
    center.y - center.y * scale.y,
  );
}

export function rotateMatrix(degrees: number, center?: Point): Matrix {
  const radians = (degrees * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  if (center === undefined) return matrix(cos, sin, -sin, cos, 0, 0);
  const nx = -center.x;
  const ny = -center.y;
  return matrix(cos, sin, -sin, cos, cos * nx + -sin * ny + center.x, sin * nx + cos * ny + center.y);
}

export function skewMatrix(angleX: number, angleY: number, center?: Point): Matrix {
  const m1 = Math.tan((angleX * Math.PI) / 180);
  const m2 = Math.tan((angleY * Math.PI) / 180);
  const base = matrix(1, m2, m1, 1, 0, 0);
  if (center === undefined) return base;
  return multiplyAll(translateMatrix(center), base, translateMatrix(negate(center)));
}

export function rotate(m: Matrix, degrees: number, center?: Point): Matrix {
  return multiply(m, rotateMatrix(degrees, center));
}

export function scale(m: Matrix, scaleValue: Point, center?: Point): Matrix {
  return multiply(m, scaleMatrix(scaleValue, center));
}

export function translate(m: Matrix, p: Point): Matrix {
  return multiply(m, translateMatrix(p));
}

export function skew(m: Matrix, angleX: number, angleY: number, center?: Point): Matrix {
  return multiply(m, skewMatrix(angleX, angleY, center));
}

export function mEqual(m1: Matrix, m2: Matrix, threshold: number): boolean {
  const equal = (a: number, b: number) => Math.abs(a - b) <= threshold;
  return (
    equal(m1.a, m2.a) &&
    equal(m1.b, m2.b) &&
    equal(m1.c, m2.c) &&
    equal(m1.d, m2.d) &&
    equal(m1.e, m2.e) &&
    equal(m1.f, m2.f)
  );
}

export function transformIn(p: Point | undefined, mtx: Matrix | undefined): Matrix | undefined {
  if (p === undefined || mtx === undefined) return mtx;
  return multiplyAll(translateMatrix(p), mtx, translateMatrixNeg(p));
}

export function determinant(m: Matrix): number {
  return m.a * m.d - m.c * m.b;
}

// inverse: undefined when the matrix is not invertible (almost-zero det).
export function inverse(m: Matrix): Matrix | undefined {
  const det = determinant(m);
  if (almostZero(det)) return undefined;
  return matrix(
    m.d / det,
    -m.b / det,
    -m.c / det,
    m.a / det,
    (m.c * m.f - m.d * m.e) / det,
    (m.b * m.e - m.a * m.f) / det,
  );
}

function precision(value: number, digits: number): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

export function roundMatrix(m: Matrix, digits = 4): Matrix {
  return {
    a: precision(m.a, digits),
    b: precision(m.b, digits),
    c: precision(m.c, digits),
    d: precision(m.d, digits),
    e: precision(m.e, digits),
    f: precision(m.f, digits),
  };
}

// transform-point-center: transform around the shape center.
export function transformPointCenter(
  p: Point | undefined,
  center: Point | undefined,
  m: Matrix | undefined,
): Point | undefined {
  if (p === undefined || center === undefined || m === undefined) return p;
  return applyMatrix(p, multiplyAll(translateMatrix(center), m, translateMatrixNeg(center)));
}

export function applyMatrix(p: Point, m: Matrix): Point {
  return { x: p.x * m.a + p.y * m.c + m.e, y: p.x * m.b + p.y * m.d + m.f };
}

export function isMoveMatrix(m: Matrix): boolean {
  return almostZero(m.a - 1) && almostZero(m.b) && almostZero(m.c) && almostZero(m.d - 1);
}
