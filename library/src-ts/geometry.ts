// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// The subset of `app.common.geom` the file builders need: rect and point
// conversions plus the group selrect recalculation.

import type { Matrix, Point, Rect, Shape } from "./model.ts";

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function makeRect(
  x = 0,
  y = 0,
  width = 0.01,
  height = 0.01,
): Rect {
  // `grc/make-rect` clamps the size so degenerate rects stay visible to
  // the hover and hit test code.
  const w = Math.max(width, 0.01);
  const h = Math.max(height, 0.01);
  return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
}

export function rectToPoints(rect: Rect): Point[] {
  return [
    { x: rect.x1, y: rect.y1 },
    { x: rect.x2, y: rect.y1 },
    { x: rect.x2, y: rect.y2 },
    { x: rect.x1, y: rect.y2 },
  ];
}

export function rectToCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function pointsToRect(points: readonly Point[]): Rect {
  if (points.length === 0) return makeRect();

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }

  return makeRect(minX, minY, maxX - minX, maxY - minY);
}

export function pointsToCenter(points: readonly Point[]): Point {
  const center = rectToCenter(pointsToRect(points));
  return center;
}

export function transformPoint(
  point: Point,
  center: Point,
  matrix: Matrix,
): Point {
  const x = point.x - center.x;
  const y = point.y - center.y;
  return {
    x: matrix.a * x + matrix.c * y + matrix.e + center.x,
    y: matrix.b * x + matrix.d * y + matrix.f + center.y,
  };
}

export function applyMatrix(point: Point, matrix: Matrix): Point {
  return {
    x: matrix.a * point.x + matrix.c * point.y + matrix.e,
    y: matrix.b * point.x + matrix.d * point.y + matrix.f,
  };
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
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function scaleMatrix(sx: number, sy: number): Matrix {
  return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
}

export function rotateMatrix(angle: number): Matrix {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
}

/** `(gmt/translate m pt)`: appends a translation to the matrix. */
export function translate(m: Matrix, pt: Point): Matrix {
  return multiply(m, translateMatrix(pt.x, pt.y));
}

/** `(gmt/transform-in pt mtx)`: the matrix applied around `pt`. */
export function transformIn(pt: Point, matrix: Matrix): Matrix {
  return translate(translate(matrix, pt), { x: -pt.x, y: -pt.y });
}

export function overlapsRects(a: Rect, b: Rect): boolean {
  const x2a = a.x + a.width;
  const y2a = a.y + a.height;
  const x2b = b.x + b.width;
  const y2b = b.y + b.height;

  return (
    (x2a > b.x || closeTo(x2a, b.x)) &&
    (x2b >= a.x || closeTo(x2b, a.x)) &&
    (b.y <= y2a || closeTo(b.y, y2a)) &&
    (a.y <= y2b || closeTo(a.y, y2b))
  );
}

function closeTo(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-4;
}

export function containsPoint(rect: Rect, point: Point): boolean {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;

  return (
    (point.x > rect.x || closeTo(point.x, rect.x)) &&
    (point.x < x2 || closeTo(point.x, x2)) &&
    (point.y > rect.y || closeTo(point.y, rect.y)) &&
    (point.y < y2 || closeTo(point.y, y2))
  );
}

export function transformPoints(
  points: readonly Point[],
  center: Point,
  matrix: Matrix,
): Point[] {
  return points.map((point) => transformPoint(point, center, matrix));
}

export function shapeToRect(shape: {
  x?: number | null;
  y?: number | null;
  width?: number | null;
  height?: number | null;
}): Rect | null {
  const { x, y, width, height } = shape;
  if (typeof x !== "number") return null;
  if (typeof y !== "number") return null;
  if (typeof width !== "number") return null;
  if (typeof height !== "number") return null;
  return makeRect(x, y, width, height);
}

/**
 * Recompute the group geometry from its children, the same way
 * `update-group-selrect` does. Groups built through the API have an
 * identity transform, but the general path is kept for imported shapes.
 */
export function updateGroupSelrect(group: Shape, children: Shape[]): Shape {
  const allPoints = children.flatMap((child) => child.points ?? []);
  const points = allPoints.length > 0 ? allPoints : (group.points ?? []);

  const shapeCenter = pointsToCenter(points);
  const inverse = group.transformInverse ?? IDENTITY;
  const transform = group.transform ?? IDENTITY;

  const basePoints = transformPoints(points, shapeCenter, inverse);
  const newPoints = transformPoints(
    rectToPoints(pointsToRect(basePoints)),
    shapeCenter,
    transform,
  );

  const selrectCenter = pointsToCenter(newPoints);
  const newSelrect = pointsToRect(
    transformPoints(newPoints, selrectCenter, inverse),
  );

  return {
    ...group,
    selrect: newSelrect,
    points: newPoints,
    flipX: null,
    flipY: null,
    x: newSelrect.x,
    y: newSelrect.y,
    width: newSelrect.width,
    height: newSelrect.height,
  };
}
