// app.common.geom.point / matrix / rect, Node side.
//
// Only the operations the exporter needs: points and their affine transform,
// 2D matrices and the SVG transform constructors, and a rectangle record for
// the shape selrect. The CLJS originals carry many more helpers; port them
// when a caller needs them rather than up front.

export interface Point {
  x: number;
  y: number;
}

export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export function point(x = 0, y = x): Point {
  return { x, y };
}

export function transform(p: Point, m?: Matrix | null): Point {
  if (m === undefined || m === null) return p;
  return {
    x: p.x * m.a + p.y * m.c + m.e,
    y: p.x * m.b + p.y * m.d + m.f,
  };
}

export function distance(p1: Point, p2: Point): number {
  return Math.hypot(p1.x - p2.x, p1.y - p2.y);
}

export function matrix(a = 1, b = 0, c = 0, d = 1, e = 0, f = 0): Matrix {
  return { a, b, c, d, e, f };
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

export function translateMatrix(x: number, y: number): Matrix {
  return matrix(1, 0, 0, 1, x, y);
}

export function scaleMatrix(sx: number, sy: number = sx): Matrix {
  return matrix(sx, 0, 0, sy, 0, 0);
}

export function rotateMatrix(angle: number, center: Point = point(0, 0)): Matrix {
  const rad = (angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const nx = -center.x;
  const ny = -center.y;
  return matrix(
    cos,
    sin,
    -sin,
    cos,
    cos * nx + -sin * ny + center.x,
    sin * nx + cos * ny + center.y,
  );
}

export function skewMatrix(angleX: number, angleY: number): Matrix {
  return matrix(1, Math.tan((angleY * Math.PI) / 180), Math.tan((angleX * Math.PI) / 180), 1, 0, 0);
}

function number(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

// `grc/make-rect`: every rect has positive extents, so a zero-sized selrect
// still normalizes instead of dividing by zero later.
export function makeRect(data: Partial<Rect> | undefined = {}): Rect {
  const x = number(data.x, 0);
  const y = number(data.y, 0);
  const width = Math.max(number(data.width, 0.01), 0.01);
  const height = Math.max(number(data.height, 0.01), 0.01);
  return { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height };
}