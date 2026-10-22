// Workspace style model (F9.5): the pure fill/stroke/radius surgery behind
// the style panel, and the mod-obj change builder.
//
// Ported from:
// - frontend/src/app/main/data/workspace/colors.cljs (add-fill prepends,
//   remove-fill splices by index, add-stroke prepends, remove-stroke
//   splices by index);
// - common/src/app/common/types/fills.cljc (prepend);
// - common/src/app/common/types/stroke.cljc (default-stroke: inner, solid,
//   black, opacity 1, width 1);
// - common/src/app/common/types/shape.cljc (default fill #B1B2B5 at
//   opacity 1 and the r1..r4 radius attrs).
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
