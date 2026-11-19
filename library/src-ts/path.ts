// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Path content handling. The CLJS builder keeps a `PathData` instance that
// serializes as an SVG path string for `getInternalState` and as a vector of
// segments for the export. Both views are derived from this module.

import type { Matrix, PathSegment, Point, Rect, Shape } from "./model.ts";
import {
  IDENTITY,
  applyMatrix,
  multiply,
  pointsToCenter,
  pointsToRect,
  rectToCenter,
  rectToPoints,
  scaleMatrix,
  transformIn,
  transformPoints,
} from "./geometry.ts";
import { contentCenter, contentToSelrect } from "./path-helpers.ts";

const MAX_SAFE_INT = Number.MAX_SAFE_INTEGER;
const MIN_SAFE_INT = Number.MIN_SAFE_INTEGER;

function normalizeCoord(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value > MAX_SAFE_INT) return MAX_SAFE_INT;
  if (value < MIN_SAFE_INT) return MIN_SAFE_INT;
  // Path data is stored as float32, quantize the same way.
  return Math.fround(value);
}

function coord(params: Record<string, number>, key: string): number {
  return normalizeCoord(params[key] ?? 0);
}

export function normalizeSegment(segment: PathSegment): PathSegment {
  const params = segment.params ?? {};

  switch (segment.command) {
    case "move-to":
    case "line-to":
      return {
        command: segment.command,
        params: { x: coord(params, "x"), y: coord(params, "y") },
      };

    case "curve-to": {
      const x = coord(params, "x");
      const y = coord(params, "y");
      return {
        command: "curve-to",
        params: {
          x,
          y,
          c1x: normalizeCoord(params.c1x ?? x),
          c1y: normalizeCoord(params.c1y ?? y),
          c2x: normalizeCoord(params.c2x ?? x),
          c2y: normalizeCoord(params.c2y ?? y),
        },
      };
    }

    case "close-path":
      return { command: "close-path", params: {} };
  }
}

export function normalizeContent(input: unknown): PathSegment[] {
  if (input == null) return [];
  if (typeof input === "string") return parsePathString(input);
  if (Array.isArray(input)) {
    return input.map((segment: PathSegment) => normalizeSegment(segment));
  }
  throw new Error("unexpected path content");
}

export function serializePath(segments: readonly PathSegment[]): string {
  let result = "";
  for (const segment of segments) {
    const { params } = segment;
    switch (segment.command) {
      case "move-to":
        result += `M${params.x},${params.y}`;
        break;
      case "line-to":
        result += `L${params.x},${params.y}`;
        break;
      case "curve-to":
        result +=
          `C${params.c1x},${params.c1y},` +
          `${params.c2x},${params.c2y},` +
          `${params.x},${params.y}`;
        break;
      case "close-path":
        result += "Z";
        break;
    }
  }
  return result;
}

function transformSegment(
  segment: PathSegment,
  matrix: Matrix,
): PathSegment {
  const params = segment.params;

  if (segment.command === "curve-to") {
    const c1 = applyMatrix({ x: params.c1x, y: params.c1y }, matrix);
    const c2 = applyMatrix({ x: params.c2x, y: params.c2y }, matrix);
    const to = applyMatrix({ x: params.x, y: params.y }, matrix);
    return {
      command: "curve-to",
      params: { x: to.x, y: to.y, c1x: c1.x, c1y: c1.y, c2x: c2.x, c2y: c2.y },
    };
  }

  if (segment.command === "move-to" || segment.command === "line-to") {
    const to = applyMatrix({ x: params.x, y: params.y }, matrix);
    return { command: segment.command, params: { x: to.x, y: to.y } };
  }

  return segment;
}

/**
 * `segment/transform-content`: applies the matrix and re-quantizes the
 * result to the float32 path data storage.
 */
export function transformContent(
  content: readonly PathSegment[],
  matrix: Matrix | null | undefined,
): PathSegment[] {
  if (matrix == null) return [...content];
  return normalizeContent(
    content.map((segment) => transformSegment(segment, matrix)),
  );
}

/**
 * `path/calc-selrect`: the bounding box with the exact curve extrema.
 */
export function calcSelrect(segments: readonly PathSegment[]): Rect {
  return contentToSelrect(segments);
}

/**
 * `path/update-geometry`: recompute `points` and `selrect` from the path
 * content. The content lives in the untransformed coordinate space, so
 * the shape transform is undone around the old centre and applied back
 * around the new one.
 */
export function updateGeometry(
  shape: Shape,
  newContent?: readonly PathSegment[],
): Shape {
  const content = normalizeContent(
    newContent == null ? shape.content : newContent,
  );

  const flipX = shape.flipX === true;
  const flipY = shape.flipY === true;

  let transform = shape.transform ?? IDENTITY;
  if (flipX) transform = multiply(transform, scaleMatrix(-1, 1));
  if (flipY) transform = multiply(transform, scaleMatrix(1, -1));

  let transformInverse = IDENTITY;
  if (flipX) transformInverse = multiply(transformInverse, scaleMatrix(-1, 1));
  if (flipY) transformInverse = multiply(transformInverse, scaleMatrix(1, -1));
  transformInverse = multiply(
    transformInverse,
    shape.transformInverse ?? IDENTITY,
  );

  const center =
    shape.selrect != null ? rectToCenter(shape.selrect) : contentCenter(content);

  const baseContent = transformContent(
    content,
    transformIn(center, transformInverse),
  );

  const points = transformPoints(
    rectToPoints(contentToSelrect(baseContent)),
    center,
    transform,
  );

  const pointsCenter = pointsToCenter(points);

  const selrect = pointsToRect(
    transformPoints(points, pointsCenter, transformInverse),
  );

  return { ...shape, content, points, selrect };
}

const NUMBER_RE = /[+-]?(?:\d*\.\d+|\d+\.?)(?:[eE][+-]?\d+)?/y;
const COMMAND_RE = /[MmLlHhVvCcSsQqTtZzAa]/y;

interface Scanner {
  source: string;
  index: number;
}

function skipSeparators(scanner: Scanner): void {
  const { source } = scanner;
  while (scanner.index < source.length) {
    const char = source[scanner.index];
    if (char === " " || char === "," || char === "\t" || char === "\n" || char === "\r") {
      scanner.index++;
    } else {
      break;
    }
  }
}

function readNumber(scanner: Scanner): number | null {
  skipSeparators(scanner);
  NUMBER_RE.lastIndex = scanner.index;
  const match = NUMBER_RE.exec(scanner.source);
  if (match == null) return null;
  scanner.index = NUMBER_RE.lastIndex;
  return parseFloat(match[0]);
}

function readNumbers(scanner: Scanner, count: number): number[] | null {
  const values: number[] = [];
  for (let i = 0; i < count; i++) {
    const value = readNumber(scanner);
    if (value == null) return null;
    values.push(value);
  }
  return values;
}

/**
 * Parse the absolute and relative SVG commands that the path model
 * supports. Quadratic segments are elevated to cubic ones. Arcs are not
 * part of the model and raise.
 */
export function parsePathString(source: string): PathSegment[] {
  const scanner: Scanner = { source, index: 0 };
  const segments: PathSegment[] = [];

  let command = "";
  let current: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };
  let lastControl: Point | null = null;

  const push = (segment: PathSegment) => segments.push(normalizeSegment(segment));

  for (;;) {
    skipSeparators(scanner);
    if (scanner.index >= source.length) break;

    COMMAND_RE.lastIndex = scanner.index;
    const letter = COMMAND_RE.exec(source);
    if (letter != null) {
      command = letter[0];
      scanner.index = COMMAND_RE.lastIndex;
      if (command === "Z" || command === "z") {
        push({ command: "close-path", params: {} });
        current = { ...start };
        lastControl = null;
        continue;
      }
    } else if (command === "") {
      throw new Error("invalid path content");
    }

    const relative = command === command.toLowerCase();
    const origin = relative ? current : { x: 0, y: 0 };

    switch (command.toUpperCase()) {
      case "M": {
        const values = readNumbers(scanner, 2);
        if (values == null) throw new Error("invalid path content");
        current = { x: origin.x + values[0], y: origin.y + values[1] };
        start = { ...current };
        push({ command: "move-to", params: { x: current.x, y: current.y } });
        // Following pairs are implicit line-to commands.
        command = relative ? "l" : "L";
        lastControl = null;
        break;
      }

      case "L": {
        const values = readNumbers(scanner, 2);
        if (values == null) throw new Error("invalid path content");
        current = { x: origin.x + values[0], y: origin.y + values[1] };
        push({ command: "line-to", params: { x: current.x, y: current.y } });
        lastControl = null;
        break;
      }

      case "H": {
        const values = readNumbers(scanner, 1);
        if (values == null) throw new Error("invalid path content");
        current = { x: origin.x + values[0], y: current.y };
        push({ command: "line-to", params: { x: current.x, y: current.y } });
        lastControl = null;
        break;
      }

      case "V": {
        const values = readNumbers(scanner, 1);
        if (values == null) throw new Error("invalid path content");
        current = { x: current.x, y: origin.y + values[0] };
        push({ command: "line-to", params: { x: current.x, y: current.y } });
        lastControl = null;
        break;
      }

      case "C": {
        const values = readNumbers(scanner, 6);
        if (values == null) throw new Error("invalid path content");
        const c1 = { x: origin.x + values[0], y: origin.y + values[1] };
        const c2 = { x: origin.x + values[2], y: origin.y + values[3] };
        current = { x: origin.x + values[4], y: origin.y + values[5] };
        push({
          command: "curve-to",
          params: {
            x: current.x,
            y: current.y,
            c1x: c1.x,
            c1y: c1.y,
            c2x: c2.x,
            c2y: c2.y,
          },
        });
        lastControl = c2;
        break;
      }

      case "S": {
        const values = readNumbers(scanner, 4);
        if (values == null) throw new Error("invalid path content");
        const c1 = reflectControl(current, lastControl);
        const c2 = { x: origin.x + values[0], y: origin.y + values[1] };
        current = { x: origin.x + values[2], y: origin.y + values[3] };
        push({
          command: "curve-to",
          params: {
            x: current.x,
            y: current.y,
            c1x: c1.x,
            c1y: c1.y,
            c2x: c2.x,
            c2y: c2.y,
          },
        });
        lastControl = c2;
        break;
      }

      case "Q":
      case "T": {
        const values = readNumbers(scanner, command.toUpperCase() === "Q" ? 4 : 2);
        if (values == null) throw new Error("invalid path content");

        const control: Point =
          command.toUpperCase() === "Q"
            ? { x: origin.x + values[0], y: origin.y + values[1] }
            : reflectControl(current, lastControl);
        const end: Point =
          command.toUpperCase() === "Q"
            ? { x: origin.x + values[2], y: origin.y + values[3] }
            : { x: origin.x + values[0], y: origin.y + values[1] };

        // Elevate the quadratic segment to a cubic one.
        const c1 = {
          x: current.x + (2 / 3) * (control.x - current.x),
          y: current.y + (2 / 3) * (control.y - current.y),
        };
        const c2 = {
          x: end.x + (2 / 3) * (control.x - end.x),
          y: end.y + (2 / 3) * (control.y - end.y),
        };

        push({
          command: "curve-to",
          params: {
            x: end.x,
            y: end.y,
            c1x: c1.x,
            c1y: c1.y,
            c2x: c2.x,
            c2y: c2.y,
          },
        });

        current = end;
        lastControl = control;
        break;
      }

      default:
        throw new Error(`unsupported path command: ${command}`);
    }
  }

  return segments;
}

function reflectControl(current: Point, control: Point | null): Point {
  if (control == null) return { ...current };
  return {
    x: 2 * current.x - control.x,
    y: 2 * current.y - control.y,
  };
}
