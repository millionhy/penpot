// This Source Code Form is subject to the terms of the Mozilla Public
// License, v. 2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/.
//
// Copyright (c) KALEIDOS SUBSIDIARY SL

// Path content handling. The CLJS builder keeps a `PathData` instance that
// serializes as an SVG path string for `getInternalState` and as a vector of
// segments for the export. Both views are derived from this module.

import type { PathSegment, Point, Rect } from "./model.ts";
import { makeRect, pointsToRect } from "./geometry.ts";

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

function pointOf(segment: PathSegment): Point {
  return { x: segment.params.x, y: segment.params.y };
}

function evalCubic(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  t: number,
): number {
  const mt = 1 - t;
  return (
    mt * mt * mt * p0 +
    3 * mt * mt * t * p1 +
    3 * mt * t * t * p2 +
    t * t * t * p3
  );
}

function cubicExtremities(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
): number[] {
  const a = -p0 + 3 * p1 - 3 * p2 + p3;
  const b = 2 * (p0 - 2 * p1 + p2);
  const c = p1 - p0;

  const roots: number[] = [];
  const EPSILON = 1e-9;

  if (Math.abs(a) < EPSILON) {
    if (Math.abs(b) > EPSILON) roots.push(-c / b);
  } else {
    const discriminant = b * b - 4 * a * c;
    if (discriminant >= 0) {
      const sqrt = Math.sqrt(discriminant);
      roots.push((-b + sqrt) / (2 * a), (-b - sqrt) / (2 * a));
    }
  }

  return roots.filter((t) => t > 0 && t < 1);
}

/**
 * Bounding box of the path, computing the exact curve extrema like
 * `content->selrect` does.
 */
export function calcSelrect(segments: readonly PathSegment[]): Rect {
  const points: Point[] = [];

  let from: Point | null = null;
  let move: Point | null = null;

  for (const segment of segments) {
    switch (segment.command) {
      case "move-to": {
        const to = pointOf(segment);
        points.push(to);
        from = to;
        move = to;
        break;
      }

      case "line-to": {
        const to = pointOf(segment);
        if (from != null) points.push(from);
        points.push(to);
        from = to;
        break;
      }

      case "curve-to": {
        const to = pointOf(segment);
        const c1: Point = { x: segment.params.c1x, y: segment.params.c1y };
        const c2: Point = { x: segment.params.c2x, y: segment.params.c2y };

        if (from != null) {
          points.push(from);
          points.push(to);

          for (const t of cubicExtremities(from.x, c1.x, c2.x, to.x)) {
            points.push({
              x: evalCubic(from.x, c1.x, c2.x, to.x, t),
              y: evalCubic(from.y, c1.y, c2.y, to.y, t),
            });
          }

          for (const t of cubicExtremities(from.y, c1.y, c2.y, to.y)) {
            points.push({
              x: evalCubic(from.x, c1.x, c2.x, to.x, t),
              y: evalCubic(from.y, c1.y, c2.y, to.y, t),
            });
          }
        }

        from = to;
        break;
      }

      case "close-path": {
        if (move != null) points.push(move);
        from = move;
        break;
      }
    }
  }

  if (points.length === 0) return makeRect();
  return pointsToRect(points);
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
