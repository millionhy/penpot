// app.common.svg, Node side: the string parsing the SVG-derived attributes
// need. The browser namespace also builds path elements and React props; those
// are out of scope here.

import {
  matrix,
  multiply,
  point,
  rotateMatrix,
  scaleMatrix,
  skewMatrix,
  translateMatrix,
  type Matrix,
} from "./geom.js";

const NUMBERS_RE = /[+-]?\d*(\.\d+)?([eE][+-]?\d+)?/g;
const TRANSFORMS_RE = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
const IDS_RE = /#([\p{L}_][\p{L}\p{N}_.:-]*)/gu;

// `csvg/parse-numbers`. The pattern can match the empty string, so filter it
// out before parsing, exactly like `xf-parse-numbers`.
export function parseNumbers(data: string): number[] {
  const numbers: number[] = [];
  for (const match of data.match(NUMBERS_RE) ?? []) {
    if (match !== "") numbers.push(Number.parseFloat(match));
  }
  return numbers;
}

// `csvg/parse-style`: "a: 1; b: 2" -> {a: "1", b: "2"}. The first value of a
// repeated key wins.
export function parseStyle(style: string): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const item of style.split(";")) {
    const [key, value] = item.trim().split(":", 2);
    if (key === undefined || key === "") continue;
    if (!Object.hasOwn(parsed, key)) parsed[key] = value ?? "";
  }
  return parsed;
}

function toMatrix(type: string, params: number[]): Matrix {
  switch (type) {
    case "matrix":
      return matrix(
        params[0] ?? 1,
        params[1] ?? 0,
        params[2] ?? 0,
        params[3] ?? 1,
        params[4] ?? 0,
        params[5] ?? 0,
      );
    case "translate":
      return translateMatrix(params[0] ?? 0, params.length === 1 ? 0 : (params[1] ?? 0));
    case "scale":
      return params.length === 1
        ? scaleMatrix(params[0] ?? 1)
        : scaleMatrix(params[0] ?? 1, params[1] ?? 1);
    case "rotate":
      return params.length === 3
        ? rotateMatrix(params[0] ?? 0, point(params[1] ?? 0, params[2] ?? 0))
        : rotateMatrix(params[0] ?? 0);
    case "skewX":
      return skewMatrix(params[0] ?? 0, 0);
    case "skewY":
      return skewMatrix(0, params[0] ?? 0);
    default:
      return matrix();
  }
}

// `csvg/parse-transform`: the transforms compose left to right into one
// matrix; a non-string value yields the identity.
export function parseTransform(transform: unknown): Matrix {
  if (typeof transform !== "string") return matrix();
  let result = matrix();
  for (const match of transform.matchAll(TRANSFORMS_RE)) {
    result = multiply(result, toMatrix(match[1], parseNumbers(match[2])));
  }
  return result;
}

// `csvg/extract-ids`: every "#id" referenced by a value such as
// "url(#myId)". Non-strings are ignored, lists are flattened.
export function extractIds(value: unknown): string[] {
  if (typeof value === "string") return [...value.matchAll(IDS_RE)].map((match) => match[1]);
  if (Array.isArray(value)) return value.flatMap(extractIds);
  return [];
}