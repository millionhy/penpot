// TypeScript mirror of the portable segment helpers in
// app.common.types.path.helpers and app.common.types.path.segment.
//
// Path content uses plain {command, params} objects. The packed renderer
// form is 28 bytes per segment: int16 command, four float32 control
// coordinates, then the destination x/y.

import { almostZero, distance, lerpPoint, type Point } from "@/lib/common/geom/point";
import { makeRect, pointsToRect, type Rect } from "@/lib/common/geom/rect";

export type PathCommand = "move-to" | "line-to" | "curve-to" | "close-path";

export interface PathSegment {
  command: PathCommand;
  params: Record<string, number>;
}

export { distance };

export type Line = [Point, Point];
export type Bezier = [Point, Point, Point, Point];

const SEGMENT_U8_SIZE = 28;

function point(x: number, y: number): Point {
  return { x, y };
}

export function sEqual(a: number, b: number): boolean {
  return almostZero(a - b);
}

export function makeMoveTo(to: Point): PathSegment {
  return { command: "move-to", params: { x: to.x, y: to.y } };
}

export function makeLineTo(to: Point): PathSegment {
  return { command: "line-to", params: { x: to.x, y: to.y } };
}

export function makeCurveParams(
  to: Point,
  h1: Point = to,
  h2: Point = to,
): Record<string, number> {
  return {
    x: to.x,
    y: to.y,
    c1x: h1.x,
    c1y: h1.y,
    c2x: h2.x,
    c2y: h2.y,
  };
}

export function makeCurveTo(to: Point, h1: Point, h2: Point): PathSegment {
  return { command: "curve-to", params: makeCurveParams(to, h1, h2) };
}

export function segmentToPoint(
  segment: PathSegment,
  coord: "x" | "c1" | "c2" = "x",
): Point | null {
  const params = segment.params;
  if (params === null || Object.keys(params).length === 0) return null;

  switch (coord) {
    case "c1":
      return point(params.c1x ?? 0, params.c1y ?? 0);
    case "c2":
      return point(params.c2x ?? 0, params.c2y ?? 0);
    default:
      return point(params.x ?? 0, params.y ?? 0);
  }
}

export function commandToLine(segment: PathSegment, prev?: Point): Line | null {
  const from = prev;
  const to = segmentToPoint(segment);
  return from === undefined || to === null ? null : [from, to];
}

export function commandToBezier(segment: PathSegment, prev?: Point): Bezier | null {
  const to = segmentToPoint(segment);
  const h1 = segmentToPoint(segment, "c1");
  const h2 = segmentToPoint(segment, "c2");
  return prev === undefined || to === null || h1 === null || h2 === null
    ? null
    : [prev, to, h1, h2];
}

// command->selrect: only the endpoints and curve extrema widen a segment.
export function commandToSelrect(segment: PathSegment, prev?: Point): Rect {
  const to = segmentToPoint(segment);
  switch (segment.command) {
    case "move-to":
      return to === null ? makeRect() : pointsToRect([to]) ?? makeRect();
    case "line-to":
      return prev === undefined || to === null
        ? makeRect()
        : pointsToRect([prev, to]) ?? makeRect();
    case "curve-to": {
      const h1 = segmentToPoint(segment, "c1");
      const h2 = segmentToPoint(segment, "c2");
      if (prev === undefined || to === null || h1 === null || h2 === null) return makeRect();
      const points = [prev, to, ...calculateCurveExtremities(prev, to, h1, h2)];
      return pointsToRect(points) ?? makeRect();
    }
    default:
      return makeRect();
  }
}

export function lineValues(line: Line, t: number): Point {
  return {
    x: line[0].x + (line[1].x - line[0].x) * t,
    y: line[0].y + (line[1].y - line[0].y) * t,
  };
}

export function lineWindup(line: Line, t: number): number {
  const current = lineValues(line, t);
  const endY = line[1].y;
  const startY = line[0].y;
  if (current.y - endY > 0 && !sEqual(current.y, endY)) return 1;
  if (current.y - endY < 0 && !sEqual(current.y, endY)) return -1;
  if (current.y - startY < 0) return 1;
  if (current.y - startY > 0) return -1;
  return 0;
}

export function curveValues(curve: Bezier, t: number): Point {
  const [start, end, h1, h2] = curve;
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

function cubicRoot(value: number): number {
  return value > 0 ? Math.pow(value, 1 / 3) : -Math.pow(-value, 1 / 3);
}

// solve-roots*: the real roots of a quadratic or cubic equation.
export function solveRoots(a: number, b: number, c: number, d = 0): number[] {
  const result: number[] = [];
  const sqrtB24ac = Math.sqrt(b * b - 4 * a * c);

  if (almostZero(d) && almostZero(a) && almostZero(b)) return result;
  if (almostZero(d) && almostZero(a)) {
    result.push(-c / b);
    return result;
  }
  if (almostZero(d)) {
    result.push((-b + sqrtB24ac) / (2 * a));
    result.push((-b - sqrtB24ac) / (2 * a));
    return result;
  }

  a /= d;
  b /= d;
  c /= d;
  const p = (3 * b - a * a) / 3;
  const q = (2 * a * a * a - 9 * a * b + 27 * c) / 27;
  const p3 = p / 3;
  const q2 = q / 2;
  const discriminant = q2 * q2 + p3 * p3 * p3;

  if (discriminant < 0) {
    const mp3 = -p / 3;
    const r = Math.sqrt(mp3 * mp3 * mp3);
    const t = -q / (2 * r);
    const cosphi = t < -1 ? -1 : t > 1 ? 1 : t;
    const phi = Math.acos(cosphi);
    const crtr = cubicRoot(r);
    const t1 = 2 * crtr;
    result.push(t1 * Math.cos(phi / 3) - a / 3);
    result.push(t1 * Math.cos((phi + 2 * Math.PI) / 3) - a / 3);
    result.push(t1 * Math.cos((phi + 4 * Math.PI) / 3) - a / 3);
    return result;
  }

  if (almostZero(discriminant)) {
    const u1 = q2 < 0 ? cubicRoot(-q2) : -cubicRoot(q2);
    result.push(2 * u1 - a / 3);
    result.push(-u1 - a / 3);
    return result;
  }

  const sd = Math.sqrt(discriminant);
  const u1 = cubicRoot(-sd - q2);
  const v1 = cubicRoot(sd + q2);
  result.push(u1 - v1 - a / 3);
  return result;
}

export function curveExtremities(curve: Bezier): number[] {
  const [start, end, h1, h2] = curve;
  const coords = [
    [start.x, h1.x, h2.x, end.x],
    [start.y, h1.y, h2.y, end.y],
  ];
  const result: number[] = [];
  for (const [c0, c1, c2, c3] of coords) {
    result.push(
      ...solveRoots(
        -3 * c0 + 9 * c1 - 9 * c2 + 3 * c3,
        6 * c0 - 12 * c1 + 6 * c2,
        3 * c1 - 3 * c0,
      ),
    );
  }
  return result.filter((t) => t > 0.01 && t < 0.99);
}

export function calculateCurveExtremities(
  start: Point,
  end: Point,
  h1: Point,
  h2: Point,
): Point[] {
  return curveExtremities([start, end, h1, h2]).map((t) => curveValues([start, end, h1, h2], t));
}

export function curveTangent(curve: Bezier, t: number): Point {
  const [start, end, h1, h2] = curve;
  const axes = [
    [start.x, h1.x, h2.x, end.x],
    [start.y, h1.y, h2.y, end.y],
  ];
  const derivative = ([c0, c1, c2, c3]: number[]): number => {
    const t2 = t * t;
    return (
      c0 * (-3 * t2 + 6 * t - 3) +
      c1 * (9 * t2 - 12 * t + 3) +
      c2 * (-9 * t2 + 6 * t) +
      c3 * (3 * t2)
    );
  };
  const x = derivative(axes[0]);
  const y = derivative(axes[1]);
  const length = Math.hypot(x, y);
  return almostZero(length) ? point(0, 0) : point(x / length, y / length);
}

export function curveWindup(curve: Bezier, t: number): number {
  const tangent = curveTangent(curve, t);
  if (tangent.y > 0) return -1;
  if (tangent.y < 0) return 1;
  return 0;
}

export function curveSplit(curve: Bezier, t: number): [Bezier, Bezier] {
  const [start, end, h1, h2] = curve;
  const p1 = lerpPoint(start, h1, t);
  const p2 = lerpPoint(h1, h2, t);
  const p3 = lerpPoint(h2, end, t);
  const p4 = lerpPoint(p1, p2, t);
  const p5 = lerpPoint(p2, p3, t);
  const split = lerpPoint(p4, p5, t);
  return [
    [start, split, p1, p4],
    [split, end, p5, p3],
  ];
}

export function splitLineTo(
  from: Point,
  segment: PathSegment,
  t: number,
): [PathSegment, PathSegment] {
  const to = segmentToPoint(segment);
  if (to === null) return [{ ...segment }, { ...segment }];
  return [makeLineTo(lerpPoint(from, to, t)), segment];
}

export function splitCurveTo(
  from: Point,
  segment: PathSegment,
  t: number,
): [PathSegment, PathSegment] {
  const to = segmentToPoint(segment);
  const h1 = segmentToPoint(segment, "c1");
  const h2 = segmentToPoint(segment, "c2");
  if (to === null || h1 === null || h2 === null) return [{ ...segment }, { ...segment }];
  const [first, second] = curveSplit([from, to, h1, h2], t);
  return [
    makeCurveTo(first[1], first[2], first[3]),
    makeCurveTo(second[1], second[2], second[3]),
  ];
}

export function subcurveRange(curve: Bezier, t1: number, t2: number): Bezier {
  const [from, to] = t1 < t2 ? [t1, t2] : [t2, t1];
  const relative = (to - from) / (1 - from);
  const [, after] = curveSplit(curve, from);
  return curveSplit(after, relative)[0];
}

export function splitLineToRanges(
  from: Point,
  segment: PathSegment,
  values: readonly number[],
): PathSegment[] {
  const filtered = values.filter((value) => value > 0 && value < 1);
  if (filtered.length === 0) return [segment];
  const to = segmentToPoint(segment);
  if (to === null) return [segment];
  const sorted = [...new Set([...filtered, 1])].sort((a, b) => a - b);
  return sorted.map((value) => makeLineTo(lerpPoint(from, to, value)));
}

export function splitCurveToRanges(
  from: Point,
  segment: PathSegment,
  values: readonly number[],
): PathSegment[] {
  const filtered = values.filter((value) => value > 0 && value < 1);
  if (filtered.length === 0) return [segment];
  const to = segmentToPoint(segment);
  const h1 = segmentToPoint(segment, "c1");
  const h2 = segmentToPoint(segment, "c2");
  if (to === null || h1 === null || h2 === null) return [segment];
  const sorted = [...new Set([...filtered, 0, 1])].sort((a, b) => a - b);
  const result: PathSegment[] = [];
  for (let index = 1; index < sorted.length; index += 1) {
    const part = subcurveRange([from, to, h1, h2], sorted[index - 1], sorted[index]);
    result.push(makeCurveTo(part[1], part[2], part[3]));
  }
  return result;
}

export function getLineTval(line: Line, pt: Point): number {
  const [from, to] = line;
  if (sEqual(from.x, to.x) && sEqual(from.y, to.y)) return Number.POSITIVE_INFINITY;
  if (sEqual(from.x, to.x)) return (pt.y - from.y) / (to.y - from.y);
  return (pt.x - from.x) / (to.x - from.x);
}

export function curveRangeToRect(curve: Bezier, fromT: number, toT: number): Rect {
  const sub = subcurveRange(curve, fromT, toT);
  const points = [sub[0], sub[1], ...calculateCurveExtremities(sub[0], sub[1], sub[2], sub[3])];
  return pointsToRect(points) ?? makeRect();
}

export function lineHasPoint(pt: Point, line: Line): boolean {
  const [from, to] = line;
  if (sEqual(from.x, to.x)) return sEqual(pt.x, from.x);
  const slope = (to.y - from.y) / (to.x - from.x);
  return sEqual(pt.y, slope * pt.x - slope * from.x + from.y);
}

export function segmentHasPoint(pt: Point, line: Line): boolean {
  if (!lineHasPoint(pt, line)) return false;
  const t = getLineTval(line, pt);
  return (t > 0 || sEqual(t, 0)) && (t < 1 || sEqual(t, 1));
}

export function curveHasPoint(pt: Point, curve: Bezier): boolean {
  const checkRange = (fromT: number, toT: number): boolean => {
    if (!containsRectPoint(curveRangeToRect(curve, fromT, toT), pt)) return false;
    if (sEqual(fromT, toT)) {
      const value = curveValues(curve, fromT);
      return Math.hypot(value.x - pt.x, value.y - pt.y) < 0.1;
    }
    const half = fromT + (toT - fromT) / 2;
    return checkRange(fromT, half) || checkRange(half, toT);
  };
  return checkRange(0, 1);
}

function containsRectPoint(rect: Rect, pt: Point): boolean {
  return (
    (pt.x > rect.x || sEqual(pt.x, rect.x)) &&
    (pt.x < rect.x2 || sEqual(pt.x, rect.x2)) &&
    (pt.y > rect.y || sEqual(pt.y, rect.y)) &&
    (pt.y < rect.y2 || sEqual(pt.y, rect.y2))
  );
}

export function curveRoots(curve: Bezier, coord: "x" | "y"): number[] {
  const [start, end, h1, h2] = curve;
  const [pa, pb, pc, pd] = [start[coord], h1[coord], h2[coord], end[coord]];
  return solveRoots(
    3 * pa - 6 * pb + 3 * pc,
    -3 * pa + 3 * pb,
    pa,
    -pa + 3 * pb - 3 * pc + pd,
  ).filter((t) => t >= 0 && t <= 1);
}

export function lineLineCrossing(l1: Line, l2: Line): [number, number] | null {
  const [fromP1, toP1] = l1;
  const [fromP2, toP2] = l2;
  const nx =
    (fromP2.x - toP2.x) * (fromP1.x * toP1.y - fromP1.y * toP1.x) -
    (fromP1.x - toP1.x) * (fromP2.x * toP2.y - fromP2.y * toP2.x);
  const ny =
    (fromP2.y - toP2.y) * (fromP1.x * toP1.y - fromP1.y * toP1.x) -
    (fromP1.y - toP1.y) * (fromP2.x * toP2.y - fromP2.y * toP2.x);
  const denominator =
    (fromP1.x - toP1.x) * (fromP2.y - toP2.y) -
    (fromP1.y - toP1.y) * (fromP2.x - toP2.x);

  if (!almostZero(denominator)) {
    const cross = point(nx / denominator, ny / denominator);
    return [getLineTval(l1, cross), getLineTval(l2, cross)];
  }
  if (lineHasPoint(fromP2, l1)) return [getLineTval(l1, fromP2), 0];
  if (lineHasPoint(toP2, l1)) return [getLineTval(l1, toP2), 1];
  if (lineHasPoint(toP1, l2)) return [1, getLineTval(l2, toP1)];
  if (lineHasPoint(fromP1, l2)) return [0, getLineTval(l2, fromP1)];
  return null;
}

export function lineLineIntersect(
  l1: Line,
  l2: Line,
): [number[], number[]] | null {
  const crossing = lineLineCrossing(l1, l2);
  if (crossing === null) return null;
  const [t1, t2] = crossing;
  const inside =
    (t1 > 0 || sEqual(t1, 0)) &&
    (t1 < 1 || sEqual(t1, 1)) &&
    (t2 > 0 || sEqual(t2, 0)) &&
    (t2 < 1 || sEqual(t2, 1));
  return inside ? [[t1], [t2]] : null;
}

export function lineCurveCrossing(line: Line, curve: Bezier): number[] {
  const [from, to] = line;
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const cos = Math.cos(-angle);
  const sin = Math.sin(-angle);
  const transform = (p: Point): Point => ({
    x: p.x * cos - p.y * sin - from.x * cos + from.y * sin,
    y: p.x * sin + p.y * cos - from.x * sin - from.y * cos,
  });
  return curveRoots(
    [transform(curve[0]), transform(curve[1]), transform(curve[2]), transform(curve[3])],
    "y",
  );
}

export function lineCurveIntersect(
  line: Line,
  curve: Bezier,
): [number[], number[]] {
  const curveTs = lineCurveCrossing(line, curve).filter((curveT) => {
    const t = almostZero(curveT) ? 0 : curveT;
    const value = curveValues(curve, t);
    const lineT = getLineTval(line, value);
    return t >= 0 && t <= 1 && lineT >= 0 && lineT <= 1;
  });
  return [curveTs.map((t) => getLineTval(line, curveValues(curve, t))), curveTs];
}

export interface GeomData {
  command: "line-to" | "curve-to";
  geom: Line | Bezier;
  selrect: Rect;
}

export function rayOverlaps(pt: Point, data: GeomData): boolean {
  return (
    (pt.y > data.selrect.y1 || almostZero(pt.y - data.selrect.y1)) &&
    (pt.y < data.selrect.y2 || almostZero(pt.y - data.selrect.y2))
  );
}

export function rayLineIntersect(pt: Point, line: Line): Array<[Point, number]> {
  const ray: Line = [pt, point(pt.x + 1, pt.y)];
  const a = sEqual(line[0].y, pt.y) ? point(line[0].x, line[0].y + 10) : line[0];
  const b = sEqual(line[1].y, pt.y) ? point(line[1].x, line[1].y + 10) : line[1];
  const crossing = lineLineCrossing(ray, [a, b]);
  if (crossing === null) return [];
  const [rayT, lineT] = crossing;
  const valid =
    rayT > 0 &&
    (lineT > 0 || sEqual(lineT, 0)) &&
    (lineT < 1 || sEqual(lineT, 1));
  return valid ? [[lineValues(line, lineT), lineWindup(line, lineT)]] : [];
}

export function rayCurveIntersect(ray: Line, curve: Bezier): Array<[Point, number]> {
  return lineCurveCrossing(ray, curve)
    .filter((t) => {
      const value = curveValues(curve, t);
      const tangent = curveTangent(curve, t);
      const angle = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
      return getLineTval(ray, value) > 0 && Math.abs(angle - 180) > 0.01 && Math.abs(angle) > 0.01;
    })
    .map((t) => [curveValues(curve, t), curveWindup(curve, t)]);
}

export function isPointInGeomData(pt: Point, data: readonly GeomData[]): boolean {
  const ray: Line = [pt, point(pt.x + 1, pt.y)];
  let windup = 0;
  for (const item of data) {
    if (!rayOverlaps(pt, item)) continue;
    const hits =
      item.command === "line-to"
        ? rayLineIntersect(pt, item.geom as Line)
        : rayCurveIntersect(ray, item.geom as Bezier);
    for (const [, value] of hits) windup += value;
  }
  return windup !== 0;
}

export function isPointInBorder(pt: Point, content: readonly PathSegment[]): boolean {
  let previous: Point | undefined;
  for (const segment of content) {
    const to = segmentToPoint(segment);
    if (segment.command === "line-to" && previous !== undefined && to !== null) {
      if (segmentHasPoint(pt, [previous, to])) return true;
    } else if (segment.command === "curve-to" && previous !== undefined && to !== null) {
      const h1 = segmentToPoint(segment, "c1");
      const h2 = segmentToPoint(segment, "c2");
      if (h1 !== null && h2 !== null && curveHasPoint(pt, [previous, to, h1, h2])) return true;
    }
    if (
      segment.command === "move-to" ||
      segment.command === "line-to" ||
      segment.command === "curve-to"
    ) {
      previous = to ?? previous;
    } else {
      previous = undefined;
    }
  }
  return false;
}

function pointKey(pt: Point): string {
  return `${pt.x},${pt.y}`;
}

function calculateExtremities(content: readonly PathSegment[]): Point[] {
  const points = new Map<string, Point>();
  const add = (pt: Point | null): void => {
    if (pt !== null) points.set(pointKey(pt), pt);
  };

  let segments = content.slice();
  let from: Point | null = null;
  let move: Point | null = null;
  while (segments.length > 0) {
    if (segments[segments.length - 1].command === "move-to") {
      segments = segments.slice(0, -1);
    }
    if (segments.length === 0) break;

    const segment = segments[0];
    const to = segmentToPoint(segment);
    switch (segment.command) {
      case "move-to":
        add(to);
        from = to;
        move = to;
        break;
      case "close-path":
        add(move);
        from = move;
        break;
      case "line-to":
        if (from !== null && to !== null) {
          add(from);
          add(to);
        }
        from = to;
        break;
      case "curve-to": {
        const h1 = segmentToPoint(segment, "c1");
        const h2 = segmentToPoint(segment, "c2");
        if (from !== null && to !== null && h1 !== null && h2 !== null) {
          add(from);
          add(to);
          for (const extreme of calculateCurveExtremities(from, to, h1, h2)) add(extreme);
        }
        from = to;
        break;
      }
    }
    segments = segments.slice(1);
  }
  return [...points.values()];
}

// content->selrect: the empty content gets the 0.01 default rect.
export function contentToSelrect(content: readonly PathSegment[]): Rect {
  const extremes = calculateExtremities(content);
  if (extremes.length > 0) return pointsToRect(extremes) ?? makeRect();

  const points = content.flatMap((segment) => {
    const pt = segmentToPoint(segment);
    return pt === null ? [] : [pt];
  });
  return points.length > 0 ? pointsToRect(points) ?? makeRect() : makeRect();
}

export function contentCenter(content: readonly PathSegment[]): Point {
  const rect = contentToSelrect(content);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

// points->content: a move-to followed by one line-to per point.
export function pointsToSegments(
  points: readonly Point[],
  options: { close?: boolean } = {},
): PathSegment[] {
  if (points.length === 0) return [];
  const segments: PathSegment[] = [makeMoveTo(points[0])];
  for (const pt of points.slice(1)) segments.push(makeLineTo(pt));
  if (options.close === true) segments.push({ command: "close-path", params: {} });
  return segments;
}

interface PackedReader {
  view: DataView;
}

function readPackedSegment(reader: PackedReader, offset: number): PathSegment | null {
  const { view } = reader;
  const command = view.getInt16(offset, true);
  const to = { x: view.getFloat32(offset + 20, true), y: view.getFloat32(offset + 24, true) };
  switch (command) {
    case 1:
      return { command: "move-to", params: to };
    case 2:
      return { command: "line-to", params: to };
    case 3:
      return {
        command: "curve-to",
        params: {
          c1x: view.getFloat32(offset + 4, true),
          c1y: view.getFloat32(offset + 8, true),
          c2x: view.getFloat32(offset + 12, true),
          c2y: view.getFloat32(offset + 16, true),
          ...to,
        },
      };
    case 4:
      return { command: "close-path", params: {} };
    default:
      return null;
  }
}

function unpackSegments(bytes: Uint8Array): PathSegment[] {
  const reader = { view: new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength) };
  const segments: PathSegment[] = [];
  for (let offset = 0; offset + SEGMENT_U8_SIZE <= bytes.byteLength; offset += SEGMENT_U8_SIZE) {
    const segment = readPackedSegment(reader, offset);
    if (segment !== null) segments.push(segment);
  }
  return segments;
}

// path-segments: decoded PathData, plain segments, or packed bytes.
export function pathSegments(content: unknown): PathSegment[] {
  if (Array.isArray(content)) {
    return content.filter(
      (value): value is PathSegment =>
        value !== null &&
        typeof value === "object" &&
        typeof (value as PathSegment).command === "string",
    );
  }
  if (content instanceof Uint8Array) return unpackSegments(content);
  if (content instanceof ArrayBuffer) return unpackSegments(new Uint8Array(content));
  if (content !== null && typeof content === "object") {
    const toSegments = (content as { toSegments?: unknown }).toSegments;
    if (typeof toSegments === "function") {
      const segments = toSegments.call(content);
      return Array.isArray(segments) ? pathSegments(segments) : [];
    }
  }
  return [];
}
