// TypeScript mirror of app.common.types.path.subpath.
//
// A subpath carries the first and last point plus the segments between
// them. closeSubpaths can reorder and reverse pieces; mergeTouchingSubpaths
// is the conservative variant that only joins adjacent pieces in draw order.

import type { Point } from "@/lib/common/geom/point";
import {
  distance,
  makeLineTo,
  makeMoveTo,
  pathSegments,
  segmentToPoint,
  type PathSegment,
} from "./segment";

export interface PathSubpath {
  from: Point;
  to: Point;
  data: PathSegment[];
}

export function ptEqual(p1: Point, p2: Point): boolean {
  return distance(p1, p2) < 0.1;
}

export function makeSubpath(command: PathSegment): PathSubpath {
  const pt = segmentToPoint(command) ?? { x: 0, y: 0 };
  return { from: pt, to: pt, data: [command] };
}

export function addSubpathCommand(
  subpath: PathSubpath,
  command: PathSegment,
): PathSubpath {
  const closes = command.command === "close-path";
  if (closes && ptEqual(subpath.from, subpath.to)) return subpath;

  const next = closes ? makeLineTo(subpath.from) : command;
  const to = segmentToPoint(next) ?? subpath.to;
  return { from: subpath.from, to, data: [...subpath.data, next] };
}

export function reverseCommand(command: PathSegment, prev: PathSegment): PathSegment {
  const next: Record<string, number> = {
    x: prev.params.x,
    y: prev.params.y,
  };
  if (command.command === "curve-to") {
    next.c1x = command.params.c2x;
    next.c1y = command.params.c2y;
    next.c2x = command.params.c1x;
    next.c2y = command.params.c1y;
  }
  return { command: command.command, params: next };
}

export function reverseSubpath(subpath: PathSubpath): PathSubpath {
  const data: PathSegment[] = [makeMoveTo(subpath.to)];
  for (let index = subpath.data.length - 1; index >= 1; index -= 1) {
    data.push(reverseCommand(subpath.data[index], subpath.data[index - 1]));
  }
  return { from: subpath.to, to: subpath.from, data };
}

export function getSubpaths(content: readonly PathSegment[]): PathSubpath[] {
  const subpaths: PathSubpath[] = [];
  for (const segment of content) {
    if (segment.command === "move-to") {
      subpaths.push(makeSubpath(segment));
    } else if (subpaths.length > 0) {
      const last = subpaths.length - 1;
      subpaths[last] = addSubpathCommand(subpaths[last], segment);
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
  const joins = (left: Point, right: Point): boolean =>
    ptEqual(left, right) && meet(left);
  let current = candidate;
  const rest: PathSubpath[] = [];

  for (const other of subpaths) {
    if (ptEqual(other.to, other.from)) {
      rest.push(other);
    } else if (joins(current.to, other.from)) {
      current = subpathsJoin(current, other);
    } else if (joins(current.from, other.to)) {
      current = subpathsJoin(other, current);
    } else if (joins(current.to, other.to)) {
      current = subpathsJoin(current, reverseSubpath(other));
    } else if (joins(current.from, other.from)) {
      current = subpathsJoin(reverseSubpath(other), current);
    } else {
      rest.push(other);
    }
  }
  return [current, rest, current !== candidate];
}

export function isClosed(subpath: PathSubpath): boolean {
  return ptEqual(subpath.from, subpath.to);
}

export function closeSubpaths(
  content: readonly PathSegment[],
  meet: (point: Point) => boolean = () => true,
): PathSegment[] {
  const queue = getSubpaths(content);
  const result: PathSubpath[] = [];
  let current = queue.shift();

  while (current !== undefined) {
    if (isClosed(current)) {
      result.push(current);
      current = queue.shift();
      continue;
    }
    const [merged, rest, changed] = mergePaths(current, queue, meet);
    if (!changed) {
      result.push(merged);
      current = rest[0];
      queue.splice(0, queue.length, ...rest.slice(1));
    } else {
      current = merged;
      queue.splice(0, queue.length, ...rest);
    }
  }
  return result.flatMap((subpath) => subpath.data);
}

// merge-touching-subpaths: join only neighbouring pieces and never reverse
// them, so stroke order and dash phases survive an imported SVG.
export function mergeTouchingSubpaths(content: readonly PathSegment[]): PathSegment[] {
  const merged: PathSubpath[] = [];
  for (const subpath of getSubpaths(content)) {
    const previous = merged[merged.length - 1];
    if (
      previous !== undefined &&
      !isClosed(previous) &&
      !isClosed(subpath) &&
      ptEqual(previous.to, subpath.from)
    ) {
      merged[merged.length - 1] = subpathsJoin(previous, subpath);
    } else {
      merged.push(subpath);
    }
  }
  return merged.flatMap((subpath) => subpath.data);
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
  const data = last.command === "line-to" ? subpath.data.slice(0, -1) : subpath.data;
  return {
    from: subpath.from,
    to: subpath.from,
    data: [...data, { command: "close-path", params: {} }],
  };
}

export function closeLoops(content: readonly PathSegment[]): PathSegment[] {
  return getSubpaths(content)
    .map(closeLoop)
    .flatMap((subpath) => subpath.data);
}

export function reverseContent(content: readonly PathSegment[]): PathSegment[] {
  return getSubpaths(content)
    .map(reverseSubpath)
    .reverse()
    .flatMap((subpath) => subpath.data);
}

// clockwise?: the signed area of the first subpath.
export function clockwise(content: readonly PathSegment[]): boolean {
  const subpath = getSubpaths(content)[0];
  const data = subpath?.data ?? [];
  let first: Point | null = null;
  let area = 0;
  for (let index = 0; index < data.length; index += 1) {
    const current = segmentToPoint(data[index]);
    if (current === null) continue;
    if (first === null) first = current;
    const next =
      index === data.length - 1
        ? first
        : segmentToPoint(data[index + 1]) ?? { x: 0, y: 0 };
    area += current.x * next.y - next.x * current.y;
  }
  return area > 0;
}

// shape-with-open-path?: imported SVGs keep their subpaths untouched; every
// other path closes touching subpaths before the test.
export function shapeWithOpenPath(shape: Record<string, unknown>): boolean {
  if (shape.type !== "path") return false;
  const content = pathSegments(shape.content);
  const subpaths = Object.prototype.hasOwnProperty.call(shape, "svg-attrs")
    ? getSubpaths(content)
    : getSubpaths(closeSubpaths(content));
  return !subpaths.every(isClosed);
}
