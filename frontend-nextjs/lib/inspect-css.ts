// Inspect CSS engine (D23). Headless port of the slice of
// app.util.code-gen.style-css, style-css-values and style-css-formats that
// the computed panel of the viewer inspect section reads: the value of one
// CSS property for a shape, its formatted text and the "property: value;"
// rule the copy buttons put on the clipboard.
//
// Kept free of JSX so it runs in vitest's node environment, like
// lib/viewer.ts.
//
// Deviations from the CLJS original, documented:
// - Tri-state values: the CLJS `if-let` treats 0 as truthy, so a zero left /
//   top / gap survives; here the getters return null only for an absent
//   value, and 0 flows through untouched.
// - The shape data crosses the transit boundary as plain objects (keyword
//   keys become kebab-case strings, keywords become strings), so every
//   getter reads string keys and compares string values.
// - The matrix helpers are local: app.common.geom.matrix is not part of the
//   shell bundle. They follow the SVG composition order the CLJS uses.
// - formatters read only the options the inspect panel passes (color format
//   and the root-shape set); the text generator options are not ported.

import {
  ZERO_UUID,
  resolveFileMedia,
  type ViewerObjects,
  type ViewerShape,
} from "@/lib/viewer";

// --- Types ------------------------------------------------------------------

export interface InspectPoint {
  x: number;
  y: number;
}

export interface InspectRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface InspectMatrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export type InspectColorFormat = "hex" | "rgba" | "hsla";

export interface InspectCssOptions {
  format?: InspectColorFormat;
  // generate-style's :root-shapes: the shapes of the selection that are a
  // root of the CSS tree (width becomes 100%, flex-grow 1).
  rootShapes?: ReadonlySet<string>;
  // The public URI prefix used to resolve fill images.
  publicUri?: string;
  shareId?: string | null;
}

// A fill / stroke color: the CLJS fill->color and stroke->color maps.
export interface InspectColor {
  color?: string;
  opacity?: number;
  gradient?: unknown;
  image?: unknown;
  "ref-id"?: string;
  "ref-file"?: string;
  name?: string;
}

// The CLJS getters accept either a shape or (for the stroke rows) the stroke
// map itself, so the engine takes the loose shape and casts locally.
export type CssShape = ViewerShape | Record<string, unknown>;

// --- Numbers ----------------------------------------------------------------

// mth/precision: round to `digits` decimals.
export function precision(value: number, digits = 2): number {
  const factor = Math.pow(10, digits);
  return Math.round(value * factor) / factor;
}

// fmt/format-number: the rounded value as text.
export function formatNumber(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return String(value);
  return String(precision(parsed));
}

// fmt/format-pixels: the rounded value with the px unit.
export function formatPixels(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "";
  return formatNumber(value) + "px";
}

// fmt/format-percent: a fraction as a percentage.
export function formatPercent(value: number): string {
  return formatNumber(value * 100) + "%";
}

// fmt/format-matrix: to-fixed keeps the trailing zeros ("1.00").
export function formatMatrix(matrix: InspectMatrix): string {
  const fixed = (value: number): string => value.toFixed(2);
  return (
    "matrix(" +
    [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f].map(fixed).join(", ") +
    ")"
  );
}

// d/format-precision: a number with at most `digits` decimals and no
// trailing zeros.
export function formatPrecision(value: number, digits = 2): string {
  return value
    .toFixed(digits)
    .replace(/\.0+$/, "")
    .replace(/(\.\d*[^0])0+$/, "$1");
}

// --- Colors -----------------------------------------------------------------

function expandHex(hex: string): string {
  const clean = hex.replace(/^#/, "").toLowerCase();
  if (clean.length === 3) {
    return clean
      .split("")
      .map((char) => char + char)
      .join("");
  }
  return clean.slice(0, 6).padEnd(6, "0");
}

function hexToRgb(hex: string): [number, number, number] {
  const clean = expandHex(hex);
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

// rgb->hsl of app.common.types.color: hues in degrees, s and l as 0..1.
export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const delta = max - min;
  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  let h: number;
  if (max === rn) h = (gn - bn) / delta + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / delta + 2;
  else h = (rn - gn) / delta + 4;
  return [h * 60, s, l];
}

// cc/format-rgba: "r, g, b, a" with the alpha at two decimals.
export function formatRgba(r: number, g: number, b: number, a: number): string {
  return [Math.round(r), Math.round(g), Math.round(b), formatPrecision(a, 2)].join(", ");
}

// cc/format-hsla: "h, s%, l%, a".
export function formatHsla(h: number, s: number, l: number, a: number): string {
  return (
    Math.round(h) + ", " + formatNumber(s * 100) + "%, " + formatNumber(l * 100) + "%, " + formatNumber(a)
  );
}

// d/opacity-to-hex: the alpha byte as two uppercase hex digits.
export function opacityToHex(opacity: number): string {
  return Math.round(opacity * 255)
    .toString(16)
    .padStart(2, "0")
    .toUpperCase();
}

function cssRgba(color: string, opacity: number): string {
  const [r, g, b] = hexToRgb(color);
  return "rgba(" + formatRgba(r, g, b, opacity) + ")";
}

interface GradientStop {
  color?: string;
  opacity?: number;
  offset?: number;
}

interface Gradient {
  type?: string;
  stops?: GradientStop[];
}

// uc/gradient->css: a linear gradient runs to bottom, a radial one is a
// circle; the stops keep the raw offset percentage.
export function gradientToCss(gradient: Gradient): string {
  const stops = (gradient.stops ?? [])
    .map((stop) => cssRgba(stop.color ?? "#000000", stop.opacity ?? 1) + " " + String(stop.offset ?? 0) + "%")
    .join(", ");
  return gradient.type === "radial"
    ? "radial-gradient(circle, " + stops + ")"
    : "linear-gradient(to bottom, " + stops + ")";
}

// uc/color->format->background: the css background of a color.
export function colorToBackground(color: InspectColor, format: InspectColorFormat): string {
  const gradient = color.gradient as Gradient | undefined;
  if (gradient !== undefined && gradient !== null && gradient.type !== "multiple") {
    return gradientToCss(gradient);
  }
  const base = color.color ?? "";
  const opacity = color.opacity ?? 1;
  if (format === "rgba") return cssRgba(base, opacity);
  if (format === "hsla") {
    const [r, g, b] = hexToRgb(base);
    const [h, s, l] = rgbToHsl(r, g, b);
    return "hsla(" + formatHsla(h, s, l, opacity) + ")";
  }
  if (format === "hex") return base + opacityToHex(opacity);
  return "transparent";
}

// fmt/format-color-value: an image fill becomes a background shorthand; a
// translucent one carries a dummy white gradient because css cannot set the
// opacity of a background image.
export function formatColorValue(color: InspectColor, options: InspectCssOptions = {}): string {
  const format = options.format ?? "hex";
  const image = color.image as { id: string; "data-uri"?: string | null; name?: string } | undefined;
  if (image !== undefined && image !== null) {
    const url = resolveFileMedia(options.publicUri ?? "", image, { shareId: options.shareId ?? null });
    const opacity = color.opacity ?? 1;
    if (opacity !== 1) {
      const dummy = gradientToCss({
        type: "linear",
        stops: [
          { color: "#FFFFFF", opacity },
          { color: "#FFFFFF", opacity },
        ],
      });
      return dummy + ", url(" + url + ") no-repeat center center / cover";
    }
    return "url(" + url + ") no-repeat center center / cover";
  }
  return colorToBackground(color, format);
}

// The swatch of a color row: the same background, without the image branch
// (the color bullet shows the image itself).
export function colorSwatch(color: InspectColor, format: InspectColorFormat): string {
  return colorToBackground(color, format);
}

// --- Matrices ---------------------------------------------------------------

const UNIT_MATRIX: InspectMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

export function matrixOf(value: unknown): InspectMatrix {
  if (value === null || value === undefined || typeof value !== "object") return UNIT_MATRIX;
  const matrix = value as Partial<InspectMatrix>;
  const read = (key: keyof InspectMatrix): number =>
    typeof matrix[key] === "number" ? (matrix[key] as number) : UNIT_MATRIX[key];
  return { a: read("a"), b: read("b"), c: read("c"), d: read("d"), e: read("e"), f: read("f") };
}

// The SVG composition of two matrices: apply m2 first, then m1.
export function multiplyMatrix(m1: InspectMatrix, m2: InspectMatrix): InspectMatrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

export function inverseMatrix(matrix: InspectMatrix): InspectMatrix {
  const det = matrix.a * matrix.d - matrix.b * matrix.c;
  if (det === 0) return UNIT_MATRIX;
  return {
    a: matrix.d / det,
    b: -matrix.b / det,
    c: -matrix.c / det,
    d: matrix.a / det,
    e: (matrix.c * matrix.f - matrix.d * matrix.e) / det,
    f: (matrix.b * matrix.e - matrix.a * matrix.f) / det,
  };
}

export function isUnitMatrix(matrix: InspectMatrix): boolean {
  return (
    matrix.a === 1 &&
    matrix.b === 0 &&
    matrix.c === 0 &&
    matrix.d === 1 &&
    matrix.e === 0 &&
    matrix.f === 0
  );
}

export function translateMatrix(x: number, y: number): InspectMatrix {
  return { a: 1, b: 0, c: 0, d: 1, e: x, f: y };
}

export function transformPoint(point: InspectPoint, matrix: InspectMatrix): InspectPoint {
  return {
    x: point.x * matrix.a + point.y * matrix.c + matrix.e,
    y: point.x * matrix.b + point.y * matrix.d + matrix.f,
  };
}

// gsh/transform-points: translate to the center, apply the matrix, translate
// back.
export function transformPoints(
  points: InspectPoint[],
  center: InspectPoint,
  matrix: InspectMatrix,
): InspectPoint[] {
  const full = multiplyMatrix(
    multiplyMatrix(translateMatrix(center.x, center.y), matrix),
    translateMatrix(-center.x, -center.y),
  );
  return points.map((point) => transformPoint(point, full));
}

// gsh/calculate-geometry's selrect: the axis-aligned box of the points.
export function pointsToRect(points: InspectPoint[]): InspectRect {
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}

// --- Shape predicates -------------------------------------------------------

function asShape(shape: CssShape): ViewerShape {
  return shape as ViewerShape;
}

function str(shape: CssShape, key: string): string | null {
  const value = asShape(shape)[key];
  return typeof value === "string" ? value : null;
}

function num(shape: CssShape, key: string): number | null {
  const value = asShape(shape)[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function arr(shape: CssShape, key: string): unknown[] {
  const value = asShape(shape)[key];
  return Array.isArray(value) ? value : [];
}

function rectOf(shape: CssShape): InspectRect | null {
  const rect = asShape(shape).selrect;
  if (rect === undefined || rect === null) return null;
  return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
}

function pointsOf(shape: CssShape): InspectPoint[] {
  const rect = rectOf(shape);
  if (rect === null) return [];
  const data = asShape(shape).selrect!;
  const x1 = typeof data.x1 === "number" ? data.x1 : rect.x;
  const y1 = typeof data.y1 === "number" ? data.y1 : rect.y;
  const x2 = typeof data.x2 === "number" ? data.x2 : rect.x + rect.width;
  const y2 = typeof data.y2 === "number" ? data.y2 : rect.y + rect.height;
  return [
    { x: x1, y: y1 },
    { x: x2, y: y1 },
    { x: x2, y: y2 },
    { x: x1, y: y2 },
  ];
}

function centerOf(rect: InspectRect): InspectPoint {
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
}

function parentOf(objects: ViewerObjects, shape: CssShape): ViewerShape | null {
  const parentId = str(shape, "parent-id");
  if (parentId === null) return null;
  return objects[parentId] ?? null;
}

function isFrame(shape: CssShape | null | undefined): boolean {
  return shape !== null && shape !== undefined && str(shape, "type") === "frame";
}

function isRootFrame(shape: CssShape): boolean {
  return (
    isFrame(shape) && str(shape, "frame-id") === ZERO_UUID && str(shape, "id") !== ZERO_UUID
  );
}

function isFlexLayout(shape: CssShape | null | undefined): boolean {
  return isFrame(shape) && str(shape!, "layout") === "flex";
}

function isGridLayout(shape: CssShape | null | undefined): boolean {
  return isFrame(shape) && str(shape!, "layout") === "grid";
}

function isAnyLayout(shape: CssShape | null | undefined): boolean {
  return isFlexLayout(shape) || isGridLayout(shape);
}

function isFlexChild(objects: ViewerObjects, shape: CssShape): boolean {
  return isFlexLayout(parentOf(objects, shape));
}

function isGridChild(objects: ViewerObjects, shape: CssShape): boolean {
  return isGridLayout(parentOf(objects, shape));
}

function isLayoutChild(objects: ViewerObjects, shape: CssShape): boolean {
  return isAnyLayout(parentOf(objects, shape));
}

// ctl/position-absolute?: out of the layout flow.
export function isPositionAbsolute(shape: CssShape): boolean {
  return asShape(shape)["layout-item-absolute"] === true || asShape(shape)["hidden"] === true;
}

// cgc/svg-markup?: rendered through an svg instead of html + css.
export function isSvgMarkup(shape: CssShape): boolean {
  const type = str(shape, "type");
  if (type === "path" || type === "bool" || type === "svg-raw" || type === "mask") return true;
  if (asShape(shape)["svg-attrs"] !== undefined && asShape(shape)["svg-attrs"] !== null) return true;
  if (type === "text" && (arr(shape, "shadow").length > 0 || arr(shape, "strokes").length > 0)) {
    return true;
  }
  if (arr(shape, "fills").length > 1) return true;
  const strokes = arr(shape, "strokes");
  if (strokes.length > 1) return true;
  if (strokes.length === 1) {
    const stroke = strokes[0] as Record<string, unknown>;
    return stroke["stroke-alignment"] !== "inner";
  }
  return false;
}

// cgc/has-wrapper?: a layout child with its own transform is wrapped.
export function hasWrapper(objects: ViewerObjects, shape: CssShape): boolean {
  if (!isLayoutChild(objects, shape) || isPositionAbsolute(shape)) return false;
  return !isUnitMatrix(matrixOf(asShape(shape)["transform"]));
}

// cfh/group-shape? and cfh/group-like-shape?.
function isGroup(shape: CssShape): boolean {
  return str(shape, "type") === "group";
}

function isGroupLike(shape: CssShape): boolean {
  const type = str(shape, "type");
  return type === "group" || type === "bool";
}

function isText(shape: CssShape): boolean {
  return str(shape, "type") === "text";
}

function isCircle(shape: CssShape): boolean {
  return str(shape, "type") === "circle";
}

// --- Layout helpers ---------------------------------------------------------

function gapsOf(shape: CssShape): [number, number] {
  const gap = asShape(shape)["layout-gap"] as
    | { "row-gap"?: number; "column-gap"?: number }
    | undefined;
  const row = typeof gap?.["row-gap"] === "number" ? gap["row-gap"] : 0;
  const column = typeof gap?.["column-gap"] === "number" ? gap["column-gap"] : 0;
  return [Number.isFinite(row) ? row : 0, Number.isFinite(column) ? column : 0];
}

interface GridCell {
  row?: number;
  column?: number;
  "row-span"?: number;
  "column-span"?: number;
  position?: string;
  "area-name"?: string;
  shapes?: string[];
  "align-self"?: string;
  "justify-self"?: string;
}

function cellsOf(parent: ViewerShape | null): GridCell[] {
  if (parent === null) return [];
  const cells = parent["layout-grid-cells"] as Record<string, GridCell> | undefined;
  if (cells === undefined || cells === null) return [];
  return Object.values(cells);
}

// ctl/get-cell-by-shape-id.
export function getCellByShapeId(parent: ViewerShape | null, shapeId: string): GridCell | null {
  return cellsOf(parent).find((cell) => (cell.shapes ?? []).includes(shapeId)) ?? null;
}

// ctl/get-cell-by-position.
export function getCellByPosition(
  parent: ViewerShape | null,
  row: number,
  column: number,
): GridCell | null {
  return (
    cellsOf(parent).find(
      (cell) =>
        row >= (cell.row ?? 0) &&
        column >= (cell.column ?? 0) &&
        column < (cell.column ?? 0) + (cell["column-span"] ?? 1) &&
        row < (cell.row ?? 0) + (cell["row-span"] ?? 1),
    ) ?? null
  );
}

function strokeSource(shape: CssShape): Record<string, unknown> | null {
  const source = asShape(shape);
  if (Array.isArray(source["strokes"])) {
    const first = (source["strokes"] as unknown[])[0];
    return (first as Record<string, unknown>) ?? null;
  }
  return source as Record<string, unknown>;
}

// v/stroke-per-side-widths: [top right bottom left] when the sides differ.
export function strokePerSideWidths(stroke: unknown): number[] | null {
  if (stroke === null || stroke === undefined || typeof stroke !== "object") return null;
  const source = stroke as Record<string, unknown>;
  const width = typeof source["stroke-width"] === "number" ? source["stroke-width"] : 0;
  const read = (key: string): number =>
    typeof source[key] === "number" ? (source[key] as number) : width;
  const top = read("stroke-width-top");
  const right = read("stroke-width-right");
  const bottom = read("stroke-width-bottom");
  const left = read("stroke-width-left");
  if (top === right && right === bottom && bottom === left) return null;
  return [top, right, bottom, left];
}

interface StrokeData {
  color: InspectColor;
  style: string;
  width: number;
}

function strokeData(stroke: Record<string, unknown> | null): StrokeData | null {
  if (stroke === null) return null;
  const style = stroke["stroke-style"];
  if (typeof style !== "string" || style === "none") return null;
  return {
    color: {
      color: typeof stroke["stroke-color"] === "string" ? stroke["stroke-color"] : undefined,
      opacity: typeof stroke["stroke-opacity"] === "number" ? stroke["stroke-opacity"] : undefined,
      gradient: stroke["stroke-color-gradient"],
      image: stroke["stroke-image"],
      "ref-id":
        typeof stroke["stroke-color-ref-id"] === "string"
          ? stroke["stroke-color-ref-id"]
          : undefined,
      "ref-file":
        typeof stroke["stroke-color-ref-file"] === "string"
          ? stroke["stroke-color-ref-file"]
          : undefined,
    },
    style,
    width: typeof stroke["stroke-width"] === "number" ? stroke["stroke-width"] : 0,
  };
}

// The stroke of a border width row, from a shape or from a stroke map.
function borderStroke(shape: CssShape): Record<string, unknown> | null {
  const source = asShape(shape);
  if (Array.isArray(source["strokes"])) {
    const first = (source["strokes"] as unknown[])[0];
    return (first as Record<string, unknown>) ?? null;
  }
  return source as Record<string, unknown>;
}

// fill->color of a fill / shape.
export function fillColor(shape: CssShape): InspectColor {
  return {
    color: str(shape, "fill-color") ?? undefined,
    opacity: num(shape, "fill-opacity") ?? undefined,
    gradient: asShape(shape)["fill-color-gradient"],
    image: asShape(shape)["fill-image"],
  };
}

// stroke->color of a stroke.
export function strokeColor(shape: CssShape): InspectColor {
  return {
    color: str(shape, "stroke-color") ?? undefined,
    opacity: num(shape, "stroke-opacity") ?? undefined,
    gradient: asShape(shape)["stroke-color-gradient"],
    image: asShape(shape)["stroke-image"],
    "ref-id": str(shape, "stroke-color-ref-id") ?? undefined,
    "ref-file": str(shape, "stroke-color-ref-file") ?? undefined,
  };
}

// --- Values -----------------------------------------------------------------

function shapePosition(shape: CssShape, objects: ViewerObjects, coord: "x" | "y"): number | null {
  if (isRootFrame(shape)) return null;
  if (isLayoutChild(objects, shape) && !isPositionAbsolute(shape)) return null;

  const parent = parentOf(objects, shape);
  if (parent === null) return null;
  const parentRect = rectOf(parent);
  if (parentRect === null) return null;

  const inverse = matrixOf(parent["transform-inverse"]);
  const points = transformPoints(pointsOf(shape), centerOf(parentRect), inverse);
  if (points.length === 0) return null;
  const selrect = pointsToRect(points);

  let borderWidth = 0;
  const stroke = strokeData(strokeSource(parent));
  if (stroke !== null && !isSvgMarkup(parent)) borderWidth = stroke.width;

  const shapeValue = coord === "x" ? selrect.x : selrect.y;
  const parentValue = coord === "x" ? parentRect.x : parentRect.y;
  return shapeValue - parentValue - borderWidth;
}

function shapeSize(
  shape: CssShape,
  objects: ViewerObjects,
  type: "width" | "height",
): number | string | null {
  const parent = parentOf(objects, shape);
  const sizing =
    type === "width"
      ? str(shape, "layout-item-h-sizing")
      : str(shape, "layout-item-v-sizing");
  const dir = parent !== null ? str(parent, "layout-flex-dir") : null;

  if (isFlexChild(objects, shape)) {
    const fillAcross =
      type === "height"
        ? (dir === "row" || dir === "row-reverse") && sizing === "fill"
        : (dir === "column" || dir === "column-reverse") && sizing === "fill";
    if (fillAcross) return "fill";
    if (sizing === "fill") return null;
  }
  if (isGridChild(objects, shape) && sizing === "fill") return null;
  if (isAnyLayout(shape) && sizing === "auto" && !isSvgMarkup(shape)) return "auto";

  const rect = rectOf(shape);
  if (rect !== null) return type === "width" ? rect.width : rect.height;
  const value = asShape(shape)[type];
  return typeof value === "number" ? value : null;
}

function shapeTransform(shape: CssShape, objects: ViewerObjects): string | null {
  const parent = parentOf(objects, shape);

  let matrix: InspectMatrix;
  if (isSvgMarkup(shape)) {
    matrix = matrixOf(parent?.["transform-inverse"]);
  } else {
    matrix = multiplyMatrix(
      matrixOf(asShape(shape)["transform"]),
      matrixOf(parent?.["transform-inverse"]),
    );
  }
  const text = isUnitMatrix(matrix) ? null : formatMatrix(matrix);
  if (hasWrapper(objects, shape)) return "translate(-50%, -50%) " + (text ?? "");
  return text;
}

function borderWidthOfStroke(shape: CssShape): number | null {
  const data = strokeData(borderStroke(shape));
  return data !== null ? data.width : null;
}

function borderSideWidth(shape: CssShape, index: number): { width: number } | null {
  const widths = strokePerSideWidths(borderStroke(shape));
  if (widths === null) return null;
  return { width: widths[index] };
}

function borderRadius(shape: CssShape): string | number[] | null {
  if (isCircle(shape)) return "50%";
  const rx = num(shape, "rx");
  if (rx !== null) return [rx];
  const r1 = num(shape, "r1");
  const r2 = num(shape, "r2");
  const r3 = num(shape, "r3");
  const r4 = num(shape, "r4");
  if (r1 !== null && r2 !== null && r3 !== null && r4 !== null) return [r1, r2, r3, r4];
  return null;
}

function background(shape: CssShape): InspectColor | null {
  if (isSvgMarkup(shape) || isGroup(shape)) return null;
  const fills = arr(shape, "fills");
  if (fills.length !== 1) return null;
  return fillColor(fills[0] as CssShape);
}

function gridCoord(
  shape: CssShape,
  objects: ViewerObjects,
  prop: "column" | "row",
  spanProp: "column-span" | "row-span",
): number | string | null {
  if (!isGridChild(objects, shape) || isPositionAbsolute(shape)) return null;
  const parent = parentOf(objects, shape);
  const cell = getCellByShapeId(parent, asShape(shape).id);
  if (cell === null) return null;
  const isArea = cell.position === "area" && (cell["area-name"] ?? "").length > 0;
  if (isArea) return null;
  const span = cell[spanProp] ?? 1;
  const start = cell[prop] ?? 0;
  if (cell.position !== "manual" && span <= 1) return null;
  return span > 1 ? start + " / " + (start + span) : start;
}

function selfAlign(
  shape: CssShape,
  objects: ViewerObjects,
  kind: "align" | "justify",
): string | null {
  if (isFlexChild(objects, shape)) {
    return kind === "align" ? str(shape, "layout-item-align-self") : null;
  }
  if (!isGridChild(objects, shape)) return null;
  const parent = parentOf(objects, shape);
  const cell = getCellByShapeId(parent, asShape(shape).id);
  const value = cell !== null ? cell[kind === "align" ? "align-self" : "justify-self"] : undefined;
  if (value !== undefined && value !== "auto") return value;
  const sizing =
    kind === "align" ? str(shape, "layout-item-v-sizing") : str(shape, "layout-item-h-sizing");
  return sizing === "fill" ? "stretch" : null;
}

// cssv/get-value: one property, with null for absent values.
export function getCssValue(
  property: string,
  shape: CssShape,
  objects: ViewerObjects,
  options: InspectCssOptions = {},
): unknown {
  switch (property) {
    // Positioning
    case "position": {
      if (isRootFrame(shape)) return "relative";
      if (isLayoutChild(objects, shape) && !isPositionAbsolute(shape)) {
        if (isGroupLike(shape) || isFrame(shape) || isSvgMarkup(shape)) return "relative";
        return null;
      }
      return "absolute";
    }
    case "left":
      return shapePosition(shape, objects, "x");
    case "top":
      return shapePosition(shape, objects, "y");
    case "z-index": {
      if (isRootFrame(shape)) return 0;
      if (isLayoutChild(objects, shape)) return num(shape, "layout-item-z-index");
      return null;
    }
    case "transform":
      return shapeTransform(shape, objects);

    // Size
    case "width": {
      const root = options.rootShapes?.has(asShape(shape).id) === true;
      if (root && isAnyLayout(shape)) return "fill";
      if (isText(shape) && str(shape, "grow-type") === "auto-width") return null;
      return shapeSize(shape, objects, "width");
    }
    case "height": {
      const root = options.rootShapes?.has(asShape(shape).id) === true;
      if (root && isAnyLayout(shape)) return null;
      if (isText(shape) && str(shape, "grow-type") === "auto-height") return null;
      return shapeSize(shape, objects, "height");
    }
    case "max-width":
    case "max-inline-size":
      return isLayoutChild(objects, shape) ? num(shape, "layout-item-max-w") : null;
    case "min-width":
    case "min-inline-size":
      if (isLayoutChild(objects, shape) && num(shape, "layout-item-min-w") !== null) {
        return num(shape, "layout-item-min-w");
      }
      if (str(shape, "layout-item-h-sizing") === "auto" && isFrame(shape) && asShape(shape)["show-content"] !== true) {
        return rectOf(shape)?.width ?? null;
      }
      return null;
    case "max-height":
    case "max-block-size":
      return isLayoutChild(objects, shape) ? num(shape, "layout-item-max-h") : null;
    case "min-height":
    case "min-block-size":
      if (isLayoutChild(objects, shape) && num(shape, "layout-item-min-h") !== null) {
        return num(shape, "layout-item-min-h");
      }
      if (str(shape, "layout-item-v-sizing") === "auto" && isFrame(shape) && asShape(shape)["show-content"] !== true) {
        return rectOf(shape)?.height ?? null;
      }
      return null;

    // Spacing
    case "margin": {
      if (!isLayoutChild(objects, shape) || isPositionAbsolute(shape)) return null;
      const margin = (asShape(shape)["layout-item-margin"] ?? {}) as Record<string, number | undefined>;
      const m1 = margin.m1 ?? 0;
      const m2 = margin.m2 ?? 0;
      const m3 = margin.m3 ?? 0;
      const m4 = margin.m4 ?? 0;
      if (m1 === 0 && m2 === 0 && m3 === 0 && m4 === 0) return null;
      return [m1, m2, m3, m4];
    }
    case "margin-block-start":
    case "margin-inline-end":
    case "margin-block-end":
    case "margin-inline-start": {
      if (!isLayoutChild(objects, shape) || isPositionAbsolute(shape)) return null;
      const margin = (asShape(shape)["layout-item-margin"] ?? {}) as Record<string, number | undefined>;
      const key = property.endsWith("block-start")
        ? "m1"
        : property.endsWith("inline-end")
          ? "m2"
          : property.endsWith("block-end")
            ? "m3"
            : "m4";
      const value = margin[key];
      return typeof value === "number" && value !== 0 ? [value] : null;
    }
    case "padding": {
      const padding = asShape(shape)["layout-padding"] as Record<string, number | undefined> | undefined;
      if (padding === undefined || padding === null) return null;
      const p1 = padding.p1 ?? 0;
      const p2 = padding.p2 ?? 0;
      const p3 = padding.p3 ?? 0;
      const p4 = padding.p4 ?? 0;
      if (p1 === 0 && p2 === 0 && p3 === 0 && p4 === 0) return null;
      return [p1, p2, p3, p4];
    }
    case "padding-block-start":
    case "padding-inline-end":
    case "padding-block-end":
    case "padding-inline-start": {
      const padding = asShape(shape)["layout-padding"] as Record<string, number | undefined> | undefined;
      const key = property.endsWith("block-start")
        ? "p1"
        : property.endsWith("inline-end")
          ? "p2"
          : property.endsWith("block-end")
            ? "p3"
            : "p4";
      const value = padding?.[key];
      return typeof value === "number" && value !== 0 ? [value] : null;
    }

    // Border & background
    case "border": {
      if (isSvgMarkup(shape)) return null;
      return strokeData(strokeSource(shape));
    }
    case "border-style": {
      if (isSvgMarkup(shape)) return null;
      return strokeData(strokeSource(shape));
    }
    case "border-width": {
      if (isSvgMarkup(shape)) return null;
      const width = borderWidthOfStroke(shape);
      return width !== null ? { width } : null;
    }
    case "border-color": {
      if (isSvgMarkup(shape)) return null;
      return strokeData(strokeSource(shape));
    }
    case "border-block-start-width":
      return borderSideWidth(shape, 0);
    case "border-inline-end-width":
      return borderSideWidth(shape, 1);
    case "border-block-end-width":
      return borderSideWidth(shape, 2);
    case "border-inline-start-width":
      return borderSideWidth(shape, 3);
    case "border-radius":
      return borderRadius(shape);
    case "background":
      return background(shape);

    // Visual effects
    case "opacity": {
      const value = num(shape, "opacity");
      return value !== null && value < 1 ? value : null;
    }
    case "box-shadow":
      return isSvgMarkup(shape) ? null : asShape(shape)["shadow"] ?? null;
    case "filter": {
      if (isSvgMarkup(shape)) return null;
      const blur = asShape(shape)["blur"] as { value?: unknown } | undefined;
      return blur?.value ?? null;
    }
    case "backdrop-filter": {
      if (isSvgMarkup(shape)) return null;
      const blur = asShape(shape)["background-blur"] as { value?: unknown } | undefined;
      return blur?.value ?? null;
    }
    case "overflow":
      return isFrame(shape) && !isSvgMarkup(shape) && asShape(shape)["show-content"] !== true
        ? "hidden"
        : null;

    // Display
    case "display": {
      if (asShape(shape)["hidden"] === true) return "none";
      if (isFlexLayout(shape)) return "flex";
      if (isGridLayout(shape)) return "grid";
      return null;
    }

    // Flexbox
    case "flex": {
      if (!isFlexChild(objects, shape)) return null;
      const dir = str(parentOf(objects, shape)!, "layout-flex-dir");
      const h = str(shape, "layout-item-h-sizing");
      const v = str(shape, "layout-item-v-sizing");
      if (((dir === "row" || dir === "row-reverse") && h === "fill") ||
          ((dir === "column" || dir === "column-reverse") && v === "fill")) {
        return 1;
      }
      return null;
    }
    case "flex-grow": {
      const root = options.rootShapes?.has(asShape(shape).id) === true;
      return root && isAnyLayout(shape) ? 1 : null;
    }
    case "flex-shrink": {
      if (!isFlexChild(objects, shape)) return null;
      const h = str(shape, "layout-item-h-sizing");
      const v = str(shape, "layout-item-v-sizing");
      if (h === "auto" || v === "auto") return null;
      return 0;
    }
    case "flex-direction":
      return str(shape, "layout-flex-dir");
    case "flex-wrap":
      return str(shape, "layout-wrap-type");
    case "align-items":
      return str(shape, "layout-align-items");
    case "align-content":
      return str(shape, "layout-align-content");
    case "align-self":
      return selfAlign(shape, objects, "align");
    case "justify-content":
      return str(shape, "layout-justify-content");
    case "justify-items":
      return str(shape, "layout-justify-items");
    case "justify-self":
      return selfAlign(shape, objects, "justify");

    // Grid
    case "grid-template-rows":
      return asShape(shape)["layout-grid-rows"] ?? null;
    case "grid-template-columns":
      return asShape(shape)["layout-grid-columns"] ?? null;
    case "grid-column":
      return gridCoord(shape, objects, "column", "column-span");
    case "grid-row":
      return gridCoord(shape, objects, "row", "row-span");
    case "grid-auto-flow":
      return isGridLayout(shape) && str(shape, "layout-grid-dir") === "column" ? "column" : null;

    // Gap
    case "gap": {
      const [row, column] = gapsOf(shape);
      return row === column && (row !== 0 || column !== 0) ? [row] : null;
    }
    case "row-gap": {
      const [row, column] = gapsOf(shape);
      return row !== column && row !== 0 ? [row] : null;
    }
    case "column-gap": {
      const [row, column] = gapsOf(shape);
      return row !== column && column !== 0 ? [column] : null;
    }

    // Blend mode: the one property whose value comes from a keyword.
    case "blend-mode":
      return str(shape, "blend-mode");

    default: {
      const value = asShape(shape)[property];
      return value === undefined ? null : value;
    }
  }
}

// --- Formatting -------------------------------------------------------------

type FormatterKind =
  | "position"
  | "size"
  | "color"
  | "border"
  | "border-style"
  | "border-width"
  | "border-color"
  | "size-array"
  | "string-or-size-array"
  | "tracks"
  | "shadows"
  | "blur"
  | "default";

const FORMATTERS: Record<string, FormatterKind> = {
  left: "position",
  top: "position",
  width: "size",
  height: "size",
  "max-height": "size",
  "max-block-size": "size",
  "min-height": "size",
  "min-block-size": "size",
  "max-width": "size",
  "max-inline-size": "size",
  "min-width": "size",
  "min-inline-size": "size",
  background: "color",
  border: "border",
  "border-radius": "string-or-size-array",
  "border-width": "border-width",
  "border-block-start-width": "border-width",
  "border-inline-end-width": "border-width",
  "border-block-end-width": "border-width",
  "border-inline-start-width": "border-width",
  "border-style": "border-style",
  "border-color": "border-color",
  "box-shadow": "shadows",
  filter: "blur",
  "backdrop-filter": "blur",
  gap: "size-array",
  "row-gap": "size-array",
  "column-gap": "size-array",
  padding: "size-array",
  "padding-inline-start": "size-array",
  "padding-inline-end": "size-array",
  "padding-block-start": "size-array",
  "padding-block-end": "size-array",
  margin: "size-array",
  "margin-block-start": "size-array",
  "margin-inline-end": "size-array",
  "margin-block-end": "size-array",
  "margin-inline-start": "size-array",
  "grid-template-rows": "tracks",
  "grid-template-columns": "tracks",
};

// fmt/format-blur: blur(Npx).
export function formatBlur(value: unknown): string {
  return "blur(" + formatPixels(value as number) + ")";
}

// fmt/format-shadow->css: [inset] offset-x offset-y blur spread color.
export function shadowToCss(shadow: unknown, options: InspectCssOptions = {}): string {
  const data = (shadow ?? {}) as {
    style?: string;
    "offset-x"?: number;
    "offset-y"?: number;
    blur?: number;
    spread?: number;
    color?: InspectColor;
  };
  const inset = data.style === "inner-shadow" ? "inset " : "";
  const parts = [
    String(data["offset-x"] ?? 0),
    String(data["offset-y"] ?? 0),
    String(data.blur ?? 0),
    String(data.spread ?? 0),
  ];
  return inset + parts.map((part) => part + "px").join(" ") + " " + formatColorValue(data.color ?? {}, options);
}

// style_css/shadow->css: the rule the shadow copy button writes.
export function shadowRule(shadow: unknown, options: InspectCssOptions = {}): string {
  return "box-shadow: " + shadowToCss(shadow, options) + ";";
}

function formatTracks(value: unknown): string {
  if (!Array.isArray(value)) return String(value ?? "");
  return value
    .map((track) => {
      const data = (track ?? {}) as { type?: string; value?: number };
      if (data.type === "flex") return formatNumber(data.value ?? 0) + "fr";
      if (data.type === "percent") return formatPercent((data.value ?? 0) / 100);
      if (data.type === "auto") return "auto";
      return formatPixels(data.value ?? 0);
    })
    .join(" ");
}

function formatSizeArray(value: unknown): unknown {
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.map((item) => formatPixels(item as number)).join(" ");
  }
  return value ?? null;
}

// style_css_formats/format-value.
export function formatCssValue(
  property: string,
  value: unknown,
  options: InspectCssOptions = {},
): string | null {
  if (value === null || value === undefined) return null;
  const kind = FORMATTERS[property] ?? "default";
  switch (kind) {
    case "position":
      return typeof value === "number" ? formatPixels(value) : String(value);
    case "size":
      if (value === "fill") return "100%";
      if (value === "auto") return "auto";
      return typeof value === "number" ? formatPixels(value) : String(value);
    case "color":
      return formatColorValue(value as InspectColor, options);
    case "border": {
      const data = value as unknown as StrokeData;
      return (
        formatPixels(data.width) +
        " " +
        data.style +
        " " +
        formatColorValue(data.color, options)
      );
    }
    case "border-style":
      return (value as unknown as StrokeData).style;
    case "border-width":
      return formatPixels((value as unknown as { width: number }).width);
    case "border-color":
      return formatColorValue((value as unknown as StrokeData).color, options);
    case "size-array":
    case "string-or-size-array": {
      if (kind === "string-or-size-array" && typeof value === "string") return value;
      const formatted = formatSizeArray(value);
      return formatted === null ? null : String(formatted);
    }
    case "tracks":
      return formatTracks(value);
    case "shadows": {
      if (!Array.isArray(value)) return null;
      return value.map((shadow) => shadowToCss(shadow, options)).join(", ");
    }
    case "blur":
      return formatBlur(value);
    default:
      return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : null;
  }
}

// cmm/get-css-rule-humanized: "border-block-start-width" -> "Border block
// start width".
export function humanizeCssRule(property: string): string {
  const text = property.split("-").join(" ");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

// style_css/get-css-value: the formatted value of a property.
export function cssValue(
  property: string,
  shape: CssShape,
  objects: ViewerObjects,
  options: InspectCssOptions = {},
): string | null {
  const value = getCssValue(property, shape, objects, options);
  if (value === null || value === undefined) return null;
  return formatCssValue(property, value, options);
}

// style_css/get-css-property: "property: value;", with blend-mode renamed.
export function cssProperty(
  property: string,
  shape: CssShape,
  objects: ViewerObjects,
  options: InspectCssOptions = {},
): string | null {
  const value = getCssValue(property, shape, objects, options);
  if (value === null || value === undefined) return null;
  const formatted = formatCssValue(property, value, options);
  const name = property === "blend-mode" ? "mix-blend-mode" : property;
  return name + ": " + (formatted ?? "") + ";";
}

// style_css/get-shape-properties-css: one indented rule per property, joined
// with newlines.
export function shapePropertiesCss(
  shape: CssShape,
  objects: ViewerObjects,
  properties: readonly string[],
  options: InspectCssOptions = {},
): string {
  const lines: string[] = [];
  for (const property of properties) {
    const rule = cssProperty(property, shape, objects, options);
    if (rule !== null) lines.push("  " + rule);
  }
  return lines.join("\n");
}
