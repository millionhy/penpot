// Workspace style model (F9.5, extended by F9.9): the pure fill/stroke/
// radius/shadow/blur surgery behind the style panel, and the mod-obj change
// builder.
//
// Ported from:
// - frontend/src/app/main/data/workspace/colors.cljs (add-fill prepends,
//   remove-fill splices by index, add-stroke prepends, remove-stroke
//   splices by index, add-shadow prepends);
// - common/src/app/common/types/fills.cljc (prepend);
// - common/src/app/common/types/stroke.cljc (default-stroke: inner, solid,
//   black, opacity 1, width 1);
// - common/src/app/common/types/shape.cljc (default fill #B1B2B5 at
//   opacity 1 and the r1..r4 radius attrs);
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/shadow.cljs
//   (create-shadow: drop-shadow, black at opacity 0.2, offset 4/4, blur 4,
//   spread 0, visible);
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/blur.cljs
//   (create-blur: layer-blur, value 4, visible);
// - common/src/app/common/types/shape/{shadow,blur}.cljc (the schemas the
//   helpers keep the values inside).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
// The panel owns the drafts and the canvas owns the RPC; this module only
// builds new immutable arrays and the wire change.
//
// Deviations from the CLJS original, documented (AD12):
// - Binary fills (the frontend-binary-fills flag) do not exist here: every
//   fills/strokes value is a plain array.
// - Gradients and images are read-only rows: the helpers never edit their
//   keys, only their position in the array.
// - No per-side stroke widths, caps or markers: the panel edits the one
//   stroke-width value.
// - Only the layer blur exists: the background-blur variant (a feature flag
//   in the CLJS build) has no row here.

import type { UpdateFileModObjChange } from "@/lib/transit";
import type { WorkspaceShape } from "@/lib/workspace";

// shape/attrs.cljc default-color (colors.cljc gray-20).
const DEFAULT_FILL_COLOR = "#B1B2B5";

// colors.cljc black.
const DEFAULT_STROKE_COLOR = "#000000";

export interface SolidFill {
  "fill-color": string;
  "fill-opacity": number;
  [key: string]: unknown;
}

export interface SolidStroke {
  "stroke-color": string;
  "stroke-opacity": number;
  "stroke-width": number;
  "stroke-alignment": string;
  "stroke-style": string;
  [key: string]: unknown;
}

// The fill of a shape created without one (cts/setup-shape).
export const DEFAULT_FILL: SolidFill = {
  "fill-color": DEFAULT_FILL_COLOR,
  "fill-opacity": 1,
};

// cts/default-stroke: the stroke add-stroke prepends.
export const DEFAULT_STROKE: SolidStroke = {
  "stroke-color": DEFAULT_STROKE_COLOR,
  "stroke-opacity": 1,
  "stroke-width": 1,
  "stroke-alignment": "inner",
  "stroke-style": "solid",
};

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

function clampNonNegative(value: number): number {
  return Math.max(0, Number.isFinite(value) ? value : 0);
}

// The fills of a shape as a mutable copy; the elements stay shared.
export function fillsOf(shape: WorkspaceShape): unknown[] {
  return Array.isArray(shape.fills) ? [...shape.fills] : [];
}

// The strokes of a shape as a mutable copy; the elements stay shared.
export function strokesOf(shape: WorkspaceShape): unknown[] {
  return Array.isArray(shape.strokes) ? [...shape.strokes] : [];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

// A solid fill carries a plain color and no gradient or image payload.
export function isSolidFill(fill: unknown): boolean {
  const record = recordOf(fill);
  if (record === null) return false;
  return (
    typeof record["fill-color"] === "string" &&
    record["fill-color-gradient"] === undefined &&
    record["fill-image"] === undefined
  );
}

// A stroke whose paint is a plain color; a stroke-image row is read-only.
export function isSolidStroke(stroke: unknown): boolean {
  const record = recordOf(stroke);
  if (record === null) return false;
  return typeof record["stroke-color"] === "string" && record["stroke-image"] === undefined;
}

// add-fill: prepend the default fill, keeping the existing order.
export function addFill(fills: readonly unknown[]): unknown[] {
  return [{ ...DEFAULT_FILL }, ...fills];
}

// remove-fill: splice by index; an out-of-range index changes nothing.
export function removeFill(fills: readonly unknown[], index: number): unknown[] {
  return fills.filter((_, position) => position !== index);
}

// Update one fill in place preserving its other keys; an out-of-range
// index returns the array unchanged (a copy).
export function withFillColor(
  fills: readonly unknown[],
  index: number,
  color: string,
): unknown[] {
  return fills.map((fill, position) =>
    position === index && recordOf(fill) !== null
      ? { ...recordOf(fill), "fill-color": color }
      : fill,
  );
}

export function withFillOpacity(
  fills: readonly unknown[],
  index: number,
  opacity: number,
): unknown[] {
  const value = clamp01(opacity);
  return fills.map((fill, position) =>
    position === index && recordOf(fill) !== null
      ? { ...recordOf(fill), "fill-opacity": value }
      : fill,
  );
}

// add-stroke: prepend the default stroke, keeping the existing order.
export function addStroke(strokes: readonly unknown[]): unknown[] {
  return [{ ...DEFAULT_STROKE }, ...strokes];
}

// remove-stroke: splice by index; an out-of-range index changes nothing.
export function removeStroke(strokes: readonly unknown[], index: number): unknown[] {
  return strokes.filter((_, position) => position !== index);
}

export function withStrokeColor(
  strokes: readonly unknown[],
  index: number,
  color: string,
): unknown[] {
  return strokes.map((stroke, position) =>
    position === index && recordOf(stroke) !== null
      ? { ...recordOf(stroke), "stroke-color": color }
      : stroke,
  );
}

export function withStrokeWidth(
  strokes: readonly unknown[],
  index: number,
  width: number,
): unknown[] {
  const value = clampNonNegative(width);
  return strokes.map((stroke, position) =>
    position === index && recordOf(stroke) !== null
      ? { ...recordOf(stroke), "stroke-width": value }
      : stroke,
  );
}

export function withStrokeOpacity(
  strokes: readonly unknown[],
  index: number,
  opacity: number,
): unknown[] {
  const value = clamp01(opacity);
  return strokes.map((stroke, position) =>
    position === index && recordOf(stroke) !== null
      ? { ...recordOf(stroke), "stroke-opacity": value }
      : stroke,
  );
}

// The shape opacity, defaulting to 1 and clamped to the schema range.
export function shapeOpacity(shape: WorkspaceShape): number {
  return typeof shape.opacity === "number" ? clamp01(shape.opacity) : 1;
}

export function shapeHidden(shape: WorkspaceShape): boolean {
  return shape.hidden === true;
}

// The lock attribute is :blocked in the CLJS model, not :locked.
export function shapeBlocked(shape: WorkspaceShape): boolean {
  return shape.blocked === true;
}

// The four corner radii in r1..r4 order; missing or negative values read 0.
export function radiusOf(shape: WorkspaceShape): [number, number, number, number] {
  const read = (key: "r1" | "r2" | "r3" | "r4"): number => {
    const value = shape[key];
    return typeof value === "number" ? clampNonNegative(value) : 0;
  };
  return [read("r1"), read("r2"), read("r3"), read("r4")];
}

// The types whose fills/strokes the panel edits (AD12.12): text has
// per-span fills, group and svg-raw have no paint of their own.
const FILL_STROKE_TYPES = new Set(["rect", "circle", "frame", "path", "bool", "image"]);

export function supportsFillStroke(type: string): boolean {
  return FILL_STROKE_TYPES.has(type);
}

// --- Shadows ----------------------------------------------------------------
//
// cts/shadow: a shadow is a plain map on the shape's :shadow vector (note the
// singular attribute name, which the wasm upload reads as well). Every value
// here stays inside schema:shadow so the backend accepts the change.

export interface ShadowColor {
  color: string;
  opacity?: number;
  [key: string]: unknown;
}

export interface Shadow {
  id: string;
  style: string;
  "offset-x": number;
  "offset-y": number;
  blur: number;
  spread: number;
  hidden: boolean;
  color: ShadowColor;
  [key: string]: unknown;
}

// The shape :shadow list; a missing or malformed value reads as no shadows.
export function shadowsOf(shape: WorkspaceShape): unknown[] {
  return Array.isArray(shape.shadow) ? [...shape.shadow] : [];
}

// shadow.cljs styles; the schema accepts only these two.
const SHADOW_STYLES = ["drop-shadow", "inner-shadow"] as const;

// create-shadow of menus/shadow.cljs.
const DEFAULT_SHADOW_COLOR = "#000000";
const DEFAULT_SHADOW_OPACITY = 0.2;
const DEFAULT_SHADOW_OFFSET = 4;
const DEFAULT_SHADOW_BLUR = 4;

// The shadow add-shadow prepends. The id comes from the caller so the
// helpers stay deterministic under test.
function createShadow(id: string): Shadow {
  return {
    id,
    style: "drop-shadow",
    color: { color: DEFAULT_SHADOW_COLOR, opacity: DEFAULT_SHADOW_OPACITY },
    "offset-x": DEFAULT_SHADOW_OFFSET,
    "offset-y": DEFAULT_SHADOW_OFFSET,
    blur: DEFAULT_SHADOW_BLUR,
    spread: 0,
    hidden: false,
  };
}

// add-shadow: prepend, keeping the existing order.
export function addShadow(shadows: readonly unknown[], id: string): unknown[] {
  return [createShadow(id), ...shadows];
}

// remove-shadow: splice by index; an out-of-range index changes nothing.
export function removeShadow(shadows: readonly unknown[], index: number): unknown[] {
  return shadows.filter((_, position) => position !== index);
}

// The shadow attribute a commit sends. An empty list inverts to a nil val,
// which deletes :shadow (the CLJS remove-all dissocs it) instead of leaving
// an empty vector on the shape; a nil val dissocs on both sides, as
// workspace-undo's local mirror does.
export function shadowsPatch(shadows: readonly unknown[]): unknown[] | null {
  return shadows.length === 0 ? null : [...shadows];
}

// Map one shadow, leaving every other row and every other key untouched.
function mapShadow(
  shadows: readonly unknown[],
  index: number,
  update: (shadow: Record<string, unknown>) => Record<string, unknown>,
): unknown[] {
  return shadows.map((shadow, position) => {
    const record = recordOf(shadow);
    return position === index && record !== null ? update(record) : shadow;
  });
}

// A numeric shadow field; offset and spread take safe numbers, blur a
// non-negative one (schema:shadow). A non-finite entry keeps the old value.
export function withShadowNumber(
  shadows: readonly unknown[],
  index: number,
  field: "offset-x" | "offset-y" | "blur" | "spread",
  value: number,
): unknown[] {
  if (!Number.isFinite(value)) return [...shadows];
  const next = field === "blur" ? clampNonNegative(value) : value;
  return mapShadow(shadows, index, (shadow) => ({ ...shadow, [field]: next }));
}

// The style enum; an unknown value keeps the stored style.
export function withShadowStyle(
  shadows: readonly unknown[],
  index: number,
  style: string,
): unknown[] {
  if (!(SHADOW_STYLES as readonly string[]).includes(style)) return [...shadows];
  return mapShadow(shadows, index, (shadow) => ({ ...shadow, style }));
}

export function withShadowHidden(
  shadows: readonly unknown[],
  index: number,
  hidden: boolean,
): unknown[] {
  return mapShadow(shadows, index, (shadow) => ({ ...shadow, hidden }));
}

// The shadow color is the nested {color, opacity} map of schema:color-attrs.
export function withShadowColor(
  shadows: readonly unknown[],
  index: number,
  color: string,
): unknown[] {
  return mapShadow(shadows, index, (shadow) => ({
    ...shadow,
    color: { ...recordOf(shadow.color), color },
  }));
}

export function withShadowOpacity(
  shadows: readonly unknown[],
  index: number,
  opacity: number,
): unknown[] {
  const value = clamp01(opacity);
  return mapShadow(shadows, index, (shadow) => ({
    ...shadow,
    color: { ...recordOf(shadow.color), opacity: value },
  }));
}

// --- Blur -------------------------------------------------------------------

// cts/blur: one map, not a list (the layer-blur type of schema:blur).
export interface LayerBlur {
  id: string;
  type: string;
  value: number;
  hidden: boolean;
  [key: string]: unknown;
}

// create-blur of menus/blur.cljs.
const DEFAULT_BLUR_VALUE = 4;

// The blur record of a shape; a missing or malformed value reads as none.
// A commit removes it with a nil val (schema:blur has no empty form).
export function blurOf(shape: WorkspaceShape): Record<string, unknown> | null {
  return recordOf(shape.blur);
}

// The blur the panel adds, with the id supplied by the caller.
function createBlur(id: string): LayerBlur {
  return { id, type: "layer-blur", value: DEFAULT_BLUR_VALUE, hidden: false };
}

// A new layer blur, replacing nothing: the shape holds one blur only.
export function addBlur(id: string): LayerBlur {
  return createBlur(id);
}

export function withBlurValue(blur: unknown, value: number): Record<string, unknown> {
  return { ...recordOf(blur), value: clampNonNegative(value) };
}

export function withBlurHidden(blur: unknown, hidden: boolean): Record<string, unknown> {
  return { ...recordOf(blur), hidden };
}

// One mod-obj with one set operation per attribute (AD7): a radius edit
// sends r1..r4 atomically, and the change never carries the page or the id
// beyond the envelope.
export function buildStyleChange(
  id: string,
  pageId: string,
  attrs: Record<string, unknown>,
): UpdateFileModObjChange {
  return {
    type: "mod-obj",
    id,
    "page-id": pageId,
    operations: Object.entries(attrs).map(([attr, val]) => ({
      type: "set",
      attr,
      val,
    })),
  };
}
