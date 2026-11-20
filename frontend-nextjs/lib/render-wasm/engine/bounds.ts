// Shape bounds: the port of app.common.geom.shapes.bounds plus the rect
// primitives it reads (app.common.geom.rect).
//
// The viewer sizes its canvas from `object-bounds` of the frame with
// `ignore-margin? false`, so every rule here changes what the viewport can
// show: the stroke margin (with the open-path and cap-marker variants), the
// drop-shadow margin and the blur doubling. Keep the arithmetic in the same
// order as the CLJS so floating point results match.
//
// The functions read the decoded plain objects of the bundle (kebab-case
// keys), not the CLJS records.

import { shapeWithOpenPath } from "./path";
import type { Point } from "./viewport";

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

type Shape = Record<string, unknown>;

// rect/make-rect: the width and height never go below 0.01, so a degenerate
// rect still has corners to join.
export function makeRect(x = 0, y = 0, width = 0.01, height = 0.01): Rect {
  const w = Math.max(width, 0.01);
  const h = Math.max(height, 0.01);
  return { x, y, width: w, height: h, x1: x, y1: y, x2: x + w, y2: y + h };
}

function numberOr(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readNumber(shape: Shape, key: string, fallback = 0): number {
  return numberOr(shape[key], fallback);
}

function readRect(value: unknown): Rect | null {
  if (value === null || typeof value !== "object") return null;
  const rect = value as Record<string, unknown>;
  if (typeof rect.x !== "number" || typeof rect.y !== "number") return null;
  return makeRect(rect.x, rect.y, numberOr(rect.width, 0.01), numberOr(rect.height, 0.01));
}

function readPoints(value: unknown): Point[] {
  if (!Array.isArray(value)) return [];
  const out: Point[] = [];
  for (const point of value) {
    if (point === null || typeof point !== "object") continue;
    const { x, y } = point as { x?: unknown; y?: unknown };
    if (typeof x !== "number" || typeof y !== "number") continue;
    out.push({ x, y });
  }
  return out;
}

// rect/points->rect: the axis-aligned box around the points. Nil points
// answer nil in the CLJS; the callers here substitute an empty rect.
export function pointsRect(points: readonly Point[]): Rect | null {
  if (points.length === 0) return null;
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const point of points) {
    if (point.x < minX) minX = point.x;
    if (point.y < minY) minY = point.y;
    if (point.x > maxX) maxX = point.x;
    if (point.y > maxY) maxY = point.y;
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return makeRect(minX, minY, maxX - minX, maxY - minY);
}

// rect/join-rects: the union box of the rects that carry numeric corners.
export function joinRects(rects: readonly (Rect | null | undefined)[]): Rect | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let seen = false;
  for (const rect of rects) {
    if (rect === null || rect === undefined) continue;
    seen = true;
    if (rect.x1 < minX) minX = rect.x1;
    if (rect.y1 < minY) minY = rect.y1;
    if (rect.x2 > maxX) maxX = rect.x2;
    if (rect.y2 > maxY) maxY = rect.y2;
  }
  if (!seen || !Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  return makeRect(minX, minY, maxX - minX, maxY - minY);
}

export function rectToPoints(rect: Rect): Point[] {
  return [
    { x: rect.x, y: rect.y },
    { x: rect.x2, y: rect.y },
    { x: rect.x2, y: rect.y2 },
    { x: rect.x, y: rect.y2 },
  ];
}

export interface Padding {
  horizontal: number;
  vertical: number;
}

export interface FilterEntry {
  id: string;
  type: string;
  params: Shape;
}

function isHidden(shape: Shape): boolean {
  return shape.hidden === true;
}

function shadowList(shape: Shape): Shape[] {
  const value = shape.shadow;
  return Array.isArray(value)
    ? value.filter((item): item is Shape => item !== null && typeof item === "object")
    : [];
}

// shape-stroke-margin: a path keeps the extra stroke width inside the
// margin because its geometry can run along the stroke.
function shapeStrokeMargin(shape: Shape, strokeWidth: number): number {
  const diagonal = Math.sqrt(2 * strokeWidth * strokeWidth);
  return shape.type === "path" ? strokeWidth + diagonal : diagonal;
}

const STROKE_CAPS_MARKER = new Set([
  "line-arrow",
  "triangle-arrow",
  "square-marker",
  "circle-marker",
  "diamond-marker",
]);

const STROKE_MARGIN_MULTIPLIER = 4.25;

function strokeCapMarkerMargin(strokes: readonly Shape[], openPath: boolean): number {
  if (!openPath) return 0;
  let margin = 0;
  for (const stroke of strokes) {
    const start = stroke["stroke-cap-start"];
    const end = stroke["stroke-cap-end"];
    const marker =
      (typeof start === "string" && STROKE_CAPS_MARKER.has(start)) ||
      (typeof end === "string" && STROKE_CAPS_MARKER.has(end));
    if (!marker) continue;
    margin = Math.max(margin, STROKE_MARGIN_MULTIPLIER * readNumber(stroke, "stroke-width"));
  }
  return margin;
}

function strokeWidth(strokes: readonly Shape[], openPath: boolean): number {
  let max = 0;
  for (const stroke of strokes) {
    const width = readNumber(stroke, "stroke-width");
    // (get % :stroke-alignment :center): the key may be absent, and the
    // default stroke record carries :inner explicitly.
    const alignment = Object.prototype.hasOwnProperty.call(stroke, "stroke-alignment")
      ? stroke["stroke-alignment"]
      : "center";
    const value =
      alignment === "center"
        ? width / 2
        : alignment === "outer"
          ? width
          : // The inner alignment only pads an open path.
            openPath
            ? width
            : 0;
    max = Math.max(max, value);
  }
  return max;
}

function shadowMargin(shape: Shape, axis: "offset-x" | "offset-y"): number {
  let max = 0;
  for (const shadow of shadowList(shape)) {
    if (isHidden(shadow)) continue;
    const style = shadow.style ?? "drop-shadow";
    if (style !== "drop-shadow") continue;
    const margin =
      Math.abs(readNumber(shadow, axis)) +
      readNumber(shadow, "spread") * 2 +
      readNumber(shadow, "blur") * 2 +
      10;
    max = Math.max(max, margin);
  }
  return max;
}

// calculate-padding: the margin the base bounds add around a shape.
export function calculatePadding(
  shape: Shape,
  ignoreMargin = false,
  ignoreShadowMargin = false,
): Padding {
  const strokes = Array.isArray(shape.strokes)
    ? shape.strokes.filter((item): item is Shape => item !== null && typeof item === "object")
    : [];

  const openPath = shapeWithOpenPath(shape);

  const stroke = ignoreMargin ? 0 : shapeStrokeMargin(shape, strokeWidth(strokes, openPath));
  const cap = ignoreMargin ? 0 : strokeCapMarkerMargin(strokes, openPath);
  const horizontal = ignoreShadowMargin ? 0 : shadowMargin(shape, "offset-x");
  const vertical = ignoreShadowMargin ? 0 : shadowMargin(shape, "offset-y");

  return {
    horizontal: Math.ceil(stroke + cap + horizontal),
    vertical: Math.ceil(stroke + cap + vertical),
  };
}

// add-padding: grow the rect on every side.
export function addPadding(bounds: Rect, padding: Padding): Rect {
  const h = padding.horizontal;
  const v = padding.vertical;
  return {
    x: bounds.x - h,
    y: bounds.y - v,
    width: bounds.width + 2 * h,
    height: bounds.height + 2 * v,
    x1: bounds.x1 - h,
    y1: bounds.y1 - v,
    x2: bounds.x2 + h,
    y2: bounds.y2 + v,
  };
}

// shape->filters: the paint-server chain of the shape. Only the entries
// whose type is :drop-shadow feed the bounds; the rest keep the shape of the
// list so a later paint-server port reads the same order.
export function shapeFilters(shape: Shape): FilterEntry[] {
  const out: FilterEntry[] = [{ id: "BackgroundImageFix", type: "image-fix", params: {} }];

  for (const shadow of shadowList(shape)) {
    if (isHidden(shadow) || shadow.style !== "drop-shadow") continue;
    out.push({ id: "filter_" + String(shadow.id), type: "drop-shadow", params: shadow });
  }

  out.push({ id: "shape", type: "blend-filters", params: {} });

  for (const shadow of shadowList(shape)) {
    if (isHidden(shadow) || shadow.style !== "inner-shadow") continue;
    out.push({ id: "filter_" + String(shadow.id), type: "inner-shadow", params: shadow });
  }

  const blur = shape.blur;
  if (
    blur !== null &&
    typeof blur === "object" &&
    !isHidden(blur as Shape) &&
    (blur as Shape).type === "layer-blur"
  ) {
    out.push({ id: "filter_" + String((blur as Shape).id), type: "layer-blur", params: blur as Shape });
  }

  return out;
}

function calculateFilterBounds(selrect: Rect, filter: FilterEntry): Rect {
  const params = filter.params;
  const offsetX = readNumber(params, "offset-x");
  const offsetY = readNumber(params, "offset-y");
  const blur = readNumber(params, "blur");
  const spread = readNumber(params, "spread");

  const x = Math.min(selrect.x, selrect.x + offsetX - spread - blur - 5);
  const y = Math.min(selrect.y, selrect.y + offsetY - spread - blur - 5);
  const width = selrect.width + Math.abs(offsetX) + spread * 2 + blur * 2 + 10;
  const height = selrect.height + Math.abs(offsetY) + spread * 2 + blur * 2 + 10;
  return makeRect(x, y, width, height);
}

// get-rect-filter-bounds: the shadow rects joined with the input, then
// doubled by the layer blur.
export function getRectFilterBounds(
  selrect: Rect,
  filters: readonly FilterEntry[],
  blurValue: number,
  ignoreShadowMargin = false,
): Rect {
  const rects: Rect[] = [selrect];
  if (!ignoreShadowMargin) {
    for (const filter of filters) {
      if (filter.type !== "drop-shadow") continue;
      rects.push(calculateFilterBounds(selrect, filter));
    }
  }

  const joined = joinRects(rects) ?? selrect;
  const delta = blurValue * 2;
  return {
    x: joined.x - delta,
    y: joined.y - delta,
    width: joined.width + delta * 2,
    height: joined.height + delta * 2,
    x1: joined.x1 - delta,
    y1: joined.y1 - delta,
    x2: joined.x2 + delta,
    y2: joined.y2 + delta,
  };
}

function objectPoints(shape: Shape): Point[] {
  return readPoints(shape.points);
}

function blurValue(shape: Shape): number {
  const blur = shape.blur;
  if (blur === null || typeof blur !== "object") return 0;
  return readNumber(blur as Shape, "value");
}

// get-shape-filter-bounds: the selrect of an svg-raw child (its points do
// not carry the rotation), the points box when no shadow or blur widen it,
// and the filter chain otherwise.
export function getShapeFilterBounds(shape: Shape, ignoreShadowMargin = false): Rect {
  if (shape.type === "svg-raw") {
    const content = shape.content;
    const tag =
      content !== null && typeof content === "object"
        ? (content as Shape).tag
        : undefined;
    if (tag !== "svg") {
      return readRect(shape.selrect) ?? makeRect();
    }
  }

  const shadows = shadowList(shape);
  const blur = blurValue(shape);
  if (shadows.length === 0 && blur === 0) {
    return pointsRect(objectPoints(shape)) ?? readRect(shape.selrect) ?? makeRect();
  }

  const selrect = pointsRect(objectPoints(shape)) ?? readRect(shape.selrect) ?? makeRect();
  return getRectFilterBounds(selrect, shapeFilters(shape), blur, ignoreShadowMargin);
}

// calculate-base-bounds: the shape box with its own padding.
export function calculateBaseBounds(
  shape: Shape,
  ignoreMargin = true,
  ignoreShadowMargin = false,
): Rect {
  return addPadding(
    getShapeFilterBounds(shape, ignoreShadowMargin),
    calculatePadding(shape, ignoreMargin, ignoreShadowMargin),
  );
}

// files/reduce-objects: walk a subtree depth first from `root-id`, the
// children of a shape only when `checkChildren` accepts it. A `pending`
// queue keeps the order (children first) and a processed set guards a
// malformed model that points at the same id twice.
export function reduceObjects<T>(
  objects: Readonly<Record<string, unknown>>,
  rootId: string,
  checkChildren: ((shape: Shape) => boolean) | null,
  reducer: (value: T, shape: Shape) => T,
  init: T,
): T {
  const lookup = (id: string): Shape | undefined => {
    const value = objects[id];
    return value !== null && typeof value === "object" ? (value as Shape) : undefined;
  };

  const root = lookup(rootId);
  if (root === undefined) return init;
  const rootChildren = Array.isArray(root.shapes) ? root.shapes : [];
  if (rootChildren.length === 0) return init;

  let value = init;
  let currentId: unknown = rootChildren[0];
  let pending: unknown[] = rootChildren.slice(1);
  const processed = new Set<unknown>();

  while (currentId !== undefined) {
    if (typeof currentId !== "string" || processed.has(currentId)) {
      currentId = pending.shift();
      continue;
    }
    processed.add(currentId);
    const shape = lookup(currentId);
    if (shape === undefined) {
      currentId = pending.shift();
      continue;
    }
    value = reducer(value, shape);
    if (checkChildren === null || checkChildren(shape)) {
      const children = Array.isArray(shape.shapes) ? shape.shapes : [];
      pending = children.concat(pending);
    }
    currentId = pending.shift();
  }

  return value;
}

export interface ObjectBoundsOptions {
  ignoreMargin?: boolean;
  ignoreShadowMargin?: boolean;
}

function isFrame(shape: Shape): boolean {
  return shape.type === "frame";
}

function isGroup(shape: Shape): boolean {
  return shape.type === "group";
}

// get-object-bounds: the shape box joined with the boxes of its visible
// descendants that can paint outside their parent, then the shape's own
// filter chain. A frame reports its content box; a clipped, masked or bool
// parent stops the walk.
export function objectBounds(
  objects: Readonly<Record<string, unknown>>,
  shape: Shape,
  options: ObjectBoundsOptions = {},
): Rect {
  const ignoreMargin = options.ignoreMargin ?? true;
  const ignoreShadowMargin = options.ignoreShadowMargin ?? false;

  const base = calculateBaseBounds(shape, ignoreMargin, ignoreShadowMargin);
  const children = Array.isArray(shape.shapes) ? shape.shapes : [];
  const frame = isFrame(shape);

  let bounds: Rect[];
  if (
    children.length === 0 ||
    shape["masked-group"] === true ||
    shape.type === "bool" ||
    (frame && shape["show-content"] !== true)
  ) {
    bounds = [base];
  } else {
    bounds = reduceObjects<Rect[]>(
      objects,
      typeof shape.id === "string" ? shape.id : "",
      (child) =>
        !isHidden(child) &&
        Array.isArray(child.shapes) &&
        child.shapes.length > 0 &&
        (!isFrame(child) || child["show-content"] === true) &&
        (!isGroup(child) || child["masked-group"] !== true),
      (result, child) => {
        if (isHidden(child)) return result;
        result.push(calculateBaseBounds(child));
        return result;
      },
      [base],
    );
  }

  let joined = joinRects(bounds);
  if (!frame && joined === null) {
    joined = readRect(shape["children-bounds"]);
  }
  const childrenBounds = joined ?? base;

  return getRectFilterBounds(childrenBounds, shapeFilters(shape), blurValue(shape), ignoreShadowMargin);
}
