// app.common.render-wasm.svg-derived, Node side.
//
// Derives native fills, layer blur and drop shadows from a shape's SVG
// attributes and defs, so the exporter renders the same pixels as the
// workspace without a browser SVG parser. The SVG attributes stay untouched:
// the SVG fallback renderer keeps reading them.
//
// Mirrors `common/src/app/common/render_wasm/svg_derived.cljs`.

import { black, colorString, parse as parseColor, rgbToHex } from "../color.js";
import { parseDouble } from "../data.js";
import {
  distance,
  makeRect,
  point,
  transform,
  type Matrix,
  type Point,
  type Rect,
} from "../geom.js";
import { extractIds, parseStyle, parseTransform } from "../svg.js";
import { next as nextId } from "../uuid.js";
import type { Fill, FillGradient, GradientStop } from "./fills.js";
import type { Blur, Shadow, Shape, SvgNode } from "./upload.js";

const URL_FILL_RE = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/;
const MATRIX_VALUE_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

interface GradientNode {
  tag: string | undefined;
  attrs: Record<string, unknown>;
  content: readonly SvgNode[];
}

// `dm/get-prop` on a shape: keywords arrive as plain string keys.
function tagName(tag: unknown): string | undefined {
  if (typeof tag !== "string") return undefined;
  return tag.startsWith(":") ? tag.slice(1) : tag;
}

function trimFillValue(value: unknown): string | undefined {
  let text: string | undefined;
  if (typeof value === "string") text = value;
  else if (typeof value === "number") text = String(value);
  else if (value !== undefined && value !== null) text = String(value);
  if (text === undefined) return undefined;
  const trimmed = text.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// "50%", "12px" and "12" all become plain numbers; a percentage is scaled to
// 0..1.
function parseLength(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "number") return value;
  const text = trimFillValue(value);
  if (text === undefined) return undefined;
  const percent = text.endsWith("%");
  const px = text.endsWith("px");
  const numeric = percent ? text.slice(0, -1) : px ? text.slice(0, -2) : text;
  const parsed = parseDouble(numeric);
  if (parsed === undefined) return undefined;
  return percent ? parsed / 100.0 : parsed;
}

function parseOffset(value: unknown): number {
  const length = parseLength(value ?? 0);
  return Math.min(Math.max(length ?? 0, 0), 1);
}

function parseOpacity(value: unknown): number {
  return parseLength(value) ?? 1;
}

function shapeSelrect(shape: Shape): Rect {
  const selrect = shape.selrect;
  if (selrect !== undefined && selrect !== null) return makeRect(selrect);
  return makeRect({
    x: shape.x ?? 0,
    y: shape.y ?? 0,
    width: shape.width ?? 1,
    height: shape.height ?? 1,
  });
}

// `gpt/transform`, but also accepting a transform string.
function applySvgTransform(pt: Point, svgTransform: unknown): Point {
  if (svgTransform === undefined || svgTransform === null) return pt;
  const matrix =
    typeof svgTransform === "string" ? parseTransform(svgTransform) : (svgTransform as Matrix);
  return transform(pt, matrix);
}

// Transforms a point from viewBox space to selrect space.
function applyViewboxTransform(pt: Point, viewbox: Shape["svg-viewbox"], rect: Rect): Point {
  if (viewbox === undefined || viewbox === null) return pt;
  const svgX = viewbox.x ?? 0;
  const svgY = viewbox.y ?? 0;
  const scaleX = Math.max(0.01, rect.width) / (viewbox.width ?? 0);
  const scaleY = Math.max(0.01, rect.height) / (viewbox.height ?? 0);
  return point(rect.x + (pt.x - svgX) * scaleX, rect.y + (pt.y - svgY) * scaleY);
}

// userSpaceOnUse coordinates are in SVG user space, so move them to shape
// space before normalizing.
function normalizePoint(pt: Point, units: string, shape: Shape): Point {
  if (units !== "userspaceonuse") return pt;
  const rect = shapeSelrect(shape);
  const width = Math.max(0.01, rect.width);
  const height = Math.max(0.01, rect.height);
  const transformed = applyViewboxTransform(
    applySvgTransform(pt, shape["svg-transform"]),
    shape["svg-viewbox"],
    rect,
  );
  return point((transformed.x - rect.x) / width, (transformed.y - rect.y) / height);
}

// Attribute names differ in case and hyphenation between the SVG parser and
// hand-written data, so compare them lowercased.
function normalizeAttrs(attrs: Record<string, unknown> | undefined): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs ?? {})) {
    normalized[key.toLowerCase()] = value;
  }
  return normalized;
}

function idCandidates(id: string): string[] {
  const kebab = id.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return [...new Set([id, id.toLowerCase(), kebab])];
}

function svgDefById(defs: Record<string, SvgNode>, id: string): SvgNode | undefined {
  for (const candidate of idCandidates(id)) {
    const node = defs[candidate];
    if (node !== undefined) return node;
  }
  return undefined;
}

function normalizeGradientId(value: unknown): string | undefined {
  const clean = trimFillValue(value);
  if (clean === undefined) return undefined;
  const without = clean.replace(/^#/, "");
  return without.length > 0 ? without : undefined;
}

function attr(attrs: Record<string, unknown>, ...keys: string[]): unknown {
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// Follows xlink:href chains and merges the attributes from the ancestor down,
// so a gradient that inherits its stops from another one still resolves.
function resolveGradientNode(shape: Shape, gradientId: string): GradientNode | undefined {
  const defs = shape["svg-defs"];
  if (defs === undefined || defs === null) return undefined;

  const chain: GradientNode[] = [];
  const seen = new Set<string>();
  let current: string | undefined = gradientId;
  while (current !== undefined) {
    const normalized = normalizeGradientId(current);
    if (normalized === undefined || seen.has(normalized)) break;
    const node = svgDefById(defs, normalized);
    if (node === undefined) break;
    const attrs = normalizeAttrs(node.attrs);
    const href =
      attrs["xlinkhref"] ?? attrs["xlink-href"] ?? attrs["xlink:href"] ?? attrs["href"];
    chain.push({
      tag: tagName(node.tag),
      attrs,
      content: node.content ?? [],
    });
    seen.add(normalized);
    current = typeof href === "string" ? href : undefined;
  }

  if (chain.length === 0) return undefined;

  let combined: GradientNode = { tag: undefined, attrs: {}, content: [] };
  for (const node of [...chain].reverse()) {
    combined = {
      tag: node.tag ?? combined.tag,
      attrs: { ...combined.attrs, ...node.attrs },
      content: node.content.length > 0 ? node.content : combined.content,
    };
  }

  if (combined.tag !== "linearGradient" && combined.tag !== "radialGradient") return undefined;
  return combined;
}

function parseGradientStop(node: SvgNode): GradientStop | undefined {
  const attrs = normalizeAttrs(node.attrs);
  const styleValue = attrs["style"];
  const style =
    typeof styleValue === "string"
      ? parseStyle(styleValue)
      : (styleValue as Record<string, string> | undefined);
  const rawColor =
    attr(attrs, "stop-color", "stopcolor") ?? style?.["stop-color"] ?? style?.["stopColor"];
  let color = trimFillValue(rawColor);
  if (color === "currentcolor") color = black;
  if (color === undefined || !colorString(color)) return undefined;

  const rawOpacity =
    attr(attrs, "stop-opacity", "stopopacity") ?? style?.["stop-opacity"] ?? style?.["stopOpacity"];
  const parsedColor = parseColor(color);
  if (parsedColor === undefined) return undefined;

  const stop: GradientStop = { color: parsedColor, offset: parseOffset(attrs["offset"] ?? "0") };
  if (rawOpacity !== undefined && rawOpacity !== null) stop.opacity = parseOpacity(rawOpacity);
  return stop;
}

function gradientStops(content: readonly SvgNode[]): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const node of content) {
    if (tagName(node.tag) !== "stop") continue;
    const stop = parseGradientStop(node);
    if (stop !== undefined) stops.push(stop);
  }
  return stops;
}

function applyGradientTransform(points: Point[], transformValue: unknown): Point[] {
  if (transformValue === undefined || transformValue === null) return points;
  const matrix = parseTransform(transformValue);
  return points.map((pt) => transform(pt, matrix));
}

function buildLinearGradient(shape: Shape, node: GradientNode): FillGradient | undefined {
  const units = String(attr(node.attrs, "gradientunits", "gradient-units") ?? "objectBoundingBox").toLowerCase();
  const stops = gradientStops(node.content);
  if (stops.length === 0) return undefined;

  const x1 = parseLength(node.attrs["x1"] ?? node.attrs["x"]) ?? 0.0;
  const y1 = parseLength(node.attrs["y1"] ?? node.attrs["y"]) ?? 0.0;
  const x2 = parseLength(node.attrs["x2"] ?? node.attrs["x"]) ?? 1.0;
  const y2 = parseLength(node.attrs["y2"] ?? node.attrs["y"]) ?? 0.0;

  const points = applyGradientTransform(
    [point(x1, y1), point(x2, y2)],
    attr(node.attrs, "gradienttransform", "gradient-transform"),
  ).map((pt) => normalizePoint(pt, units, shape));
  const [start, end] = points;

  return {
    type: "linear",
    "start-x": start.x,
    "start-y": start.y,
    "end-x": end.x,
    "end-y": end.y,
    width: 1,
    stops,
  };
}

function buildRadialGradient(shape: Shape, node: GradientNode): FillGradient | undefined {
  const units = String(attr(node.attrs, "gradientunits", "gradient-units") ?? "objectBoundingBox").toLowerCase();
  const stops = gradientStops(node.content);
  if (stops.length === 0) return undefined;

  const cx = parseLength(node.attrs["cx"] ?? node.attrs["fx"]) ?? 0.5;
  const cy = parseLength(node.attrs["cy"] ?? node.attrs["fy"]) ?? 0.5;
  const r = parseLength(node.attrs["r"]) ?? 0.5;

  const [center, pointX, pointY] = applyGradientTransform(
    [point(cx, cy), point(cx + r, cy), point(cx, cy + r)],
    attr(node.attrs, "gradienttransform", "gradient-transform"),
  ).map((pt) => normalizePoint(pt, units, shape));

  const radiusX = distance(center, pointX);
  const radiusY = distance(center, pointY);
  // Prefer Y as the base radius so width becomes the X/Y ratio.
  const baseRadius = radiusY > 0 ? radiusY : radiusX;
  const radiusPoint = radiusY > 0 ? pointY : pointX;
  const width = radiusX / Math.max(baseRadius, 1.0e-6);

  return {
    type: "radial",
    "start-x": center.x,
    "start-y": center.y,
    "end-x": radiusPoint.x,
    "end-y": radiusPoint.y,
    width,
    stops,
  };
}

function svgGradientToFill(shape: Shape, value: unknown): FillGradient | undefined {
  const fill = trimFillValue(value);
  if (fill === undefined) return undefined;
  const match = URL_FILL_RE.exec(fill);
  if (match === null) return undefined;
  const node = resolveGradientNode(shape, match[1]);
  if (node === undefined) return undefined;
  if (node.tag === "linearGradient") return buildLinearGradient(shape, node);
  if (node.tag === "radialGradient") return buildRadialGradient(shape, node);
  return undefined;
}

type ParsedFill = { type: "color"; value: string } | { type: "gradient"; value: FillGradient };

function parseSvgFill(shape: Shape, value: unknown): ParsedFill | undefined {
  const trimmed = trimFillValue(value);
  if (trimmed === undefined) return undefined;
  const normalized = trimmed.toLowerCase() === "currentcolor" ? black : trimmed;

  if (normalized === "none") return undefined;

  if (colorString(normalized)) {
    const color = parseColor(normalized);
    return color === undefined ? undefined : { type: "color", value: color };
  }

  if (normalized.startsWith("url(")) {
    const gradient = svgGradientToFill(shape, normalized);
    return gradient === undefined ? undefined : { type: "gradient", value: gradient };
  }

  return undefined;
}

function svgFillOpacity(shape: Shape): number | undefined {
  const attrs = shape["svg-attrs"];
  const fromStyle = attrs?.style?.fillOpacity;
  if (fromStyle !== undefined && fromStyle !== null) return parseDouble(fromStyle, 1);
  const fromAttrs = attrs?.fillOpacity;
  if (fromAttrs !== undefined && fromAttrs !== null) return parseDouble(fromAttrs, 1);
  return undefined;
}

// One fill derived from the shape SVG attrs/defs, or nil when there is none.
export function svgFillToFills(shape: Shape): Fill[] | undefined {
  const attrs = shape["svg-attrs"];
  const parsed = parseSvgFill(shape, attrs?.style?.fill) ?? parseSvgFill(shape, attrs?.fill);
  if (parsed === undefined) return undefined;

  const opacity = svgFillOpacity(shape);
  const fill: Fill =
    parsed.type === "color"
      ? { "fill-color": parsed.value }
      : { "fill-color-gradient": parsed.value };
  if (opacity !== undefined) fill["fill-opacity"] = opacity;
  return [fill];
}

// Existing fills win; otherwise derive from SVG; SVG raw and group shapes with
// svg-attrs fall back to the SVG default black.
export function resolveShapeFills(shape: Shape): readonly Fill[] {
  const base = shape.fills;
  if (base !== undefined && base !== null && base.length > 0) return base;

  const fallback = svgFillToFills(shape);
  if (fallback !== undefined && fallback.length > 0) return fallback;

  if (shape["svg-attrs"] !== undefined && (shape.type === "svg-raw" || shape.type === "group")) {
    return [{ "fill-color": black, "fill-opacity": 1 }];
  }
  return [];
}

function findFilterElement(content: readonly SvgNode[], tag: string): SvgNode | undefined {
  return content.find((node) => tagName(node.tag) === tag);
}

function findFilterDef(shape: Shape): SvgNode | undefined {
  const attrs = shape["svg-attrs"];
  const filterAttr = attrs?.filter ?? attrs?.style?.filter;
  const defs = shape["svg-defs"];
  if (filterAttr === undefined || filterAttr === null || defs === undefined) return undefined;
  for (const id of extractIds(filterAttr)) {
    const node = defs[id];
    if (node !== undefined) return node;
  }
  return undefined;
}

function buildBlur(gaussianBlur: SvgNode | undefined): Blur | undefined {
  if (gaussianBlur === undefined) return undefined;
  return {
    id: nextId(),
    type: "layer-blur",
    // For layer blur the value matches stdDeviation directly.
    value: parseDouble(gaussianBlur.attrs?.["stdDeviation"], 0) ?? 0,
    hidden: false,
  };
}

// Attr of a filter primitive, whatever its case or hyphenation.
function filterAttr(elem: SvgNode | undefined, ...keys: string[]): unknown {
  if (elem === undefined) return undefined;
  return attr(normalizeAttrs(elem.attrs), ...keys);
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

// The 20 values of an feColorMatrix of type matrix, else nil.
function matrixValues(elem: SvgNode): number[] | undefined {
  const type = filterAttr(elem, "type");
  if (type !== undefined && type !== null && type !== "matrix") return undefined;
  const values = filterAttr(elem, "values");
  if (typeof values !== "string") return undefined;
  const numbers = [...values.matchAll(MATRIX_VALUE_RE)].map((match) => parseDouble(match[0], 0) ?? 0);
  return numbers.length === 20 ? numbers : undefined;
}

// The input is SourceAlpha, so only the constant RGB terms and alpha row count.
function matrixToShadowColor(values: readonly number[]): { color: string; opacity: number } {
  const channel = (index: number) => Math.round(255 * clampUnit(values[index]));
  return {
    color: rgbToHex([channel(4), channel(9), channel(14)]),
    opacity: clampUnit(values[18] + values[19]),
  };
}

function floodToShadowColor(elem: SvgNode): { color: string; opacity: number } {
  const rawColor = trimFillValue(filterAttr(elem, "flood-color", "floodcolor"));
  const rawOpacity = filterAttr(elem, "flood-opacity", "floodopacity");
  const color = rawColor !== undefined && colorString(rawColor) ? (parseColor(rawColor) ?? black) : black;
  return {
    color,
    opacity: rawOpacity !== undefined && rawOpacity !== null ? clampUnit(parseOpacity(rawOpacity)) : 1,
  };
}

// Last color matrix or flood after the feOffset; earlier ones shape the
// silhouette.
function shadowColor(content: readonly SvgNode[]): { color: string; opacity: number } | undefined {
  const start = content.findIndex((node) => tagName(node.tag) === "feOffset");
  if (start < 0) return undefined;
  const source = content
    .slice(start)
    .filter((node) => {
      const tag = tagName(node.tag);
      return tag === "feColorMatrix" || tag === "feFlood";
    })
    .at(-1);
  if (source === undefined) return undefined;

  if (tagName(source.tag) === "feFlood") return floodToShadowColor(source);
  const values = matrixValues(source);
  return values === undefined ? undefined : matrixToShadowColor(values);
}

function dropShadow(
  dx: number,
  dy: number,
  stdDeviation: number,
  color: { color: string; opacity: number },
): Shadow[] {
  return [
    {
      id: nextId(),
      style: "drop-shadow",
      "offset-x": dx,
      "offset-y": dy,
      blur: stdDeviation * 2,
      spread: 0,
      hidden: false,
      color,
    },
  ];
}

function buildDropShadow(content: readonly SvgNode[]): Shadow[] | undefined {
  const offsetElem = findFilterElement(content, "feOffset");
  if (offsetElem === undefined) return undefined;
  const blurElem = findFilterElement(content, "feGaussianBlur");
  return dropShadow(
    parseDouble(filterAttr(offsetElem, "dx"), 0) ?? 0,
    parseDouble(filterAttr(offsetElem, "dy"), 0) ?? 0,
    parseDouble(filterAttr(blurElem, "stddeviation"), 0) ?? 0,
    shadowColor(content) ?? { color: black, opacity: 1 },
  );
}

// dx, dy and stdDeviation default to 2.
function buildFeDropShadow(elem: SvgNode): Shadow[] {
  return dropShadow(
    parseDouble(filterAttr(elem, "dx"), 2) ?? 2,
    parseDouble(filterAttr(elem, "dy"), 2) ?? 2,
    parseDouble(filterAttr(elem, "stddeviation"), 2) ?? 2,
    floodToShadowColor(elem),
  );
}

// Derives native blur/shadow from SVG filter definitions when the shape does
// not already have them. The SVG attributes are left untouched so SVG fallback
// rendering keeps working the same way as gradient fills.
export function applySvgFilters(shape: Shape): Shape {
  const filterDef = findFilterDef(shape);
  if (filterDef === undefined) return shape;

  const content = filterDef.content ?? [];
  const feDropShadow = findFilterElement(content, "feDropShadow");
  // In a shadow chain the blur belongs to the shadow, not the shape.
  const shadowChain = feDropShadow !== undefined || findFilterElement(content, "feOffset") !== undefined;
  const gaussianBlur = shadowChain ? undefined : findFilterElement(content, "feGaussianBlur");

  const existingBlur = shape.blur;
  const existingShadow = shape.shadow ?? undefined;
  const blur = existingBlur ?? buildBlur(gaussianBlur);
  const shadow =
    existingShadow !== undefined && existingShadow.length > 0
      ? existingShadow
      : feDropShadow !== undefined
        ? buildFeDropShadow(feDropShadow)
        : buildDropShadow(content);

  const derived: Shape = { ...shape };
  if (blur !== undefined && blur !== null) derived.blur = blur;
  if (shadow !== undefined && shadow.length > 0) derived.shadow = shadow;
  return derived;
}

// Applies SVG-derived effects (fills, blur, shadows) uniformly.
// - Keeps user fills if present; otherwise derives from SVG.
// - Converts SVG filters into native blur/shadow when needed.
// - Always returns the shape with `fills` and the `blur`/`shadow` keys.
export function applySvgDerived(shape: Shape): Shape {
  const derived = applySvgFilters(shape);
  return {
    ...derived,
    fills: resolveShapeFills(derived),
    blur: derived.blur ?? null,
    shadow: derived.shadow ?? null,
  };
}