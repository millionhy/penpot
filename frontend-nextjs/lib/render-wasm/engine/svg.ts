// The SVG helpers the derived attrs need: the style and transform parsers of
// app.common.svg, its id extractor, and the part of app.common.types.color
// that resolves a paint to the "#rrggbb" the fill writer takes.
//
// The model keeps SVG attributes as plain objects whose keys are the source
// names (`stdDeviation`, `stop-color`, `xlink:href`), so these helpers read
// strings, not keywords. They live apart from the derivation so a later SVG
// upload slice can reuse them without pulling the whole port.

import { parseDouble } from "./numbers";
import type { Matrix6 } from "./modifiers";
import type { Point } from "./viewport";

// --- matrix (app.common.geom.matrix) ---------------------------------------

// [a b c d e f], the same order as the SVG matrix() function. The tuple and
// the point already exist for the modifier and viewport slices, so the SVG
// helpers reuse them instead of growing a second shape.
export type { Matrix6, Point };

export const IDENTITY_MATRIX: Matrix6 = [1, 0, 0, 1, 0, 0];

export function multiplyMatrix(
  m1: Matrix6 | null | undefined,
  m2: Matrix6 | null | undefined,
): Matrix6 {
  // A nil matrix is the identity, which is what gmt/multiply answers.
  if (m1 === null || m1 === undefined) return m2 ?? IDENTITY_MATRIX;
  if (m2 === null || m2 === undefined) return m1;

  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

// gpt/transform: x' = ax + cy + e, y' = bx + dy + f.
export function transformPoint(point: Point, matrix: Matrix6): Point {
  return {
    x: point.x * matrix[0] + point.y * matrix[2] + matrix[4],
    y: point.x * matrix[1] + point.y * matrix[3] + matrix[5],
  };
}

export function translateMatrix(x: number, y: number): Matrix6 {
  return [1, 0, 0, 1, x, y];
}

export function scaleMatrix(x: number, y: number): Matrix6 {
  return [x, 0, 0, y, 0, 0];
}

export function rotateMatrix(angle: number, center: Point = { x: 0, y: 0 }): Matrix6 {
  const radians = (angle * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const cx = center.x;
  const cy = center.y;
  // gmt/rotate-matrix moves the centre to the origin, rotates and moves back.
  return [cos, sin, -sin, cos, cx - cos * cx + sin * cy, cy - sin * cx - cos * cy];
}

export function skewMatrix(angleX: number, angleY: number): Matrix6 {
  const tanX = Math.tan((angleX * Math.PI) / 180);
  const tanY = Math.tan((angleY * Math.PI) / 180);
  return [1, tanY, tanX, 1, 0, 0];
}

// --- transform attribute (csvg/parse-transform) -----------------------------

const MATRICES_RE = /(matrix|translate|scale|rotate|skewX|skewY)\(([^)]*)\)/g;
const NUMBER_RE = /[+-]?\d*(\.\d+)?([eE][+-]?\d+)?/g;

// csvg/parse-numbers: every numeric token in the argument list.
export function parseNumbers(data: string): number[] {
  const out: number[] = [];
  for (const match of data.matchAll(NUMBER_RE)) {
    if (match[0] === "") continue;
    const parsed = parseDouble(match[0]);
    if (parsed !== undefined) out.push(parsed);
  }
  return out;
}

function toMatrix(type: string, params: readonly number[]): Matrix6 | undefined {
  const at = (index: number, fallback = 0) => params[index] ?? fallback;

  switch (type) {
    case "matrix":
      return [at(0, 1), at(1), at(2), at(3, 1), at(4), at(5)];
    case "translate":
      return translateMatrix(at(0), at(1));
    case "scale":
      // scale(v) scales both axes by the same value.
      return params.length <= 1
        ? scaleMatrix(at(0, 1), at(0, 1))
        : scaleMatrix(at(0, 1), at(1, 1));
    case "rotate":
      return params.length >= 3
        ? rotateMatrix(at(0), { x: at(1), y: at(2) })
        : rotateMatrix(at(0));
    case "skewX":
      return skewMatrix(at(0), 0);
    case "skewY":
      return skewMatrix(0, at(0));
    default:
      return undefined;
  }
}

// A non-string value (already a matrix, or nothing) means the identity.
export function parseTransform(transform: unknown): Matrix6 {
  if (typeof transform !== "string") return IDENTITY_MATRIX;

  let matrix: Matrix6 = IDENTITY_MATRIX;
  for (const match of transform.matchAll(MATRICES_RE)) {
    const next = toMatrix(match[1], parseNumbers(match[2]));
    if (next !== undefined) matrix = multiplyMatrix(matrix, next);
  }
  return matrix;
}

// --- style attribute (csvg/parse-style) ------------------------------------

// Keys keep their case and the first occurrence wins, like the compiled
// parser; an item without a colon maps to an undefined value.
export function parseStyle(style: string): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};
  for (const item of style.split(";")) {
    const trimmed = item.trim();
    const colon = trimmed.indexOf(":");
    const key = colon === -1 ? trimmed : trimmed.slice(0, colon);
    if (key === "" || Object.prototype.hasOwnProperty.call(result, key)) continue;
    result[key] = colon === -1 ? undefined : trimmed.slice(colon + 1);
  }
  return result;
}

// --- id references (csvg/extract-ids) --------------------------------------

// The compiled regex implements the XML name production; the filter and fill
// references this port reads are plain ids, so a run of non-delimiter bytes
// after "#" is enough and keeps the port small.
const XML_ID_RE = /#([^\s"'()]+)/g;

export function extractIds(value: unknown): string[] {
  if (typeof value === "string") {
    return [...value.matchAll(XML_ID_RE)].map((match) => match[1]);
  }
  if (Array.isArray(value)) return value.flatMap((item) => extractIds(item));
  return [];
}

// --- colour (app.common.types.color) ---------------------------------------

export const BLACK = "#000000";

const CSS_COLOR_NAMES: Readonly<Record<string, string>> = {
  aliceblue: "#f0f8ff",
  antiquewhite: "#faebd7",
  aqua: "#00ffff",
  aquamarine: "#7fffd4",
  azure: "#f0ffff",
  beige: "#f5f5dc",
  bisque: "#ffe4c4",
  black: "#000000",
  blanchedalmond: "#ffebcd",
  blue: "#0000ff",
  blueviolet: "#8a2be2",
  brown: "#a52a2a",
  burlywood: "#deb887",
  cadetblue: "#5f9ea0",
  chartreuse: "#7fff00",
  chocolate: "#d2691e",
  coral: "#ff7f50",
  cornflowerblue: "#6495ed",
  cornsilk: "#fff8dc",
  crimson: "#dc143c",
  cyan: "#00ffff",
  darkblue: "#00008b",
  darkcyan: "#008b8b",
  darkgoldenrod: "#b8860b",
  darkgray: "#a9a9a9",
  darkgreen: "#006400",
  darkgrey: "#a9a9a9",
  darkkhaki: "#bdb76b",
  darkmagenta: "#8b008b",
  darkolivegreen: "#556b2f",
  darkorange: "#ff8c00",
  darkorchid: "#9932cc",
  darkred: "#8b0000",
  darksalmon: "#e9967a",
  darkseagreen: "#8fbc8f",
  darkslateblue: "#483d8b",
  darkslategray: "#2f4f4f",
  darkslategrey: "#2f4f4f",
  darkturquoise: "#00ced1",
  darkviolet: "#9400d3",
  deeppink: "#ff1493",
  deepskyblue: "#00bfff",
  dimgray: "#696969",
  dimgrey: "#696969",
  dodgerblue: "#1e90ff",
  firebrick: "#b22222",
  floralwhite: "#fffaf0",
  forestgreen: "#228b22",
  fuchsia: "#ff00ff",
  gainsboro: "#dcdcdc",
  ghostwhite: "#f8f8ff",
  gold: "#ffd700",
  goldenrod: "#daa520",
  gray: "#808080",
  green: "#008000",
  greenyellow: "#adff2f",
  grey: "#808080",
  honeydew: "#f0fff0",
  hotpink: "#ff69b4",
  indianred: "#cd5c5c",
  indigo: "#4b0082",
  ivory: "#fffff0",
  khaki: "#f0e68c",
  lavender: "#e6e6fa",
  lavenderblush: "#fff0f5",
  lawngreen: "#7cfc00",
  lemonchiffon: "#fffacd",
  lightblue: "#add8e6",
  lightcoral: "#f08080",
  lightcyan: "#e0ffff",
  lightgoldenrodyellow: "#fafad2",
  lightgray: "#d3d3d3",
  lightgreen: "#90ee90",
  lightgrey: "#d3d3d3",
  lightpink: "#ffb6c1",
  lightsalmon: "#ffa07a",
  lightseagreen: "#20b2aa",
  lightskyblue: "#87cefa",
  lightslategray: "#778899",
  lightslategrey: "#778899",
  lightsteelblue: "#b0c4de",
  lightyellow: "#ffffe0",
  lime: "#00ff00",
  limegreen: "#32cd32",
  linen: "#faf0e6",
  magenta: "#ff00ff",
  maroon: "#800000",
  mediumaquamarine: "#66cdaa",
  mediumblue: "#0000cd",
  mediumorchid: "#ba55d3",
  mediumpurple: "#9370db",
  mediumseagreen: "#3cb371",
  mediumslateblue: "#7b68ee",
  mediumspringgreen: "#00fa9a",
  mediumturquoise: "#48d1cc",
  mediumvioletred: "#c71585",
  midnightblue: "#191970",
  mintcream: "#f5fffa",
  mistyrose: "#ffe4e1",
  moccasin: "#ffe4b5",
  navajowhite: "#ffdead",
  navy: "#000080",
  oldlace: "#fdf5e6",
  olive: "#808000",
  olivedrab: "#6b8e23",
  orange: "#ffa500",
  orangered: "#ff4500",
  orchid: "#da70d6",
  palegoldenrod: "#eee8aa",
  palegreen: "#98fb98",
  paleturquoise: "#afeeee",
  palevioletred: "#db7093",
  papayawhip: "#ffefd5",
  peachpuff: "#ffdab9",
  peru: "#cd853f",
  pink: "#ffc0cb",
  plum: "#dda0dd",
  powderblue: "#b0e0e6",
  purple: "#800080",
  red: "#ff0000",
  rosybrown: "#bc8f8f",
  royalblue: "#4169e1",
  saddlebrown: "#8b4513",
  salmon: "#fa8072",
  sandybrown: "#f4a460",
  seagreen: "#2e8b57",
  seashell: "#fff5ee",
  sienna: "#a0522d",
  silver: "#c0c0c0",
  skyblue: "#87ceeb",
  slateblue: "#6a5acd",
  slategray: "#708090",
  slategrey: "#708090",
  snow: "#fffafa",
  springgreen: "#00ff7f",
  steelblue: "#4682b4",
  tan: "#d2b48c",
  teal: "#008080",
  thistle: "#d8bfd8",
  tomato: "#ff6347",
  turquoise: "#40e0d0",
  violet: "#ee82ee",
  wheat: "#f5deb3",
  white: "#ffffff",
  whitesmoke: "#f5f5f5",
  yellow: "#ffff00",
  yellowgreen: "#9acd32",
};

const HEX_COLOR_RE = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const RGB_COLOR_RE = /^(?:|rgb)\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\)$/;

function validHexColor(value: string): boolean {
  return HEX_COLOR_RE.test(value);
}

function parseRgb(color: string): [number, number, number] | undefined {
  const match = RGB_COLOR_RE.exec(color);
  if (match === null) return undefined;

  const r = Number.parseInt(match[1], 10);
  const g = Number.parseInt(match[2], 10);
  const b = Number.parseInt(match[3], 10);
  if (r > 255 || g > 255 || b > 255) return undefined;
  return [r, g, b];
}

// color-string?: hex (3 or 6 digits), rgb(...) or a lower-case CSS name.
export function isColorString(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return (
    validHexColor(value) ||
    parseRgb(value) !== undefined ||
    Object.prototype.hasOwnProperty.call(CSS_COLOR_NAMES, value)
  );
}

export function rgbToHex([r, g, b]: readonly [number, number, number]): string {
  if (r < 0 || r > 255 || g < 0 || g > 255 || b < 0 || b > 255) {
    throw new Error(`render-wasm: not a valid rgb triple (${r}, ${g}, ${b})`);
  }
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

function normalizeHex(color: string): string {
  if (color.length === 4) {
    const [, r, g, b] = color;
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return color.toLowerCase();
}

// color/parse: the canonical lower-case hex, from a hex string, rgb(...) or
// a CSS name. The compiled helper also accepts the hex digits without "#"
// and normalizes the original string, which leaves the short form untouched;
// that quirk is kept so both sides answer the same for the same input.
export function parseColor(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;

  if (validHexColor(color) || validHexColor(`#${color}`)) {
    return normalizeHex(color);
  }

  const rgb = parseRgb(color);
  if (rgb !== undefined) return rgbToHex(rgb);

  return Object.prototype.hasOwnProperty.call(CSS_COLOR_NAMES, color.toLowerCase())
    ? CSS_COLOR_NAMES[color.toLowerCase()]
    : undefined;
}