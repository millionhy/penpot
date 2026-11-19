// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Port of `app.common.types.path.subpath`: subpath extraction, joining,
// reversing and the clockwise test used by the boolean operations.

import type { Point } from "./model.ts";
import type { PrevSegment } from "./path-helpers.ts";
import {
  distance,
  makeLineTo,
  makeMoveTo,
  segmentToPoint,
} from "./path-helpers.ts";

export interface PathSubpath {
  from: Point;
  to: Point;
  data: PrevSegment[];
}

export function ptEqual(p1: Point, p2: Point): boolean {
  return distance(p1, p2) < 0.1;
}

export function makeSubpath(command: PrevSegment): PathSubpath {
  const pt = segmentToPoint(command) as Point;
  return { from: pt, to: pt, data: [command] };
}

export function addSubpathCommand(
  subpath: PathSubpath,
  command: PrevSegment,
): PathSubpath {
  const close = command.command === "close-path";

  if (close && ptEqual(subpath.from, subpath.to)) {
    // Avoid adding a duplicate node at an already closed seam.
    return subpath;
  }

  const next = close ? makeLineTo(subpath.from) : command;
  const to = segmentToPoint(next) as Point;

  return { from: subpath.from, to, data: [...subpath.data, next] };
}

export function reverseCommand(
  command: PrevSegment,
  prev: PrevSegment,
): PrevSegment {
  const params = command.params as Record<string, number | undefined>;
  const prevParams = prev.params;
  const next: Record<string, number> = {
    x: prevParams.x,
    y: prevParams.y,
  };

  if (command.command === "curve-to") {
    next.c1x = params.c2x as number;
    next.c1y = params.c2y as number;
    next.c2x = params.c1x as number;
    next.c2y = params.c1y as number;
  }

  return { command: command.command, params: next };
}

export function reverseSubpath(subpath: PathSubpath): PathSubpath {
  const { data } = subpath;
  const newData: PrevSegment[] = [makeMoveTo(subpath.to)];

  for (let i = data.length - 1; i >= 1; i--) {
    newData.push(reverseCommand(data[i], data[i - 1]));
  }

  return { from: subpath.to, to: subpath.from, data: newData };
}

export function getSubpaths(content: readonly PrevSegment[]): PathSubpath[] {
  const subpaths: PathSubpath[] = [];

  for (const current of content) {
    if (current.command === "move-to") {
      subpaths.push(makeSubpath(current));
    } else if (subpaths.length > 0) {
      const last = subpaths.length - 1;
      subpaths[last] = addSubpathCommand(subpaths[last], current);
    }
  }

  return subpaths;
}

export function subpathsJoin(
  subpath: PathSubpath,
  other: PathSubpath,
): PathSubpath {
  return {
    from: subpath.from,
    to: other.to,
    data: [...subpath.data, ...other.data.slice(1)],
  };
}

function mergePaths(
  candidate: PathSubpath,
  subpaths: readonly PathSubpath[],
  meet: (point: Point) => boolean,
): [PathSubpath, PathSubpath[], boolean] {
  const joins = (point: Point, other: Point): boolean =>
    ptEqual(point, other) && meet(point);

  let current = candidate;
  const result: PathSubpath[] = [];

  for (const other of subpaths) {
    if (ptEqual(other.to, other.from)) {
      result.push(other);
    } else if (joins(current.to, other.from)) {
      current = subpathsJoin(current, other);
    } else if (joins(current.from, other.to)) {
      current = subpathsJoin(other, current);
    } else if (joins(current.to, other.to)) {
      current = subpathsJoin(current, reverseSubpath(other));
    } else if (joins(current.from, other.from)) {
      current = subpathsJoin(reverseSubpath(other), current);
    } else {
      result.push(other);
    }
  }

  return [current, result, current !== candidate];
}

export function isClosed(subpath: PathSubpath): boolean {
  return ptEqual(subpath.from, subpath.to);
}

export function closeSubpaths(
  content: readonly PrevSegment[],
  meet: (point: Point) => boolean = () => true,
): PrevSegment[] {
  const subpaths = getSubpaths(content);

  const result: PathSubpath[] = [];
  let remaining = subpaths.slice();
  let current = remaining.shift();

  while (current != null) {
    let newCurrent: PathSubpath;
    let newSubpaths: PathSubpath[];
    let changed = false;

    if (isClosed(current)) {
      newCurrent = current;
      newSubpaths = remaining;
    } else {
      [newCurrent, newSubpaths, changed] = mergePaths(current, remaining, meet);
    }

    if (!changed) {
      result.push(newCurrent);
      current = newSubpaths[0];
      remaining = newSubpaths.slice(1);
    } else {
      current = newCurrent;
      remaining = newSubpaths;
    }
  }

  return result.flatMap((subpath) => subpath.data);
}

function closeLoop(subpath: PathSubpath): PathSubpath {
  const last = subpath.data[subpath.data.length - 1];

  if (
    subpath.data.length < 2 ||
    last.command === "close-path" ||
    !ptEqual(subpath.from, subpath.to)
  ) {
    return subpath;
  }

  const data =
    last.command === "line-to" ? subpath.data.slice(0, -1) : subpath.data;

  return {
    from: subpath.from,
    to: subpath.from,
    data: [...data, { command: "close-path", params: {} }],
  };
}

export function closeLoops(content: readonly PrevSegment[]): PrevSegment[] {
  return getSubpaths(content)
    .map(closeLoop)
    .flatMap((subpath) => subpath.data);
}

export function reverseContent(content: readonly PrevSegment[]): PrevSegment[] {
  return getSubpaths(content)
    .map(reverseSubpath)
    .reverse()
    .flatMap((subpath) => subpath.data);
}

// https://mathworld.wolfram.com/PolygonArea.html
export function clockwise(content: readonly PrevSegment[]): boolean {
  const subpaths = getSubpaths(content);
  const data = subpaths.length > 0 ? subpaths[0].data : [];

  let firstPoint: Point | null = null;
  let signedArea = 0;

  for (let i = 0; i < data.length; i++) {
    const current = segmentToPoint(data[i]);
    if (current == null) continue;

    const x1 = current.x;
    const y1 = current.y;
    const last = i === data.length - 1;
    if (firstPoint == null) firstPoint = current;

    const next = last ? firstPoint : segmentToPoint(data[i + 1]);
    const x2 = next?.x ?? 0;
    const y2 = next?.y ?? 0;

    signedArea += x1 * y2 - x2 * y1;
  }

  return signedArea > 0;
}
