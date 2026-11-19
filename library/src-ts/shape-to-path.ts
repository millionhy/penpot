// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `app.common.types.path.shape-to-path`: turns the other shape
// types into path content so the boolean operations can consume them.

import type { Matrix, PathSegment, Point, Shape, Uuid } from "./model.ts";
import {
  IDENTITY,
  applyMatrix,
  makeRect,
  multiply,
  rectToCenter,
  scaleMatrix,
  transformIn,
} from "./geometry.ts";
import {
  almostZero,
  makeCurveTo,
  makeLineTo,
  makeMoveTo,
} from "./path-helpers.ts";
import type { BoolType } from "./path-bool.ts";
import { calculateContent } from "./path-bool.ts";
import { normalizeContent, transformContent, updateGeometry } from "./path.ts";

const BEZIER_CIRCLE_C = 0.551915024494;

const POSITION_ATTRS = [
  "x",
  "y",
  "width",
  "height",
  "rx",
  "ry",
  "r1",
  "r2",
  "r3",
  "r4",
  "metadata",
] as const;

const STYLE_ATTRS = [
  "shadow",
  "blur",
  "backgroundBlur",
  "fills",
  "strokes",
] as const;

export function withoutPositionAttrs(
  shape: Shape,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...shape };
  for (const attr of POSITION_ATTRS) delete result[attr];
  return result;
}

type Corner = "top-left" | "top-right" | "bottom-right" | "bottom-left";

function makeCornerArc(
  from: Point,
  to: Point,
  corner: Corner,
  radius: number,
): PathSegment {
  const x =
    corner === "top-left"
      ? from.x
      : corner === "top-right"
        ? from.x - radius
        : corner === "bottom-right"
          ? to.x - radius
          : to.x;

  const y =
    corner === "top-left"
      ? from.y - radius
      : corner === "top-right"
        ? from.y
        : corner === "bottom-right"
          ? to.y - 2 * radius
          : to.y - radius;

  const width = radius * 2;
  const height = radius * 2;

  const c = BEZIER_CIRCLE_C;
  const c1x = x + (width / 2) * (1 - c);
  const c2x = x + (width / 2) * (1 + c);
  const c1y = y + (height / 2) * (1 - c);
  const c2y = y + (height / 2) * (1 + c);

  const h1: Point =
    corner === "top-left"
      ? { x: from.x, y: c1y }
      : corner === "top-right"
        ? { x: c2x, y: from.y }
        : corner === "bottom-right"
          ? { x: from.x, y: c2y }
          : { x: c1x, y: from.y };

  const h2: Point =
    corner === "top-left"
      ? { x: c1x, y: to.y }
      : corner === "top-right"
        ? { x: to.x, y: c1y }
        : corner === "bottom-right"
          ? { x: c2x, y: to.y }
          : { x: to.x, y: c2y };

  return makeCurveTo(to, h1, h2);
}

interface Sized {
  x: number;
  y: number;
  width: number;
  height: number;
}

function circlePath(shape: Sized): PathSegment[] {
  const { x, y, width, height } = shape;
  const mx = x + width / 2;
  const my = y + height / 2;
  const ex = x + width;
  const ey = y + height;

  const p1: Point = { x: mx, y };
  const p2: Point = { x: ex, y: my };
  const p3: Point = { x: mx, y: ey };
  const p4: Point = { x, y: my };

  const c = BEZIER_CIRCLE_C;
  const c1x = x + (width / 2) * (1 - c);
  const c2x = x + (width / 2) * (1 + c);
  const c1y = y + (height / 2) * (1 - c);
  const c2y = y + (height / 2) * (1 + c);

  return [
    makeMoveTo(p1),
    makeCurveTo(p2, { x: c2x, y: p1.y }, { x: p2.x, y: c1y }),
    makeCurveTo(p3, { x: p2.x, y: c2y }, { x: c2x, y: p3.y }),
    makeCurveTo(p4, { x: c1x, y: p3.y }, { x: p4.x, y: c2y }),
    makeCurveTo(p1, { x: p4.x, y: c1y }, { x: c1x, y: p1.y }),
  ];
}

function drawRoundedRectPath(
  x: number,
  y: number,
  width: number,
  height: number,
  r1: number,
  r2: number,
  r3: number,
  r4: number,
): PathSegment[] {
  const p1: Point = { x, y: y + r1 };
  const p2: Point = { x: x + r1, y };

  const p3: Point = { x: x + width - r2, y };
  const p4: Point = { x: x + width, y: y + r2 };

  const p5: Point = { x: x + width, y: y + height - r3 };
  const p6: Point = { x: x + width - r3, y: y + height };

  const p7: Point = { x: x + r4, y: y + height };
  const p8: Point = { x, y: y + height - r4 };

  const same = (a: Point, b: Point): boolean => a.x === b.x && a.y === b.y;

  const result: PathSegment[] = [makeMoveTo(p1)];
  if (!same(p1, p2)) result.push(makeCornerArc(p1, p2, "top-left", r1));
  result.push(makeLineTo(p3));
  if (!same(p3, p4)) result.push(makeCornerArc(p3, p4, "top-right", r2));
  result.push(makeLineTo(p5));
  if (!same(p5, p6)) result.push(makeCornerArc(p5, p6, "bottom-right", r3));
  result.push(makeLineTo(p7));
  if (!same(p7, p8)) result.push(makeCornerArc(p7, p8, "bottom-left", r4));
  result.push(makeLineTo(p1));

  return result;
}

function zeroDiv(a: number, b: number): number {
  return almostZero(b) ? Infinity : a / b;
}

function fixRadius(
  width: number,
  height: number,
  radii: readonly number[],
): number[] {
  const [r1, r2, r3, r4] = radii;
  const f = Math.min(
    1,
    zeroDiv(width, r1 + r2),
    zeroDiv(height, r2 + r3),
    zeroDiv(width, r3 + r4),
    zeroDiv(height, r4 + r1),
  );

  return f < 1 ? [r1 * f, r2 * f, r3 * f, r4 * f] : [r1, r2, r3, r4];
}

function fixRadiusOne(width: number, height: number, r: number): number {
  const f = Math.min(1, zeroDiv(width, 2 * r), zeroDiv(height, 2 * r));
  return f < 1 ? r * f : r;
}

function shapeCorners1(shape: Shape): number {
  const r1 = shape.r1;
  if (typeof r1 === "number" && !almostZero(r1)) {
    return fixRadiusOne(shape.width as number, shape.height as number, r1);
  }
  return 0;
}

function shapeCorners4(shape: Shape): number[] {
  const { r1, r2, r3, r4 } = shape;
  if (
    typeof r1 === "number" &&
    typeof r2 === "number" &&
    typeof r3 === "number" &&
    typeof r4 === "number"
  ) {
    return fixRadius(shape.width as number, shape.height as number, [
      r1,
      r2,
      r3,
      r4,
    ]);
  }
  return [r1 ?? 0, r2 ?? 0, r3 ?? 0, r4 ?? 0];
}

function radiusMode(shape: Shape): "radius-1" | "radius-4" {
  return shape.r1 === shape.r2 &&
    shape.r1 === shape.r3 &&
    shape.r1 === shape.r4
    ? "radius-1"
    : "radius-4";
}

function rectPath(shape: Shape): PathSegment[] {
  const x = shape.x as number;
  const y = shape.y as number;
  const width = shape.width as number;
  const height = shape.height as number;

  if (radiusMode(shape) === "radius-1") {
    return drawRoundedRectPath(
      x,
      y,
      width,
      height,
      shapeCorners1(shape),
      shapeCorners1(shape),
      shapeCorners1(shape),
      shapeCorners1(shape),
    );
  }

  const [r1, r2, r3, r4] = shapeCorners4(shape);
  return drawRoundedRectPath(x, y, width, height, r1, r2, r3, r4);
}

function shapeTransform(shape: Shape): Matrix {
  let transform = shape.transform ?? IDENTITY;
  if (shape.flipX === true) {
    transform = multiply(transform, scaleMatrix(-1, 1));
  }
  if (shape.flipY === true) {
    transform = multiply(transform, scaleMatrix(1, -1));
  }
  return transform;
}

function selectStyleAttrs(shape: Shape | undefined): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (shape == null) return result;
  for (const attr of STYLE_ATTRS) {
    if (attr in shape) result[attr] = shape[attr];
  }
  return result;
}

function groupToPath(
  group: Shape,
  objects: Record<Uuid, Shape>,
): Record<string, unknown> {
  const children = (group.shapes ?? [])
    .map((id) => objects[id])
    .filter((shape): shape is Shape => shape != null)
    .map((shape) => convertToPath(shape, objects));

  const head = children[children.length - 1];
  const headData = selectStyleAttrs(head as Shape | undefined);

  const content = children
    .filter((child) => child.type === "path")
    .flatMap((child) => normalizeContent(child.content));

  return {
    ...withoutPositionAttrs(group as unknown as Shape),
    type: "path",
    content: normalizeContent(content),
    ...headData,
  };
}

function boolToPath(
  shape: Shape,
  objects: Record<Uuid, Shape>,
): Record<string, unknown> {
  const children = (shape.shapes ?? [])
    .map((id) => objects[id])
    .filter((child): child is Shape => child != null)
    .map((child) => convertToPath(child, objects));

  const contents = children.map((child) => normalizeContent(child.content));
  const content = calculateContent(
    shape.boolType as BoolType,
    contents,
  );

  const result: Record<string, unknown> = {
    ...withoutPositionAttrs(shape),
    type: "path",
    content: normalizeContent(content),
  };
  delete result.boolType;

  return result;
}

export function convertToPath(
  shape: Shape,
  objects: Record<Uuid, Shape>,
): Shape {
  const type = shape.type;

  if (type === "group" || type === "frame") {
    return groupToPath(shape, objects) as unknown as Shape;
  }

  if (type === "bool") {
    return boolToPath(shape, objects) as unknown as Shape;
  }

  if (
    type === "rect" ||
    type === "circle" ||
    type === "image" ||
    type === "text"
  ) {
    const sized = shape as unknown as Sized;
    const base = type === "circle" ? circlePath(sized) : rectPath(shape);

    const content = transformContent(
      normalizeContent(base),
      transformIn(
        rectToCenter(shape.selrect ?? makeRect()),
        shapeTransform(shape),
      ),
    );

    const result: Record<string, unknown> = {
      ...withoutPositionAttrs(shape),
      type: "path",
      content,
    };

    if (type === "image") {
      result.fillImage = (shape as Record<string, unknown>).metadata;
    }

    return result as unknown as Shape;
  }

  // The rest keeps the plain shape.
  return shape;
}

export function calcBoolContent(
  shape: Shape,
  objects: Record<Uuid, Shape>,
): PathSegment[] {
  const contents = (shape.shapes ?? [])
    .map((id) => objects[id])
    .filter((child): child is Shape => child != null)
    .filter((child) => child.hidden !== true)
    .filter((child) => child.type !== "svg-raw")
    .map((child) => normalizeContent(convertToPath(child, objects).content));

  return calculateContent(shape.boolType as BoolType, contents);
}

export function updateBoolShape(
  shape: Shape,
  objects: Record<Uuid, Shape>,
): Shape {
  return updateGeometry({
    ...shape,
    content: calcBoolContent(shape, objects),
  });
}
