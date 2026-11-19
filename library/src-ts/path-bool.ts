// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `app.common.types.path.bool`: the union, difference,
// intersection and exclusion operations over path content.

import type { Fill, PathSegment, Point, Rect } from "./model.ts";
import type { GeomData, PrevSegment } from "./path-helpers.ts";
import { containsPoint, overlapsRects } from "./geometry.ts";
import {
  commandToBezier,
  commandToLine,
  commandToSelrect,
  contentToSelrect,
  curveCurveIntersect,
  curveValues,
  distance,
  isPointInBorder,
  isPointInGeomData,
  lineCurveIntersect,
  lineLineIntersect,
  lineValues,
  makeLineTo,
  makeMoveTo,
  segmentToPoint,
  splitCurveToRanges,
  splitLineToRanges,
} from "./path-helpers.ts";
import {
  clockwise,
  closeSubpaths,
  getSubpaths,
  reverseContent,
} from "./path-subpath.ts";

export type BoolType = "union" | "difference" | "intersection" | "exclude";

export function getDefaultFills(): Fill[] {
  return [{ fillColor: "#000000" }];
}

export function addPrevious(
  content: readonly PathSegment[],
  first?: Point,
): PrevSegment[] {
  return content.map((command, index) => {
    const prev = index === 0 ? undefined : content[index - 1];
    const result: PrevSegment = { ...command };

    if (prev == null && first != null) result.prev = first;
    if (prev != null) result.prev = segmentToPoint(prev) as Point;

    return result;
  });
}

export function closePaths(content: readonly PathSegment[]): PathSegment[] {
  const result: PathSegment[] = [];
  let lastMove: Point | null = null;
  let lastPoint: Point | null = null;

  for (const current of content) {
    const point = segmentToPoint(current);

    let segment: PathSegment | null;
    if (
      current.command === "close-path" &&
      (lastPoint == null ||
        (lastMove != null && distance(lastPoint, lastMove) < 0.01))
    ) {
      // Ignore consecutive close-paths and already closed seams.
      segment = null;
    } else if (current.command === "close-path") {
      segment = makeLineTo(lastMove as Point);
    } else {
      segment = current;
    }

    if (segment != null) result.push(segment);
    lastMove =
      segment != null && segment.command === "move-to" ? point : lastMove;
    lastPoint = point;
  }

  return result;
}

function splitCommand(
  command: PrevSegment,
  values: readonly number[],
): PathSegment[] {
  switch (command.command) {
    case "line-to":
      return splitLineToRanges(
        command.prev as Point,
        command,
        values,
      );
    case "curve-to":
      return splitCurveToRanges(
        command.prev as Point,
        command,
        values,
      );
    default:
      return [command];
  }
}

function splitTs(
  seg1: PrevSegment,
  seg2: PrevSegment,
): [number[], number[]] {
  if (seg1.command === "line-to" && seg2.command === "line-to") {
    return lineLineIntersect(commandToLine(seg1), commandToLine(seg2)) ?? [
      [],
      [],
    ];
  }

  if (seg1.command === "line-to" && seg2.command === "curve-to") {
    return lineCurveIntersect(commandToLine(seg1), commandToBezier(seg2));
  }

  if (seg1.command === "curve-to" && seg2.command === "line-to") {
    const [seg2Ts, seg1Ts] = lineCurveIntersect(
      commandToLine(seg2),
      commandToBezier(seg1),
    );
    return [seg1Ts, seg2Ts];
  }

  if (seg1.command === "curve-to" && seg2.command === "curve-to") {
    return curveCurveIntersect(
      commandToBezier(seg1),
      commandToBezier(seg2),
    );
  }

  return [[], []];
}

export function contentIntersectSplit(
  contentA: readonly PrevSegment[],
  contentB: readonly PrevSegment[],
  srA: Rect,
  srB: Rect,
): [PrevSegment[], PrevSegment[]] {
  const selrectCache = new Map<PathSegment, Rect>();

  const commandSelrect = (segment: PrevSegment): Rect => {
    const cached = selrectCache.get(segment);
    if (cached != null) return cached;
    const selrect = commandToSelrect(segment);
    selrectCache.set(segment, selrect);
    return selrect;
  };

  const overlapSegmentSelrect = (
    segment: PrevSegment,
    selrect: Rect,
  ): boolean =>
    segment.command !== "move-to" &&
    overlapsRects(commandSelrect(segment), selrect);

  const overlapSegments = (seg1: PrevSegment, seg2: PrevSegment): boolean =>
    seg1.command !== "move-to" &&
    seg2.command !== "move-to" &&
    overlapsRects(commandSelrect(seg1), commandSelrect(seg2));

  const split = (
    seg1: PrevSegment,
    seg2: PrevSegment,
  ): PrevSegment[] => {
    if (!overlapSegments(seg1, seg2)) return [seg1];
    const [tsSeg1] = splitTs(seg1, seg2);
    return addPrevious(splitCommand(seg1, tsSeg1), seg1.prev);
  };

  const splitSegmentOnContent = (
    segment: PrevSegment,
    content: readonly PrevSegment[],
    contentSr: Rect,
  ): PrevSegment[] => {
    if (!overlapSegmentSelrect(segment, contentSr)) return [segment];

    let result: PrevSegment[] = [segment];
    for (const current of content) {
      if (!overlapSegments(segment, current)) continue;
      result = result.flatMap((item) => split(item, current));
    }
    return result;
  };

  const splitContent = (
    content: readonly PrevSegment[],
    other: readonly PrevSegment[],
    srOther: Rect,
  ): PrevSegment[] =>
    content.flatMap((segment) =>
      splitSegmentOnContent(segment, other, srOther),
    );

  return [splitContent(contentA, contentB, srB), splitContent(contentB, contentA, srA)];
}

export function isSegment(command: PrevSegment): boolean {
  return (
    command.prev !== undefined &&
    (command.command === "line-to" || command.command === "curve-to")
  );
}

function segmentMidpoint(segment: PrevSegment): Point {
  if (segment.command === "line-to") {
    return lineValues(commandToLine(segment), 0.5);
  }
  return curveValues(commandToBezier(segment), 0.5);
}

export function containsSegment(
  segment: PrevSegment,
  content: readonly PrevSegment[],
  contentSr: Rect,
  contentGeom: readonly GeomData[],
): boolean {
  const point = segmentMidpoint(segment);
  return (
    containsPoint(contentSr, point) &&
    (isPointInGeomData(point, contentGeom) ||
      isPointInBorder(point, content))
  );
}

export function insideSegment(
  segment: PrevSegment,
  contentSr: Rect,
  contentGeom: readonly GeomData[],
): boolean {
  const point = segmentMidpoint(segment);
  return containsPoint(contentSr, point) && isPointInGeomData(point, contentGeom);
}

export function overlapSegment(
  segment: PrevSegment,
  content: readonly PrevSegment[],
): boolean {
  for (const other of content) {
    if (
      segment.command !== other.command ||
      (segment.command !== "line-to" && segment.command !== "curve-to")
    ) {
      continue;
    }

    if (segment.command === "line-to") {
      const [p1, q1] = commandToLine(segment);
      const [p2, q2] = commandToLine(other);
      const forward =
        distance(p1, p2) < 0.1 && distance(q1, q2) < 0.1;
      const reversed =
        distance(p1, q2) < 0.1 && distance(q1, p2) < 0.1;
      if (forward || reversed) return true;
    } else {
      const [p1, q1, h11, h21] = commandToBezier(segment);
      const [p2, q2, h12, h22] = commandToBezier(other);
      const forward =
        distance(p1, p2) < 0.1 &&
        distance(q1, q2) < 0.1 &&
        distance(h11, h12) < 0.1 &&
        distance(h21, h22) < 0.1;
      const reversed =
        distance(p1, q2) < 0.1 &&
        distance(q1, p2) < 0.1 &&
        distance(h11, h22) < 0.1 &&
        distance(h21, h12) < 0.1;
      if (forward || reversed) return true;
    }
  }

  return false;
}

function pointsExactEqual(a?: Point, b?: Point): boolean {
  if (a == null && b == null) return true;
  if (a == null || b == null) return false;
  return a.x === b.x && a.y === b.y;
}

export function fixMoveTo(content: readonly PrevSegment[]): PathSegment[] {
  const result: PathSegment[] = [];
  let prev: Point | undefined;

  for (const current of content) {
    if (!pointsExactEqual(current.prev, prev)) {
      const pt = current.prev as Point;
      result.push(makeMoveTo(pt));
    }

    const { prev: _prev, ...rest } = current;
    result.push(rest);
    prev = segmentToPoint(current) as Point;
  }

  return result;
}

// Removes segments whose endpoints were already seen, in either
// direction. The reference implementation keeps the same tuples in a
// sorted set whose comparator tolerates a 0.001 distance. That order is
// not transitive, so `contains?` sometimes misses a stored tuple and a
// duplicate survives (zero length segments of a degenerate curve). We
// scan the list instead: the result is a strict total order, and the
// dropped duplicates do not change the geometry.
export function removeDuplicatedSegments(
  content: readonly PrevSegment[],
): PrevSegment[] {
  const seen: Array<[number, number, number, number]> = [];
  const result: PrevSegment[] = [];

  const found = (tuple: [number, number, number, number]): boolean =>
    seen.some(
      ([fx, fy, tx, ty]) =>
        closeNumber(tx, tuple[2]) &&
        closeNumber(ty, tuple[3]) &&
        closeNumber(fx, tuple[0]) &&
        closeNumber(fy, tuple[1]),
    );

  for (const current of content) {
    const fx = current.prev?.x ?? Number.NaN;
    const fy = current.prev?.y ?? Number.NaN;
    const tx = current.params.x ?? Number.NaN;
    const ty = current.params.y ?? Number.NaN;

    const tuple: [number, number, number, number] = [fx, fy, tx, ty];
    const reverse: [number, number, number, number] = [tx, ty, fx, fy];

    if (!found(tuple) && !found(reverse)) result.push(current);
    seen.push(tuple);
  }

  return result;
}

function closeNumber(a: number, b: number): boolean {
  return Math.abs(a - b) <= 0.001;
}

export function closeContent(content: readonly PrevSegment[]): PrevSegment[] {
  return getSubpaths(closeSubpaths(content)).flatMap(
    (subpath) => subpath.data,
  );
}

export function contentToGeomData(
  content: readonly PrevSegment[],
): GeomData[] {
  return closeContent(content)
    .filter(
      (segment) =>
        (segment.command === "line-to") !== (segment.command === "curve-to"),
    )
    .map((segment) => ({
      command: segment.command,
      geom:
        segment.command === "line-to"
          ? commandToLine(segment)
          : commandToBezier(segment),
      selrect: commandToSelrect(segment),
    }));
}

export function createUnion(
  contentA: readonly PrevSegment[],
  contentASplit: readonly PrevSegment[],
  contentB: readonly PrevSegment[],
  contentBSplit: readonly PrevSegment[],
  srA: Rect,
  srB: Rect,
): PrevSegment[] {
  const contentAGeom = contentToGeomData(contentA);
  const contentBGeom = contentToGeomData(contentB);

  const content = [
    ...contentASplit.filter(
      (segment) => !containsSegment(segment, contentB, srB, contentBGeom),
    ),
    ...contentBSplit.filter(
      (segment) => !containsSegment(segment, contentA, srA, contentAGeom),
    ),
  ];

  const contentGeom = contentToGeomData(content);
  const contentSr = contentToSelrect(fixMoveTo(content));

  // Overlapping segments belong to the border.
  const borderContent = contentBSplit.filter(
    (segment) =>
      containsSegment(segment, contentA, srA, contentAGeom) &&
      overlapSegment(segment, contentASplit) &&
      !insideSegment(segment, contentSr, contentGeom),
  );

  return [...content, ...borderContent];
}

export function createDifference(
  contentA: readonly PrevSegment[],
  contentASplit: readonly PrevSegment[],
  contentB: readonly PrevSegment[],
  contentBSplit: readonly PrevSegment[],
  srA: Rect,
  srB: Rect,
): PrevSegment[] {
  const contentAGeom = contentToGeomData(contentA);
  const contentBGeom = contentToGeomData(contentB);

  return [
    ...contentASplit.filter(
      (segment) => !containsSegment(segment, contentB, srB, contentBGeom),
    ),
    // Reversing the second content creates the holes.
    ...contentBSplit.filter(
      (segment) =>
        containsSegment(segment, contentA, srA, contentAGeom) &&
        !overlapSegment(segment, contentASplit),
    ),
  ];
}

export function createIntersection(
  contentA: readonly PrevSegment[],
  contentASplit: readonly PrevSegment[],
  contentB: readonly PrevSegment[],
  contentBSplit: readonly PrevSegment[],
  srA: Rect,
  srB: Rect,
): PrevSegment[] {
  const contentAGeom = contentToGeomData(contentA);
  const contentBGeom = contentToGeomData(contentB);

  return [
    ...contentASplit.filter((segment) =>
      containsSegment(segment, contentB, srB, contentBGeom),
    ),
    ...contentBSplit.filter((segment) =>
      containsSegment(segment, contentA, srA, contentAGeom),
    ),
  ];
}

export function createExclusion(
  contentASplit: readonly PrevSegment[],
  contentBSplit: readonly PrevSegment[],
): PrevSegment[] {
  return [...contentASplit, ...contentBSplit];
}

export function contentBoolPair(
  boolType: BoolType,
  contentA: readonly PathSegment[],
  contentB: readonly PathSegment[],
): PathSegment[] {
  // Reverse the second path for the non union operations when both
  // shapes run in the same direction.
  const shouldReverse =
    boolType !== "union" &&
    clockwise(contentB) === clockwise(contentA);

  const a = addPrevious(closePaths(contentA));
  const b = addPrevious(
    shouldReverse
      ? reverseContent(closePaths(contentB))
      : closePaths(contentB),
  );

  const srA = contentToSelrect(a);
  const srB = contentToSelrect(b);

  const [aSplitRaw, bSplitRaw] = contentIntersectSplit(a, b, srA, srB);
  const aSplit = addPrevious(aSplitRaw).filter(isSegment);
  const bSplit = addPrevious(bSplitRaw).filter(isSegment);

  let content: PrevSegment[];
  switch (boolType) {
    case "union":
      content = createUnion(a, aSplit, b, bSplit, srA, srB);
      break;
    case "difference":
      content = createDifference(a, aSplit, b, bSplit, srA, srB);
      break;
    case "intersection":
      content = createIntersection(a, aSplit, b, bSplit, srA, srB);
      break;
    case "exclude":
      content = createExclusion(aSplit, bSplit);
      break;
  }

  return closeSubpaths(fixMoveTo(removeDuplicatedSegments(content)));
}

export function calculateContent(
  boolType: BoolType,
  contents: ReadonlyArray<readonly PathSegment[]>,
): PathSegment[] {
  if (contents.length === 0) return [];

  let result: PathSegment[] = [...contents[0]];
  for (let i = 1; i < contents.length; i++) {
    result = contentBoolPair(boolType, result, contents[i]);
  }
  return result;
}
