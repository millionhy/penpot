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
  width = 0,
  height = 0,
): Rect {
  return { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height };
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
