// TypeScript mirror of the frontend half of app.common.types.color.
//
// The Clojure branch stays in common/ until backend-rust replaces the JVM
// backend; this file only serves the Next.js shell and Node tooling. It keeps
// the CLJS semantics (tuple order, 0..1 saturation/lightness, HSV brightness on
// 0..255, HSB brightness on 0..100) so call sites ported from CLJS keep the
// same numbers.

export type RGB = [number, number, number];
export type RGBA = [number, number, number, number];
export type HSL = [number, number, number];
export type HSLA = [number, number, number, number];
export type HSV = [number, number, number];
export type HSB = [number, number, number];

export interface GradientStop {
  color: string;
  opacity?: number;
  offset: number;
}

export interface InterpolatedStop {
  color: string;
  opacity: number;
  r?: number;
  g?: number;
  b?: number;
  alpha?: number;
  offset: number;
}

export const BLACK = "#000000";
export const WHITE = "#FFFFFF";
export const GRAY_20 = "#B1B2B5";
export const INFO = "#59B9E2";
export const WARNING = "#FC8802";
export const DEFAULT_LAYOUT = "#DE4762";
export const CANVAS = "#E8E9EA";
export const DEFAULT_PIXEL_GRID_COLOR = "#0070E4";
export const DEFAULT_PIXEL_GRID_OPACITY = 0.2;

const REQUIRED_COLOR_ATTRS = new Set(["image", "gradient", "color"]);

// d/format-precision: toFixed and drop the trailing zeros.
export function formatPrecision(value: number, digits = 2): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[^0])0+$/, "$1");
}

function int(value: number): number {
  return Math.trunc(value);
}

function closeEnough(a: number, b: number, tolerance = 0.001): boolean {
  return Math.abs(a - b) <= tolerance;
}

// has-valid-color-attrs?: exactly one of image, gradient or color.
export function hasValidColorAttrs(color: unknown): boolean {
  if (color === null || typeof color !== "object") return false;
  const hits = Object.keys(color).filter((key) => REQUIRED_COLOR_ATTRS.has(key));
  return hits.length === 1;
}

const HEX_COLOR_RX = /^#(?:[0-9a-fA-F]{3}){1,2}$/;
const LOOSE_HEX_COLOR_RX = /^#([0-9a-fA-F]{6}|[0-9a-fA-F]{3})$/;
const RGB_COLOR_RX = /^(?:|rgb)\((\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\)$/;

// hex-color-string?: the schema predicate, three or six digits with a hash.
export function hexColorString(value: unknown): boolean {
  return typeof value === "string" && HEX_COLOR_RX.test(value);
}

// valid-hex-color?: the looser helper the UI uses.
export function validHexColor(color: unknown): boolean {
  return typeof color === "string" && LOOSE_HEX_COLOR_RX.test(color);
}

// parse-rgb: "rgb(1, 2, 3)" or "(1, 2, 3)"; out-of-range channels fail.
export function parseRgb(color: string): RGB | undefined {
  const match = RGB_COLOR_RX.exec(color);
  if (match === null) return undefined;
  const r = Number.parseInt(match[1], 10);
  const g = Number.parseInt(match[2], 10);
  const b = Number.parseInt(match[3], 10);
  const inRange = (v: number) => v >= 0 && v <= 255;
  if (!inRange(r) || !inRange(g) || !inRange(b)) return undefined;
  return [r, g, b];
}

export function validRgbColor(color: unknown): boolean {
  return typeof color === "string" && parseRgb(color) !== undefined;
}

// normalize-hex: expand #RGB and lowercase.
export function normalizeHex(color: string): string {
  if (color.length === 4) {
    return color
      .replace(/#(.)(.)(.)/, "#$1$1$2$2$3$3")
      .toLowerCase();
  }
  return color.toLowerCase();
}

export function rgbToStr([r, g, b, a]: readonly number[]): string {
  if (a !== undefined) return "rgba(" + [r, g, b, a].join(",") + ")";
  return "rgb(" + [r, g, b].join(",") + ")";
}

export function rgbToHsv([red, green, blue]: RGB): HSV {
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  if (min === max) return [0, 0, max];
  const delta = max - min;
  const saturation = delta / max;
  let hue = red === max ? (green - blue) / delta : green === max ? 2 + (blue - red) / delta : 4 + (red - green) / delta;
  hue *= 60;
  if (hue < 0) hue += 360;
  if (hue > 360) hue -= 360;
  return [hue, saturation, max];
}

export function hsvToRgb([h, s, brightness]: HSV): RGB {
  if (s === 0) return [brightness, brightness, brightness];
  const sextant = Math.trunc(Math.floor(h / 60));
  const remainder = h / 60 - sextant;
  const value = brightness ?? 0;
  const val1 = int(value * (1 - s));
  const val2 = int(value * (1 - s * remainder));
  const val3 = int(value * (1 - s * (1 - remainder)));
  switch (sextant) {
    case 1:
      return [val2, value, val1];
    case 2:
      return [val1, value, val3];
    case 3:
      return [val1, val2, value];
    case 4:
      return [val3, val1, value];
    case 5:
      return [value, val1, val2];
    default:
      return [value, val3, val1];
  }
}

// hex->rgb: parsing failure becomes black, like the CLJS try/catch.
export function hexToRgb(color: string): RGB {
  const parsed = Number.parseInt(color.slice(1), 16);
  if (!Number.isFinite(parsed)) return [0, 0, 0];
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}

export function hexToLum(color: string): number {
  const [r, g, b] = hexToRgb(color);
  return Math.sqrt(0.241 * r + 0.691 * g + 0.068 * b);
}

export function rgbToHex([r, g, b]: RGB): string {
  const [ri, gi, bi] = [int(r), int(g), int(b)];
  const outOfRange = [ri, gi, bi].some((v) => v !== (v & 0xff));
  if (outOfRange) throw new Error("not valid rgb");
  const rgb = (ri << 16) | (gi << 8) | bi;
  return "#" + rgb.toString(16).padStart(6, "0");
}

export function rgbToHsl([r, g, b]: RGB): HSL {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const h =
    max === min
      ? 0
      : max === rn
        ? 60 * ((gn - bn) / (max - min))
        : max === gn
          ? 120 + 60 * ((bn - rn) / (max - min))
          : 240 + 60 * ((rn - gn) / (max - min));
  const s = l > 0 && l <= 0.5 ? (max - min) / (2 * l) : (max - min) / (2 - 2 * l);
  return [((h % 360) + 360) % 360, s, l];
}

export function hexToHsv(color: string): HSV {
  return rgbToHsv(hexToRgb(color));
}

export function hexToRgba(color: string, opacity: number): RGBA {
  const [r, g, b] = hexToRgb(color);
  return [r, g, b, opacity];
}

export function hexToHsl(color: string): HSL {
  try {
    return rgbToHsl(hexToRgb(color));
  } catch {
    return [0, 0, 0];
  }
}

export function hexToHsla(color: string, opacity: number): HSLA {
  return [...hexToHsl(color), opacity] as HSLA;
}

// format-hsla: "h, s%, l%, a" with the hue truncated.
export function formatHsla([h, s, l, a]: HSLA): string {
  return (
    int(h) + ", " + formatPrecision(s * 100) + "%, " + formatPrecision(l * 100) + "%, " + formatPrecision(a)
  );
}

// format-rgba: "r, g, b, a" with the alpha at two decimals.
export function formatRgba([r, g, b, a]: RGBA): string {
  return [r, g, b, formatPrecision(a)].join(", ");
}

function hueToRgb(v1: number, v2: number, vh: number): number {
  let hue = vh;
  if (hue < 0) hue += 1;
  else if (hue > 1) hue -= 1;
  if (6 * hue < 1) return v1 + (v2 - v1) * 6 * hue;
  if (2 * hue < 1) return v2;
  if (3 * hue < 2) return v1 + (v2 - v1) * (2 / 3 - hue) * 6;
  return v1;
}

export function hslToRgb([h, s, l]: HSL): RGB {
  if (s === 0) {
    const gray = l * 255;
    return [gray, gray, gray];
  }
  const normH = h / 360;
  const temp2 = l < 0.5 ? l * (1 + s) : l + s - s * l;
  const temp1 = l * 2 - temp2;
  return [
    Math.round(255 * hueToRgb(temp1, temp2, normH + 1 / 3)),
    Math.round(255 * hueToRgb(temp1, temp2, normH)),
    Math.round(255 * hueToRgb(temp1, temp2, normH - 1 / 3)),
  ];
}

export function hslToHex(hsl: HSL): string {
  return rgbToHex(hslToRgb(hsl));
}

export function hslToHsv(hsl: HSL): HSV {
  return rgbToHsv(hslToRgb(hsl));
}

export function hsvToHex(hsv: HSV): string {
  return rgbToHex(hsvToRgb(hsv));
}

export function hsvToHsl(hsv: HSV): HSL {
  return hexToHsl(hsvToHex(hsv));
}

// HSB keeps brightness on 0..100 for the picker UIs; HSV keeps 0..255.
export function rgbToHsb(rgb: RGB): HSB {
  const [h, s, v] = rgbToHsv(rgb);
  return [h, s, (v / 255) * 100];
}

export function hsbToRgb([h, s, b]: HSB): RGB {
  return hsvToRgb([h, s, int((b / 100) * 255)]);
}

export function hexToHsb(color: string): HSB {
  return rgbToHsb(hexToRgb(color));
}

export function hsbToHex(hsb: HSB): string {
  return rgbToHex(hsbToRgb(hsb));
}

export function hsvToHsb([h, s, v]: HSV): HSB {
  return [h, s, (v / 255) * 100];
}

export function hsbToHsv([h, s, b]: HSB): HSV {
  return [h, s, int((b / 100) * 255)];
}

// expand-hex on a bare string: 1 -> ffffff, 2 -> ffffff, 3 -> ff00ff.
export function expandHex(value: string): string {
  if (/^[0-9A-Fa-f]$/.test(value)) return value.repeat(6);
  if (/^[0-9A-Fa-f]{2}$/.test(value)) return value.repeat(3);
  if (/^[0-9A-Fa-f]{3}$/.test(value)) {
    return value[0] + value[0] + value[1] + value[1] + value[2] + value[2];
  }
  return value;
}

export function prependHash(color: string): string {
  return color.startsWith("#") ? color : "#" + color;
}

export function removeHash(color: string): string {
  return color.startsWith("#") ? color.slice(1) : color;
}

export function colorString(color: unknown): boolean {
  return (
    typeof color === "string" &&
    (validHexColor(color) || validRgbColor(color) || Object.hasOwn(COLOR_NAMES, color))
  );
}

// parse: hex (with or without hash), rgb() or a CSS color name -> "#rrggbb".
export function parseColor(color: unknown): string | undefined {
  if (typeof color !== "string") return undefined;
  if (validHexColor(color) || validHexColor("#" + color)) return normalizeHex(color);
  const rgb = parseRgb(color);
  if (rgb !== undefined) return rgbToHex(rgb);
  return COLOR_NAMES[color.toLowerCase()];
}

// UI convenience over hex->rgb: accept "#abc" and "abc", never throw.
export function parseHexColor(color: string): RGB | undefined {
  const clean = color.replace(/^#/, "");
  const expanded = expandHex(clean);
  if (!/^[0-9A-Fa-f]{6}$/.test(expanded)) return undefined;
  return hexToRgb("#" + expanded);
}

export function nextRgb([r, g, b]: RGB): RGB {
  if (r === 255 && g === 255 && b === 255) throw new Error("cannot get next color");
  if (g === 255 && b === 255) return [r + 1, 0, 0];
  if (b === 255) return [r, g + 1, 0];
  return [r, g, b + 1];
}

export function reduceRange(value: number, range: number): number {
  return Math.floor(value * range) / range;
}

// sort-colors: hue bucket first, then brightness.
export function sortColors(a: { color: string }, b: { color: string }): number {
  const [ah, , av] = hexToHsv(a.color);
  const [bh, , bv] = hexToHsv(b.color);
  const ka = reduceRange(ah / 60, 8) * 100 + (av / 255) * 10;
  const kb = reduceRange(bh / 60, 8) * 100 + (bv / 255) * 10;
  return ka - kb;
}

export function interpolateColor(c1: GradientStop, c2: GradientStop, offset: number): InterpolatedStop {
  const alpha1 = c1.opacity ?? 0;
  const alpha2 = c2.opacity ?? 0;
  if (offset <= c1.offset) return { ...c1, opacity: alpha1 };
  if (offset >= c2.offset) return { ...c2, opacity: alpha2 };
  const ratio = (offset - c1.offset) / (c2.offset - c1.offset);
  const [r1, g1, b1] = hexToRgb(c1.color);
  const [r2, g2, b2] = hexToRgb(c2.color);
  const r = r1 + (r2 - r1) * ratio;
  const g = g1 + (g2 - g1) * ratio;
  const b = b1 + (b2 - b1) * ratio;
  const a = alpha1 + (alpha2 - alpha1) * ratio;
  return { color: rgbToHex([r, g, b]), opacity: a, r, g, b, alpha: a, offset };
}

function offsetSpread(from: number, to: number, count: number): number[] {
  if (count <= 1) return [from];
  return Array.from({ length: count }, (_, index) =>
    Number(((from + ((to - from) / (count - 1)) * index) as number).toFixed(2)),
  );
}

export function isUniformSpread(stops: readonly GradientStop[]): boolean {
  const from = stops[0];
  const to = stops[stops.length - 1];
  if (from === undefined || to === undefined) return false;
  const expected = offsetSpread(from.offset, to.offset, stops.length);
  return stops.every((stop, index) => {
    if (!closeEnough(stop.offset, expected[index])) return false;
    const interpolated = interpolateColor(from, to, expected[index]);
    return interpolated.color === stop.color && interpolated.opacity === stop.opacity;
  });
}

export function uniformSpread(from: GradientStop, to: GradientStop, count: number): InterpolatedStop[] {
  return offsetSpread(from.offset, to.offset, count).map((offset) => interpolateColor(from, to, offset));
}

export function interpolateGradient(stops: readonly GradientStop[], offset: number): InterpolatedStop {
  if (stops.length === 0) throw new Error("no gradient stops");
  const index = stops.findIndex((stop) => offset <= stop.offset);
  const start = index === -1 ? stops[stops.length - 1] : index === 0 ? stops[0] : stops[index - 1];
  const end = index === -1 ? stops[stops.length - 1] : stops[index];
  return interpolateColor(start, end, offset);
}

// The CSS color names map of the CLJS namespace, lowercased.
export const COLOR_NAMES: Readonly<Record<string, string>> = {
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

export const COLOR_NAME_LIST = Object.keys(COLOR_NAMES);
