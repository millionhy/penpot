// The SVG-derived attrs of app.common.render-wasm.svg-derived: the fills,
// the blur and the shadows a shape inherits from its source SVG when the
// model carries no native ones.
//
// The derivation order matters and is kept: the filter half runs first, then
// the fills resolve against the shape it returns. Both halves only read the
// model — no renderer call — and the shape is a plain object, so the result
// is a copy with `fills`, `blur` and `shadow` always present.
//
// The compiled code takes SVG attributes as keywords; here they are plain
// object keys with the source names, and the node tags are strings.

import type { Fill, FillGradient, GradientStop } from "./fills";
import { parseDouble } from "./numbers";
import {
  BLACK,
  extractIds,
  isColorString,
  parseColor,
  parseStyle,
  parseTransform,
  rgbToHex,
  transformPoint,
  type Matrix6,
  type Point,
} from "./svg";
import { nextUuid } from "./uuid";
import type { ShapeSvgAttrs } from "./props";
import type { Blur, Shadow, SvgNode, SvgViewBox, Transform } from "./upload";

// A fresh renderer id for the derived effect records.
export type IdFactory = () => string;

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface RectInput {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}

interface ShadowColor {
  color: string;
  opacity?: number;
}

// The subset of a shape the derivation reads.
export interface SvgDerivedShape {
  type?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  selrect?: RectInput | null;
  fills?: readonly Fill[] | null;
  blur?: Blur | null;
  shadow?: readonly Shadow[] | null;
  "svg-attrs"?: ShapeSvgAttrs | null;
  "svg-defs"?: Record<string, SvgNode> | null;
  "svg-viewbox"?: SvgViewBox | null;
  "svg-transform"?: Transform | string | null;
}

// The derived shape: the input plus the three keys the upload consumes.
export interface SvgDerivedResult extends SvgDerivedShape {
  fills: readonly Fill[];
  blur?: Blur;
  shadow?: readonly Shadow[];
}

const MIN_SIZE = 0.01;

// svg-fill->fills understands `url(#id)` in full, quoting included.
const URL_FILL_RE = /^url\(\s*['"]?#([^)'"]+)['"]?\s*\)$/;

// The number tokens of an feColorMatrix values attribute.
const MATRIX_VALUE_RE = /[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/g;

function trimFillValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  const text = typeof value === "string" ? value : String(value);
  const trimmed = text.trim();
  return trimmed === "" ? undefined : trimmed;
}

function parseLength(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "number") return value;

  const text = trimFillValue(value);
  if (text === undefined) return undefined;

  const percent = text.endsWith("%");
  const px = text.endsWith("px");
  const numeric = percent ? text.slice(0, -1) : px ? text.slice(0, -2) : text;
  const parsed = parseDouble(numeric);
  if (parsed === undefined) return undefined;
  return percent ? parsed / 100 : parsed;
}

function parseOffset(value: unknown): number {
  const length = parseLength(value ?? 0) ?? 0;
  return Math.min(Math.max(length, 0), 1);
}

function parseOpacity(value: unknown): number {
  return parseLength(value) ?? 1;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" ? value : fallback;
}

// grc/make-rect: the nil fields take the rect defaults.
function makeRect(data: RectInput = {}): Rect {
  return {
    x: numberOr(data.x, 0),
    y: numberOr(data.y, 0),
    width: numberOr(data.width, MIN_SIZE),
    height: numberOr(data.height, MIN_SIZE),
  };
}

function shapeSelrect(shape: SvgDerivedShape): Rect {
  const selrect = shape.selrect;
  if (selrect !== null && typeof selrect === "object") return makeRect(selrect);

  return makeRect({
    x: shape.x ?? 0,
    y: shape.y ?? 0,
    width: Math.max(MIN_SIZE, shape.width ?? 1),
    height: Math.max(MIN_SIZE, shape.height ?? 1),
  });
}

function transformMatrix(transform: Transform): Matrix6 {
  return [
    numberOr(transform.a, 1),
    numberOr(transform.b, 0),
    numberOr(transform.c, 0),
    numberOr(transform.d, 1),
    numberOr(transform.e, 0),
    numberOr(transform.f, 0),
  ];
}

// A shape carries its SVG transform as the model matrix, not as the text form.
function applySvgTransform(
  point: Point,
  transform: Transform | string | null | undefined,
): Point {
  if (transform === null || transform === undefined) return point;
  const matrix = typeof transform === "string" ? parseTransform(transform) : transformMatrix(transform);
  return transformPoint(point, matrix);
}

// From viewBox space to selrect space.
function applyViewboxTransform(
  point: Point,
  viewbox: SvgViewBox | null | undefined,
  rect: Rect,
): Point {
  if (viewbox === null || viewbox === undefined) return point;

  const width = Math.max(MIN_SIZE, rect.width);
  const height = Math.max(MIN_SIZE, rect.height);
  const svgWidth = viewbox.width ?? 0;
  const svgHeight = viewbox.height ?? 0;

  return {
    x: rect.x + (point.x - (viewbox.x ?? 0)) * (width / svgWidth),
    y: rect.y + (point.y - (viewbox.y ?? 0)) * (height / svgHeight),
  };
}

// userSpaceOnUse coordinates are in the source SVG; everything else is
// already normalized to the shape box.
function normalizePoint(pt: Point, units: string, shape: SvgDerivedShape): Point {
  if (units !== "userspaceonuse") return pt;

  const rect = shapeSelrect(shape);
  const width = Math.max(MIN_SIZE, rect.width);
  const height = Math.max(MIN_SIZE, rect.height);
  const afterSvgTransform = applySvgTransform(pt, shape["svg-transform"]);
  const transformed = applyViewboxTransform(afterSvgTransform, shape["svg-viewbox"], rect);

  return {
    x: (transformed.x - rect.x) / width,
    y: (transformed.y - rect.y) / height,
  };
}

// --- defs and gradients ----------------------------------------------------

function normalizeAttrs(
  attrs: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(attrs ?? {})) {
    result[key.toLowerCase()] = value;
  }
  return result;
}

// Returns the first present value for the provided attribute keys.
function attr(
  attrs: Record<string, unknown> | null | undefined,
  ...keys: string[]
): unknown {
  if (attrs === null || attrs === undefined) return undefined;
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

// The node tags come from the SVG parser as their source names.
function tagName(node: SvgNode | null | undefined): string | undefined {
  const tag = node?.tag;
  if (typeof tag !== "string") return undefined;
  return tag.startsWith(":") ? tag.slice(1) : tag;
}

// svg-def-by-id tries the id as written, lower-cased and kebab-cased.
function idCandidates(id: unknown): string[] {
  if (id === null || id === undefined) return [];

  const base = typeof id === "string" ? id : String(id);
  const lower = base.toLowerCase();
  const kebab = base.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return [...new Set([base, lower, kebab])].filter((value) => value.trim() !== "");
}

function svgDefById(defs: Record<string, SvgNode>, id: unknown): SvgNode | undefined {
  for (const candidate of idCandidates(id)) {
    const node = defs[candidate];
    if (node !== undefined) return node;
  }
  return undefined;
}

function normalizeGradientId(value: unknown): string | undefined {
  const clean = trimFillValue(value);
  if (clean === undefined) return undefined;
  const withoutHash = clean.replace(/^#/, "");
  return withoutHash === "" ? undefined : withoutHash;
}

interface ResolvedNode {
  tag?: string;
  attrs: Record<string, unknown>;
  content: readonly SvgNode[];
}

// resolve-gradient-node: follows xlink:href/href to the real gradient and
// merges the chain, the referenced node first. Returns nothing unless the
// result is a gradient, so a filter def with the same id stays out.
function resolveGradientNode(
  shape: SvgDerivedShape,
  gradientId: unknown,
): ResolvedNode | undefined {
  const defs = shape["svg-defs"];
  if (defs === null || defs === undefined || gradientId === null || gradientId === undefined) {
    return undefined;
  }

  const chain: ResolvedNode[] = [];
  const seen = new Set<string>();
  let current: unknown = gradientId;

  while (true) {
    const normalized = normalizeGradientId(current);
    if (normalized === undefined || seen.has(normalized)) break;

    const node = svgDefById(defs, normalized);
    if (node === undefined) break;

    const attrs = normalizeAttrs(node.attrs);
    const href = attr(attrs, "xlinkhref", "xlink-href", "xlink:href", "href");
    chain.push({ tag: node.tag, attrs, content: node.content ?? [] });
    seen.add(normalized);
    current = href;
  }

  if (chain.length === 0) return undefined;

  let combined: ResolvedNode = { tag: undefined, attrs: {}, content: [] };
  for (const node of [...chain].reverse()) {
    combined = {
      tag: node.tag ?? combined.tag,
      attrs: { ...combined.attrs, ...node.attrs },
      content: node.content.length > 0 ? node.content : combined.content,
    };
  }

  const tag = tagName({ tag: combined.tag });
  if (tag !== "linearGradient" && tag !== "radialGradient") return undefined;
  return { ...combined, tag };
}

function parseGradientStop(node: SvgNode): GradientStop | undefined {
  const attrs = normalizeAttrs(node.attrs);
  const styleText = attrs["style"];
  const style = typeof styleText === "string" ? parseStyle(styleText) : undefined;

  let colorValue = trimFillValue(
    attr(attrs, "stop-color", "stopcolor") ??
      style?.["stop-color"] ??
      style?.["stopColor"],
  );
  if (colorValue === "currentcolor") colorValue = BLACK;

  const color = isColorString(colorValue) ? parseColor(colorValue) : undefined;
  if (color === undefined) return undefined;

  const opacity = attr(attrs, "stop-opacity", "stopopacity") ??
    style?.["stop-opacity"] ??
    style?.["stopOpacity"];
  const offset = attr(attrs, "offset") ?? "0";

  const stop: GradientStop = { color, offset: parseOffset(offset) };
  if (opacity !== undefined) stop.opacity = parseOpacity(opacity);
  return stop;
}

function applyGradientTransform(points: Point[], transform: unknown): Point[] {
  if (transform === null || transform === undefined) return points;
  const matrix = parseTransform(transform);
  return points.map((point) => transformPoint(point, matrix));
}

function gradientStops(content: readonly SvgNode[]): GradientStop[] {
  const stops: GradientStop[] = [];
  for (const node of content) {
    if (tagName(node) !== "stop") continue;
    const stop = parseGradientStop(node);
    if (stop !== undefined) stops.push(stop);
  }
  return stops;
}

function buildLinearGradient(
  shape: SvgDerivedShape,
  node: ResolvedNode,
): FillGradient | undefined {
  const units = String(
    attr(node.attrs, "gradientunits", "gradient-units") ?? "objectBoundingBox",
  ).toLowerCase();
  const transform = attr(node.attrs, "gradienttransform", "gradient-transform");

  const x1 = parseLength(attr(node.attrs, "x1", "x")) ?? 0;
  const y1 = parseLength(attr(node.attrs, "y1", "y")) ?? 0;
  const x2 = parseLength(attr(node.attrs, "x2", "x")) ?? 1;
  const y2 = parseLength(attr(node.attrs, "y2", "y")) ?? 0;
  const stops = gradientStops(node.content);
  if (stops.length === 0) return undefined;

  const points = applyGradientTransform([{ x: x1, y: y1 }, { x: x2, y: y2 }], transform);
  const [start, end] = points.map((point) => normalizePoint(point, units, shape));

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

function buildRadialGradient(
  shape: SvgDerivedShape,
  node: ResolvedNode,
): FillGradient | undefined {
  const units = String(
    attr(node.attrs, "gradientunits", "gradient-units") ?? "objectBoundingBox",
  ).toLowerCase();
  const transform = attr(node.attrs, "gradienttransform", "gradient-transform");

  const cx = parseLength(attr(node.attrs, "cx", "fx")) ?? 0.5;
  const cy = parseLength(attr(node.attrs, "cy", "fy")) ?? 0.5;
  const r = parseLength(attr(node.attrs, "r")) ?? 0.5;
  const stops = gradientStops(node.content);
  if (stops.length === 0) return undefined;

  const points = applyGradientTransform(
    [{ x: cx, y: cy }, { x: cx + r, y: cy }, { x: cx, y: cy + r }],
    transform,
  );
  const [center, pointX, pointY] = points.map((point) => normalizePoint(point, units, shape));

  const radiusX = Math.hypot(center.x - pointX.x, center.y - pointX.y);
  const radiusY = Math.hypot(center.x - pointY.x, center.y - pointY.y);
  // Prefer Y as the base radius so width becomes the X/Y ratio.
  const useY = radiusY > 0;
  const baseRadius = useY ? radiusY : radiusX;
  const radiusPoint = useY ? pointY : pointX;
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

function svgGradientToFill(
  shape: SvgDerivedShape,
  value: unknown,
): FillGradient | undefined {
  const trimmed = trimFillValue(value);
  if (trimmed === undefined) return undefined;

  const match = URL_FILL_RE.exec(trimmed);
  if (match === null) return undefined;

  const node = resolveGradientNode(shape, match[1]);
  if (node === undefined) return undefined;

  const tag = tagName(node);
  if (tag === "linearGradient") return buildLinearGradient(shape, node);
  if (tag === "radialGradient") return buildRadialGradient(shape, node);
  return undefined;
}

type SvgFill =
  | { type: "color"; value: string }
  | { type: "gradient"; value: FillGradient };

function parseSvgFill(shape: SvgDerivedShape, value: unknown): SvgFill | undefined {
  const trimmed = trimFillValue(value);
  if (trimmed === undefined) return undefined;

  const normalized = trimmed.toLowerCase() === "currentcolor" ? BLACK : trimmed;
  if (normalized === "none") return undefined;

  if (isColorString(normalized)) {
    const color = parseColor(normalized);
    return color === undefined ? undefined : { type: "color", value: color };
  }

  if (normalized.startsWith("url(")) {
    const gradient = svgGradientToFill(shape, normalized);
    return gradient === undefined ? undefined : { type: "gradient", value: gradient };
  }

  return undefined;
}

// svg-fill->fills: one fill from the style fill, else from the fill attr.
export function svgFillToFills(shape: SvgDerivedShape): Fill[] | undefined {
  const svgAttrs = shape["svg-attrs"];
  const styleFill = parseSvgFill(shape, svgAttrs?.style?.fill);
  const attrFill = parseSvgFill(shape, svgAttrs?.fill);
  const chosen = styleFill ?? attrFill;
  if (chosen === undefined) return undefined;

  const opacityValue = svgAttrs?.style?.fillOpacity ?? svgAttrs?.fillOpacity;
  const opacity =
    opacityValue === undefined || opacityValue === null
      ? undefined
      : parseDouble(opacityValue, 1);

  const fill: Fill =
    chosen.type === "color"
      ? { "fill-color": chosen.value }
      : { "fill-color-gradient": chosen.value };
  if (opacity !== undefined) fill["fill-opacity"] = opacity;
  return [fill];
}

// resolve-shape-fills: the model fills, else the SVG fill, else the SVG
// default black for raw/group shapes that carry svg attrs at all.
export function resolveShapeFills(shape: SvgDerivedShape): Fill[] {
  const base = shape.fills;
  if (base !== null && base !== undefined && base.length > 0) return [...base];

  const fallback = svgFillToFills(shape);
  if (fallback !== undefined && fallback.length > 0) return fallback;

  if ("svg-attrs" in shape && (shape.type === "svg-raw" || shape.type === "group")) {
    return [{ "fill-color": BLACK, "fill-opacity": 1 }];
  }

  return [];
}

// --- filters ---------------------------------------------------------------

function findFilterElement(
  content: readonly SvgNode[] | null | undefined,
  tag: string,
): SvgNode | undefined {
  return (content ?? []).find((node) => tagName(node) === tag);
}

function findFilterDef(shape: SvgDerivedShape): SvgNode | undefined {
  const svgAttrs = shape["svg-attrs"];
  const filterAttr = svgAttrs?.filter ?? svgAttrs?.style?.filter;
  const defs = shape["svg-defs"];
  if (filterAttr === null || filterAttr === undefined) return undefined;
  if (defs === null || defs === undefined) return undefined;

  for (const id of extractIds(filterAttr)) {
    const node = defs[id];
    if (node !== undefined) return node;
  }
  return undefined;
}

// The filter primitive attributes arrive in their source case.
function filterAttr(elem: SvgNode | null | undefined, ...keys: string[]): unknown {
  return attr(normalizeAttrs(elem?.attrs), ...keys);
}

function clampUnit(value: number): number {
  return Math.min(Math.max(value, 0), 1);
}

function buildBlur(node: SvgNode | undefined, nextId: IdFactory): Blur | undefined {
  if (node === undefined) return undefined;

  // The CLJS reads the raw key here, without the lower-casing pass.
  const raw = attr(node.attrs, "stdDeviation", "stddeviation");
  return {
    id: nextId(),
    type: "layer-blur",
    // For a layer blur the value matches stdDeviation directly.
    value: parseDouble(raw, 0) ?? 0,
    hidden: false,
  };
}

// The 20 values of an feColorMatrix of type matrix, else nothing.
function matrixValues(elem: SvgNode): number[] | undefined {
  const type = filterAttr(elem, "type");
  if (type !== undefined && type !== null && type !== "matrix") return undefined;

  const values = filterAttr(elem, "values");
  if (typeof values !== "string") return undefined;

  const parsed = (values.match(MATRIX_VALUE_RE) ?? []).map(
    (value) => parseDouble(value, 0) ?? 0,
  );
  return parsed.length === 20 ? parsed : undefined;
}

// The input is SourceAlpha, so only the constant RGB terms and the alpha row
// count.
function matrixToShadowColor(values: readonly number[]): ShadowColor {
  const channel = (index: number) => Math.round(255 * clampUnit(values[index]));
  return {
    color: rgbToHex([channel(4), channel(9), channel(14)]),
    opacity: clampUnit(values[18] + values[19]),
  };
}

function floodToShadowColor(elem: SvgNode): ShadowColor {
  const color = trimFillValue(filterAttr(elem, "flood-color", "floodcolor"));
  const opacity = filterAttr(elem, "flood-opacity", "floodopacity");
  const parsed = isColorString(color) ? parseColor(color) : undefined;

  return {
    color: parsed ?? BLACK,
    opacity:
      opacity === undefined || opacity === null ? 1 : clampUnit(parseOpacity(opacity)),
  };
}

// The last colour matrix or flood after the feOffset; earlier ones shape the
// silhouette.
function shadowColor(content: readonly SvgNode[]): ShadowColor | undefined {
  const offset = content.findIndex((node) => tagName(node) === "feOffset");
  if (offset === -1) return undefined;

  const sources = content
    .slice(offset)
    .filter((node) => tagName(node) === "feColorMatrix" || tagName(node) === "feFlood");
  const source = sources[sources.length - 1];
  if (source === undefined) return undefined;

  const tag = tagName(source);
  if (tag === "feFlood") return floodToShadowColor(source);
  if (tag === "feColorMatrix") {
    const values = matrixValues(source);
    return values === undefined ? undefined : matrixToShadowColor(values);
  }
  return undefined;
}

function dropShadow(
  dx: number,
  dy: number,
  stdDeviation: number,
  color: ShadowColor,
  nextId: IdFactory,
): Shadow[] {
  return [
    {
      id: nextId(),
      style: "drop-shadow",
      "offset-x": dx,
      "offset-y": dy,
      blur: 2 * stdDeviation,
      spread: 0,
      hidden: false,
      color,
    },
  ];
}

function buildDropShadow(
  content: readonly SvgNode[],
  nextId: IdFactory,
): Shadow[] | undefined {
  const offset = findFilterElement(content, "feOffset");
  if (offset === undefined) return undefined;

  const blur = findFilterElement(content, "feGaussianBlur");
  return dropShadow(
    parseDouble(filterAttr(offset, "dx"), 0) ?? 0,
    parseDouble(filterAttr(offset, "dy"), 0) ?? 0,
    parseDouble(filterAttr(blur, "stddeviation"), 0) ?? 0,
    shadowColor(content) ?? { color: BLACK, opacity: 1 },
    nextId,
  );
}

// feDropShadow: dx, dy and stdDeviation default to 2.
function buildFeDropShadow(elem: SvgNode, nextId: IdFactory): Shadow[] {
  return dropShadow(
    parseDouble(filterAttr(elem, "dx"), 2) ?? 2,
    parseDouble(filterAttr(elem, "dy"), 2) ?? 2,
    parseDouble(filterAttr(elem, "stddeviation"), 2) ?? 2,
    floodToShadowColor(elem),
    nextId,
  );
}

// apply-svg-filters: native blur and shadow from the SVG filter defs, only
// when the shape has none of its own. The SVG attrs stay untouched so the
// SVG fallback keeps rendering the same.
export function applySvgFilters(
  shape: SvgDerivedShape,
  nextId: IdFactory = nextUuid,
): SvgDerivedShape {
  const def = findFilterDef(shape);
  if (def === undefined) return shape;

  const existingBlur = shape.blur ?? undefined;
  const existingShadow = shape.shadow ?? undefined;

  const content = def.content ?? [];
  const feDropShadow = findFilterElement(content, "feDropShadow");
  // In a shadow chain the blur belongs to the shadow, not to the shape.
  const shadowChain =
    feDropShadow !== undefined || findFilterElement(content, "feOffset") !== undefined;
  const gaussianBlur = shadowChain ? undefined : findFilterElement(content, "feGaussianBlur");

  const blur = existingBlur ?? buildBlur(gaussianBlur, nextId);
  const shadow =
    existingShadow !== undefined && existingShadow.length > 0
      ? existingShadow
      : feDropShadow !== undefined
        ? buildFeDropShadow(feDropShadow, nextId)
        : buildDropShadow(content, nextId);

  const result: SvgDerivedShape = { ...shape };
  if (blur !== undefined) result.blur = blur;
  if (shadow !== undefined && shadow.length > 0) result.shadow = shadow;
  return result;
}

// apply-svg-derived: filters first, then the fills, with blur and shadow
// always present on the result.
export function applySvgDerived(
  shape: SvgDerivedShape,
  nextId: IdFactory = nextUuid,
): SvgDerivedResult {
  const filtered = applySvgFilters(shape, nextId);
  return {
    ...filtered,
    fills: resolveShapeFills(filtered),
    blur: filtered.blur ?? undefined,
    shadow: filtered.shadow ?? undefined,
  };
}