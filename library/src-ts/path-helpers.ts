// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `app.common.types.path.helpers`: the point, line and cubic
// bezier primitives the boolean operations build on.

import type { PathSegment, Point, Rect } from "./model.ts";
import {
  applyMatrix,
  containsPoint,
  makeRect,
  overlapsRects,
  pointsToRect,
  rotateMatrix,
  translate,
} from "./geometry.ts";

export interface PrevSegment extends PathSegment {
  prev?: Point;
}

export type Line = [Point, Point];
export type Bezier = [Point, Point, Point, Point];

export const CURVE_CURVE_PRECISION = 0.1;
export const CURVE_RANGE_PRECISION = 2;

export function almostZero(value: number): boolean {
  return Math.abs(value) < 1e-4;
}

export function sEqual(a: number, b: number): boolean {
  return almostZero(a - b);
}

export function closeNum(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.001;
}

export function point(x: number, y: number): Point {
  return { x, y };
}

export function addPoints(a: Point, b: Point): Point {
  return { x: a.x + b.x, y: a.y + b.y };
}

export function subtractPoints(a: Point, b: Point): Point {
  return { x: a.x - b.x, y: a.y - b.y };
}

export function scalePoint(a: Point, scalar: number): Point {
  return { x: a.x * scalar, y: a.y * scalar };
}

export function lerpValue(v0: number, v1: number, t: number): number {
  return (1 - t) * v0 + t * v1;
}

export function lerpPoint(a: Point, b: Point, t: number): Point {
  return {
    x: lerpValue(a.x, b.x, t),
    y: lerpValue(a.y, b.y, t),
  };
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function precision(value: number, digits: number): number {
  const d = Math.pow(10, digits);
  return Math.round(value * d) / d;
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
  const params = segment.params ?? {};
  if (Object.keys(params).length === 0) return null;

  switch (coord) {
    case "c1":
      return { x: params.c1x ?? 0, y: params.c1y ?? 0 };
    case "c2":
      return { x: params.c2x ?? 0, y: params.c2y ?? 0 };
    default:
      return { x: params.x ?? 0, y: params.y ?? 0 };
  }
}

export function commandToLine(segment: PrevSegment): Line {
  return [segment.prev as Point, segmentToPoint(segment) as Point];
}

export function commandToBezier(segment: PrevSegment): Bezier {
  return [
    segment.prev as Point,
    segmentToPoint(segment) as Point,
    segmentToPoint(segment, "c1") as Point,
    segmentToPoint(segment, "c2") as Point,
  ];
}

export function commandToSelrect(command: PrevSegment): Rect {
  const to = segmentToPoint(command);
  if (to == null) return makeRect();

  switch (command.command) {
    case "move-to":
      return pointsToRect([to]);

    case "line-to":
      return pointsToRect([command.prev as Point, to]);

    case "curve-to": {
      const curve: Bezier = [
        command.prev as Point,
        to,
        segmentToPoint(command, "c1") as Point,
        segmentToPoint(command, "c2") as Point,
      ];
      const points = [curve[0], curve[1]];
      for (const t of curveExtremities(curve)) {
        points.push(curveValues(curve, t));
      }
      return pointsToRect(points);
    }

    default:
      return pointsToRect([]);
  }
}

export function lineValues(line: Line, t: number): Point {
  const move = scalePoint(subtractPoints(line[1], line[0]), t);
  return addPoints(line[0], move);
}

export function lineWindup(line: Line, t: number): number {
  const p = lineValues(line, t);
  const cy = p.y;
  const ay = line[1].y;
  const by = line[0].y;

  if (cy - ay > 0 && !sEqual(cy, ay)) return 1;
  if (cy - ay < 0 && !sEqual(cy, ay)) return -1;
  if (cy - by < 0) return 1;
  if (cy - by > 0) return -1;
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
  if (value > 0) return Math.pow(value, 1 / 3);
  return -Math.pow(-value, 1 / 3);
}

export function solveRoots(
  a: number,
  b: number,
  c: number,
  d = 0,
): number[] {
  const result: number[] = [];
  const sqrtB24ac = Math.sqrt(b * b - 4 * a * c);

  if (almostZero(d) && almostZero(a) && almostZero(b)) {
    return result;
  }

  if (almostZero(d) && almostZero(a)) {
    result.push(-c / b);
    return result;
  }

  if (almostZero(d)) {
    result.push((-b + sqrtB24ac) / (2 * a));
    result.push((-b - sqrtB24ac) / (2 * a));
    return result;
  }

  a = a / d;
  b = b / d;
  c = c / d;

  const p = (3 * b - a * a) / 3;
  const q = (2 * a * a * a - 9 * a * b + 27 * c) / 27;
  const p3 = p / 3;
  const q2 = q / 2;
  const discriminant = q2 * q2 + p3 * p3 * p3;

  if (discriminant < 0) {
    const mp3 = -p / 3;
    const mp33 = mp3 * mp3 * mp3;
    const r = Math.sqrt(mp33);
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
  const coords: number[][] = [
    [start.x, h1.x, h2.x, end.x],
    [start.y, h1.y, h2.y, end.y],
  ];

  const result: number[] = [];
  for (const [c0, c1, c2, c3] of coords) {
    const a = -3 * c0 + 9 * c1 - 9 * c2 + 3 * c3;
    const b = 6 * c0 - 12 * c1 + 6 * c2;
    const c = 3 * c1 - 3 * c0;
    result.push(...solveRoots(a, b, c));
  }

  return result.filter((t) => t > 0.01 && t < 0.99);
}

export function calculateCurveExtremities(
  start: Point,
  end: Point,
  h1: Point,
  h2: Point,
): Point[] {
  const coords: number[][] = [
    [start.x, h1.x, h2.x, end.x],
    [start.y, h1.y, h2.y, end.y],
  ];

  const result: Point[] = [];
  for (const [c0, c1, c2, c3] of coords) {
    const a = -3 * c0 + 9 * c1 - 9 * c2 + 3 * c3;
    const b = 6 * c0 - 12 * c1 + 6 * c2;
    const c = 3 * c1 - 3 * c0;

    for (const t of solveRoots(a, b, c)) {
      if (!(t > 0.01 && t < 0.99)) continue;
      const t2 = t * t;
      const t3 = t2 * t;
      const startV = -t3 + 3 * t2 - 3 * t + 1;
      const h1V = 3 * t3 - 6 * t2 + 3 * t;
      const h2V = -3 * t3 + 3 * t2;
      const endV = t3;
      result.push({
        x: start.x * startV + h1.x * h1V + h2.x * h2V + end.x * endV,
        y: start.y * startV + h1.y * h1V + h2.y * h2V + end.y * endV,
      });
    }
  }

  return result;
}

export function curveTangent(curve: Bezier, t: number): Point {
  const [start, end, h1, h2] = curve;
  const coords: number[][] = [
    [start.x, h1.x, h2.x, end.x],
    [start.y, h1.y, h2.y, end.y],
  ];

  const solveDerivative = ([c0, c1, c2, c3]: number[]): number => {
    const t2 = t * t;
    return (
      c0 * (-3 * t2 + 6 * t - 3) +
      c1 * (9 * t2 - 12 * t + 3) +
      c2 * (-9 * t2 + 6 * t) +
      c3 * (3 * t2)
    );
  };

  const x = solveDerivative(coords[0]);
  const y = solveDerivative(coords[1]);
  const d = Math.hypot(x, y);

  if (almostZero(d)) return point(0, 0);
  return point(x / d, y / d);
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
  const sp = lerpPoint(p4, p5, t);

  return [
    [start, sp, p1, p4],
    [sp, end, p5, p3],
  ];
}

export function splitLineTo(
  from: Point,
  segment: PathSegment,
  t: number,
): [PathSegment, PathSegment] {
  const to = segmentToPoint(segment) as Point;
  return [makeLineTo(lerpPoint(from, to, t)), segment];
}

export function splitCurveTo(
  from: Point,
  segment: PathSegment,
  t: number,
): [PathSegment, PathSegment] {
  const end = segmentToPoint(segment) as Point;
  const h1 = segmentToPoint(segment, "c1") as Point;
  const h2 = segmentToPoint(segment, "c2") as Point;
  const [[, to1, h11, h21], [, to2, h12, h22]] = curveSplit(
    [from, end, h1, h2],
    t,
  );
  return [makeCurveTo(to1, h11, h21), makeCurveTo(to2, h12, h22)];
}

export function subcurveRange(curve: Bezier, t1: number, t2: number): Bezier {
  const [from, to] = t1 < t2 ? [t1, t2] : [t2, t1];
  const toRelative = (to - from) / (1 - from);
  const [, curveAfter] = curveSplit(curve, from);
  return curveSplit(curveAfter, toRelative)[0];
}

export function splitLineToRanges(
  from: Point,
  segment: PathSegment,
  values: readonly number[],
): PathSegment[] {
  const filtered = values.filter((v) => v > 0 && v < 1);
  if (filtered.length === 0) return [segment];

  const to = segmentToPoint(segment) as Point;
  const sorted = [...new Set([...filtered, 1])].sort((a, b) => a - b);
  return sorted.map((value) => makeLineTo(lerpPoint(from, to, value)));
}

export function splitCurveToRanges(
  from: Point,
  segment: PathSegment,
  values: readonly number[],
): PathSegment[] {
  const filtered = values.filter((v) => v > 0 && v < 1);
  if (filtered.length === 0) return [segment];

  const to = segmentToPoint(segment) as Point;
  const h1 = segmentToPoint(segment, "c1") as Point;
  const h2 = segmentToPoint(segment, "c2") as Point;
  const sorted = [...new Set([...filtered, 0, 1])].sort((a, b) => a - b);

  const result: PathSegment[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const t0 = sorted[i - 1];
    const t1 = sorted[i];
    const [, to1, h1p, h2p] = subcurveRange([from, to, h1, h2], t0, t1);
    result.push(makeCurveTo(to1, h1p, h2p));
  }
  return result;
}

export function getLineTval(line: Line, pt: Point): number {
  const [from, to] = line;
  if (sEqual(from.x, to.x) && sEqual(from.y, to.y)) return Infinity;
  if (sEqual(from.x, to.x)) return (pt.y - from.y) / (to.y - from.y);
  return (pt.x - from.x) / (to.x - from.x);
}

export function curveRangeToRect(
  curve: Bezier,
  fromT: number,
  toT: number,
): Rect {
  const sub = subcurveRange(curve, fromT, toT);
  const points = [sub[0], sub[1]];
  for (const t of curveExtremities(sub)) {
    points.push(curveValues(sub, t));
  }
  return pointsToRect(points);
}

export function lineHasPoint(pt: Point, line: Line): boolean {
  const [from, to] = line;
  const m = !sEqual(from.x, to.x)
    ? (to.y - from.y) / (to.x - from.x)
    : null;
  const vy = m == null ? null : m * pt.x + -m * from.x + from.y;

  return (
    (sEqual(from.x, to.x) && sEqual(pt.x, from.x)) ||
    (vy != null && sEqual(pt.y, vy))
  );
}

export function segmentHasPoint(pt: Point, line: Line): boolean {
  if (!lineHasPoint(pt, line)) return false;
  const t = getLineTval(line, pt);
  return (t > 0 || sEqual(t, 0)) && (t < 1 || sEqual(t, 1));
}

export function curveHasPoint(pt: Point, curve: Bezier): boolean {
  const checkRange = (fromT: number, toT: number): boolean => {
    const r = curveRangeToRect(curve, fromT, toT);
    if (!containsPoint(r, pt)) return false;

    if (sEqual(fromT, toT)) {
      return distance(curveValues(curve, fromT), pt) < 0.1;
    }

    const halfT = fromT + (toT - fromT) / 2;
    return checkRange(fromT, halfT) || checkRange(halfT, toT);
  };

  return checkRange(0, 1);
}

export function curveRoots(curve: Bezier, coord: "x" | "y"): number[] {
  const [start, end, h1, h2] = curve;
  const [pa, pb, pc, pd] = [
    start[coord],
    h1[coord],
    h2[coord],
    end[coord],
  ];

  const a = 3 * pa - 6 * pb + 3 * pc;
  const b = -3 * pa + 3 * pb;
  const c = pa;
  const d = -pa + 3 * pb - 3 * pc + pd;

  return solveRoots(a, b, c, d).filter((t) => t >= 0 && t <= 1);
}

export function lineLineCrossing(
  l1: Line,
  l2: Line,
): [number, number] | null {
  const [fromP1, toP1] = l1;
  const [fromP2, toP2] = l2;

  const nx =
    (fromP2.x - toP2.x) * (fromP1.x * toP1.y - fromP1.y * toP1.x) -
    (fromP1.x - toP1.x) * (fromP2.x * toP2.y - fromP2.y * toP2.x);

  const ny =
    (fromP2.y - toP2.y) * (fromP1.x * toP1.y - fromP1.y * toP1.x) -
    (fromP1.y - toP1.y) * (fromP2.x * toP2.y - fromP2.y * toP2.x);

  const d =
    (fromP1.x - toP1.x) * (fromP2.y - toP2.y) -
    (fromP1.y - toP1.y) * (fromP2.x - toP2.x);

  if (!almostZero(d)) {
    const cross = point(nx / d, ny / d);
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
  if (crossing == null) return null;

  const [l1t, l2t] = crossing;
  const inside =
    (l1t > 0 || sEqual(l1t, 0)) &&
    (l1t < 1 || sEqual(l1t, 1)) &&
    (l2t > 0 || sEqual(l2t, 0)) &&
    (l2t < 1 || sEqual(l2t, 1));

  return inside ? [[l1t], [l2t]] : null;
}

export function lineCurveCrossing(line: Line, curve: Bezier): number[] {
  const [from, to] = line;
  const theta = (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;

  // Same composition as `gmt/rotate` plus `gmt/translate`: the composed
  // matrix keeps the tiny rounding pattern the CLJS numbers rely on when
  // an endpoint of the curve lies on the line.
  const matrix = translate(rotateMatrix(-theta), {
    x: -from.x,
    y: -from.y,
  });

  const apply = (p: Point): Point => applyMatrix(p, matrix);

  return curveRoots(
    [apply(curve[0]), apply(curve[1]), apply(curve[2]), apply(curve[3])],
    "y",
  );
}

export function lineCurveIntersect(
  line: Line,
  curve: Bezier,
): [number[], number[]] {
  const curveTs = lineCurveCrossing(line, curve).filter((curveT) => {
    const t = almostZero(curveT) ? 0 : curveT;
    const curveV = curveValues(curve, t);
    const lineT = getLineTval(line, curveV);
    return t >= 0 && t <= 1 && lineT >= 0 && lineT <= 1;
  });

  const lineTs = curveTs.map((t) => getLineTval(line, curveValues(curve, t)));
  return [lineTs, curveTs];
}

interface CurveIntersection {
  p1: Point;
  p2: Point;
  d: number;
  t1: number;
  t2: number;
}

export function curveCurveIntersect(
  c1: Bezier,
  c2: Bezier,
): [number[], number[]] {
  const checkRange = (
    c1From: number,
    c1To: number,
    c2From: number,
    c2To: number,
  ): CurveIntersection[] => {
    const r1 = curveRangeToRect(c1, c1From, c1To);
    const r2 = curveRangeToRect(c2, c2From, c2To);
    if (!overlapsRects(r1, r2)) return [];

    const p1 = curveValues(c1, c1From);
    const p2 = curveValues(c2, c2From);
    const d = distance(p1, p2);

    if (d < CURVE_CURVE_PRECISION) {
      return [{ p1, p2, d, t1: precision(c1From, 4), t2: precision(c2From, 4) }];
    }

    const c1Half = c1From + (c1To - c1From) / 2;
    const c2Half = c2From + (c2To - c2From) / 2;

    return [
      ...checkRange(c1From, c1Half, c2From, c2Half),
      ...checkRange(c1From, c1Half, c2Half, c2To),
      ...checkRange(c1Half, c1To, c2From, c2Half),
      ...checkRange(c1Half, c1To, c2Half, c2To),
    ];
  };

  const intersections = checkRange(0, 1, 0, 1).sort((a, b) => a.d - b.d);

  const c1Ts: number[] = [];
  const c2Ts: number[] = [];
  let pending = [...intersections];

  while (pending.length > 0) {
    const current = pending[0];
    pending = pending
      .slice(1)
      .filter(
        (item) =>
          distance(item.p1, current.p1) >= CURVE_RANGE_PRECISION &&
          distance(item.p2, current.p2) >= CURVE_RANGE_PRECISION,
      );
    c1Ts.push(current.t1);
    c2Ts.push(current.t2);
  }

  return [c1Ts, c2Ts];
}

export function rayOverlaps(pt: Point, geom: { selrect: Rect }): boolean {
  const { selrect } = geom;
  return (
    (pt.y > selrect.y1 || almostZero(pt.y - selrect.y1)) &&
    (pt.y < selrect.y2 || almostZero(pt.y - selrect.y2))
  );
}

export function rayLineIntersect(
  pt: Point,
  line: Line,
): Array<[Point, number]> {
  const rayLine: Line = [pt, point(pt.x + 1, pt.y)];
  const a = sEqual(line[0].y, pt.y) ? point(line[0].x, line[0].y + 10) : line[0];
  const b = sEqual(line[1].y, pt.y) ? point(line[1].x, line[1].y + 10) : line[1];

  const crossing = lineLineCrossing(rayLine, [a, b]);
  if (crossing == null) return [];

  const [rayT, lineT] = crossing;
  const valid =
    rayT > 0 &&
    (lineT > 0 || sEqual(lineT, 0)) &&
    (lineT < 1 || sEqual(lineT, 1));

  if (!valid) return [];
  return [[lineValues(line, lineT), lineWindup(line, lineT)] as [Point, number]];
}

export function rayCurveIntersect(
  rayLine: Line,
  curve: Bezier,
): Array<[Point, number]> {
  const curveTs = lineCurveCrossing(rayLine, curve).filter((curveT) => {
    const curveV = curveValues(curve, curveT);
    const tangent = curveTangent(curve, curveT);
    const tangentAngle = (Math.atan2(tangent.y, tangent.x) * 180) / Math.PI;
    const rayT = getLineTval(rayLine, curveV);

    return (
      rayT > 0 &&
      Math.abs(tangentAngle - 180) > 0.01 &&
      Math.abs(tangentAngle) > 0.01
    );
  });

  return curveTs.map((t): [Point, number] => [
    curveValues(curve, t),
    curveWindup(curve, t),
  ]);
}

export interface GeomData {
  command: string;
  geom: Line | Bezier;
  selrect: Rect;
}

export function isPointInGeomData(
  pt: Point,
  geomData: readonly GeomData[],
): boolean {
  const rayLine: Line = [pt, point(pt.x + 1, pt.y)];

  let windup = 0;
  for (const data of geomData) {
    if (!rayOverlaps(pt, data)) continue;

    if (data.command === "line-to") {
      for (const [, value] of rayLineIntersect(pt, data.geom as Line)) {
        windup += value;
      }
    } else if (data.command === "curve-to") {
      for (const [, value] of rayCurveIntersect(rayLine, data.geom as Bezier)) {
        windup += value;
      }
    }
  }

  return windup !== 0;
}

export function isPointInBorder(
  pt: Point,
  content: readonly PrevSegment[],
): boolean {
  for (const segment of content) {
    if (segment.command === "line-to") {
      if (segmentHasPoint(pt, commandToLine(segment))) return true;
    } else if (segment.command === "curve-to") {
      if (curveHasPoint(pt, commandToBezier(segment))) return true;
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
    if (pt != null) points.set(pointKey(pt), pt);
  };

  let segments = content.slice();
  let fromP: Point | null = null;
  let moveP: Point | null = null;

  while (segments.length > 0) {
    if (segments[segments.length - 1].command === "move-to") {
      segments = segments.slice(0, -1);
    }
    if (segments.length === 0) break;

    const segment = segments[0];
    const toP = segmentToPoint(segment);

    switch (segment.command) {
      case "move-to":
        add(toP);
        fromP = toP;
        moveP = toP;
        break;

      case "close-path":
        add(moveP);
        fromP = moveP;
        break;

      case "line-to":
        if (fromP != null && toP != null) {
          add(fromP);
          add(toP);
        }
        fromP = toP;
        break;

      case "curve-to": {
        const c1 = segmentToPoint(segment, "c1");
        const c2 = segmentToPoint(segment, "c2");
        if (fromP != null && toP != null && c1 != null && c2 != null) {
          add(fromP);
          add(toP);
          for (const extreme of calculateCurveExtremities(fromP, toP, c1, c2)) {
            add(extreme);
          }
        }
        fromP = toP;
        break;
      }
    }

    segments = segments.slice(1);
  }

  return [...points.values()];
}

export function contentToSelrect(content: readonly PathSegment[]): Rect {
  const extremities = calculateExtremities(content);
  if (extremities.length > 0) return pointsToRect(extremities);

  const points: Point[] = [];
  for (const segment of content) {
    const pt = segmentToPoint(segment);
    if (pt != null) points.push(pt);
  }
  return points.length > 0 ? pointsToRect(points) : makeRect();
}

export function contentCenter(content: readonly PathSegment[]): Point {
  const rect = contentToSelrect(content);
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

