// TypeScript mirror of app.common.geom.rect.
//
// Rects carry both the position/size pair and the derived corners (x1,y1,x2,y2)
// because the CLJS record stores all eight fields. make-rect keeps the 0.01
// minimum size of the original and the same near-zero tolerance for edge
// comparisons.

import { almostZero, type Point } from "./point";

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

export interface RectLike {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
}

const MIN_SIZE = 0.01;

export function makeRect(): Rect;
export function makeRect(data: RectLike): Rect;
export function makeRect(p1: Point, p2: Point): Rect;
export function makeRect(x: number, y: number, width: number, height: number): Rect;
export function makeRect(
  a: RectLike | Point | number = 0,
  b: Point | number = 0,
  c?: number,
  d?: number,
): Rect {
  if (typeof a === "number") {
    const x = a;
    const y = typeof b === "number" ? b : 0;
    return fromPosition(x, y, c ?? MIN_SIZE, d ?? MIN_SIZE);
  }
  if (typeof b === "object") {
    const xp1 = (a as Point).x;
    const yp1 = (a as Point).y;
    const xp2 = b.x;
    const yp2 = b.y;
    return fromPosition(Math.min(xp1, xp2), Math.min(yp1, yp2), Math.abs(xp2 - xp1), Math.abs(yp2 - yp1));
  }
  const data = a as RectLike;
  return fromPosition(data.x ?? 0, data.y ?? 0, data.width ?? MIN_SIZE, data.height ?? MIN_SIZE);
}

function fromPosition(x: number, y: number, width: number, height: number): Rect {
  const w = Math.max(width, MIN_SIZE);
  const h = Math.max(height, MIN_SIZE);
  return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
}

// update-rect: refresh the corners from the position, or the position from
// the corners.
export function updateRect(rect: Rect, type: "size" | "position" | "corners"): Rect {
  if (type === "corners") {
    const x = Math.min(rect.x1, rect.x2);
    const y = Math.min(rect.y1, rect.y2);
    return {
      ...rect,
      x,
      y,
      width: Math.abs(rect.x2 - rect.x1),
      height: Math.abs(rect.y2 - rect.y1),
    };
  }
  return { ...rect, x1: rect.x, y1: rect.y, x2: rect.x + rect.width, y2: rect.y + rect.height };
}

export function rectClose(rect1: Rect, rect2: Rect, precision = 1e-3): boolean {
  const close = (a: number, b: number) => Math.abs(a - b) <= precision;
  return (
    close(rect1.x, rect2.x) &&
    close(rect1.y, rect2.y) &&
    close(rect1.width, rect2.width) &&
    close(rect1.height, rect2.height)
  );
}

export function rectToPoints(rect: Rect): Point[] {
  const { x, y } = rect;
  const w = Math.max(rect.width, MIN_SIZE);
  const h = Math.max(rect.height, MIN_SIZE);
  return [
    { x, y },
    { x: x + w, y },
    { x: x + w, y: y + h },
    { x, y: y + h },
  ];
}

export function rectToPoint(rect: Rect): Point {
  return { x: rect.x, y: rect.y };
}

export function rectToCenter(rect: Rect): Point {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

export function rectToLines(rect: Rect): [Point, Point][] {
  const [p1, p2, p3, p4] = rectToPoints(rect);
  return [
    [p1, p2],
    [p2, p3],
    [p3, p4],
    [p4, p1],
  ];
}

export function pointsToRect(points: readonly Point[]): Rect | undefined {
  if (points.length === 0) return undefined;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const p of points) {
    minX = Math.min(minX, p.x);
    minY = Math.min(minY, p.y);
    maxX = Math.max(maxX, p.x);
    maxY = Math.max(maxY, p.y);
  }
  if (![minX, minY, maxX, maxY].every(Number.isFinite)) return undefined;
  return fromPosition(minX, minY, maxX - minX, maxY - minY);
}

// bounds->rect: the axis-aligned box of the four transformed corners.
export function boundsToRect(bounds: readonly Point[]): Rect | undefined {
  if (bounds.length === 0) return undefined;
  return pointsToRect(bounds);
}

interface SquaredLike {
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
}

// squared-points: the corners of the union of rects that carry x2/y2.
export function squaredPoints(items: readonly SquaredLike[]): Point[] | undefined {
  const valid = items.filter(
    (item) => typeof item.x === "number" && typeof item.y === "number" && typeof item.x2 === "number" && typeof item.y2 === "number",
  );
  if (valid.length === 0) return undefined;
  const minX = Math.min(...valid.map((item) => item.x as number));
  const minY = Math.min(...valid.map((item) => item.y as number));
  const maxX = Math.max(...valid.map((item) => item.x2 as number));
  const maxY = Math.max(...valid.map((item) => item.y2 as number));
  return [
    { x: minX, y: minY },
    { x: maxX, y: minY },
    { x: maxX, y: maxY },
    { x: minX, y: maxY },
  ];
}

export function joinRects(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const minX = Math.min(...rects.map((rect) => rect.x));
  const minY = Math.min(...rects.map((rect) => rect.y));
  const maxX = Math.max(...rects.map((rect) => rect.x2));
  const maxY = Math.max(...rects.map((rect) => rect.y2));
  return fromPosition(minX, minY, maxX - minX, maxY - minY);
}

// center->rect: a rect centered on the point.
export function centerToRect(center: Point, size: number): Rect;
export function centerToRect(center: Point, width: number, height: number): Rect;
export function centerToRect(center: Point, width: number, height = width): Rect {
  return fromPosition(center.x - width / 2, center.y - height / 2, width, height);
}

const nearlyEqual = (a: number, b: number): boolean => almostZero(a - b);

export function overlapsRects(rectA: Rect, rectB: Rect): boolean {
  const x2a = rectA.x + rectA.width;
  const y2a = rectA.y + rectA.height;
  const x2b = rectB.x + rectB.width;
  const y2b = rectB.y + rectB.height;
  return (
    (x2a > rectB.x || nearlyEqual(x2a, rectB.x)) &&
    (x2b >= rectA.x || nearlyEqual(x2b, rectA.x)) &&
    (rectB.y <= y2a || nearlyEqual(rectB.y, y2a)) &&
    (rectA.y <= y2b || nearlyEqual(rectA.y, y2b))
  );
}

export function containsPoint(rect: Rect, p: Point): boolean {
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return (
    (p.x > rect.x || nearlyEqual(p.x, rect.x)) &&
    (p.x < x2 || nearlyEqual(p.x, x2)) &&
    (p.y > rect.y || nearlyEqual(p.y, rect.y)) &&
    (p.y < y2 || nearlyEqual(p.y, y2))
  );
}

// contains-rect?: sra contains srb, comparing the corner fields.
export function containsRect(sra: Rect, srb: Rect): boolean {
  return srb.x1 >= sra.x1 && srb.x2 <= sra.x2 && srb.y1 >= sra.y1 && srb.y2 <= sra.y2;
}

export function cornersToRect(p1: Point, p2: Point): Rect;
export function cornersToRect(x1: number, y1: number, x2: number, y2: number): Rect;
export function cornersToRect(a: Point | number, b: Point | number, c?: number, d?: number): Rect {
  const xp1 = typeof a === "number" ? a : a.x;
  const yp1 = typeof a === "number" ? (b as number) : a.y;
  const xp2 = typeof a === "number" ? (c as number) : (b as Point).x;
  const yp2 = typeof a === "number" ? (d as number) : (b as Point).y;
  return fromPosition(Math.min(xp1, xp2), Math.min(yp1, yp2), Math.abs(xp1 - xp2), Math.abs(yp1 - yp2));
}

export function clipRect(selrect: Rect, bounds: Rect): Rect {
  return cornersToRect(
    Math.max(bounds.x1, selrect.x1),
    Math.max(bounds.y1, selrect.y1),
    Math.min(bounds.x2, selrect.x2),
    Math.min(bounds.y2, selrect.y2),
  );
}

export function fixAspectRatio(bounds: Rect, aspectRatio: number | null | undefined): Rect {
  if (!aspectRatio) return bounds;
  const targetHeight = bounds.width * aspectRatio;
  const targetWidth = bounds.height * (1 / aspectRatio);
  if (targetHeight > bounds.height) {
    return {
      ...bounds,
      height: targetHeight,
      y: bounds.y - (targetHeight - bounds.height) / 2,
    };
  }
  if (targetHeight < bounds.height) {
    return {
      ...bounds,
      width: targetWidth,
      x: bounds.x - (targetWidth - bounds.width) / 2,
    };
  }
  return bounds;
}
