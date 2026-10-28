// The selected-colors menu of the workspace style panel (F9.14): the unique
// colors of the selection, where each one is used, and the batch edit that
// recolors every usage at once.
//
// Ported from:
// - frontend/src/app/main/data/workspace/colors.cljs (extract-all-colors:
//   fills, strokes and shadow colors of every shape, each with its shape id
//   and list index);
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/
//   color_selection.cljs (prepare-colors groups by the color attrs and
//   reuses the group to rewrite every usage).
//
// A color group keeps the stored hex and the stored opacity together, so the
// same hex at two opacities is two rows, like the CLJS grouping by the full
// color attrs map. The rows never edit a token: this slice has no token
// layer, so every color is a plain value.
//
// Deviations from the CLJS original, documented (AD12):
// - Library colors and applied tokens have no rows of their own; every color
//   reads as a plain color.
// - Only solid fills and strokes appear; a gradient or an image fill keeps
//   its own row in the fill menu and stays out of this list.
// - The "select the shapes using this color" action goes through
//   lib/workspace-store setSelection and leaves the group order alone.

import type { WorkspaceShape } from "@/lib/workspace";
import type { ShapeUpdate } from "@/lib/workspace-multi";

export type ColorProp = "fill" | "stroke" | "shadow";

export interface ColorUsage {
  shapeId: string;
  prop: ColorProp;
  index: number;
}

export interface SelectedColor {
  color: string;
  // 0..1, the stored paint opacity (a missing value reads as 1).
  opacity: number;
  usages: ColorUsage[];
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function opacityOf(value: unknown): number {
  return typeof value === "number" ? clamp01(value) : 1;
}

// A solid paint: a plain color and no gradient or image payload.
function solidColorOf(paint: unknown, colorKey: string, opacityKey: string) {
  const record = recordOf(paint);
  if (record === null) return null;
  const color = record[colorKey];
  if (typeof color !== "string") return null;
  if (record["fill-color-gradient"] !== undefined) return null;
  if (record["fill-image"] !== undefined) return null;
  if (record["stroke-image"] !== undefined) return null;
  return { color, opacity: opacityOf(record[opacityKey]) };
}

// A shadow color is the nested {color, opacity} map of schema:color-attrs.
function shadowColorOf(shadow: unknown) {
  const record = recordOf(shadow);
  if (record === null) return null;
  const color = recordOf(record.color);
  if (color === null) return null;
  const value = color.color;
  if (typeof value !== "string") return null;
  return { color: value, opacity: opacityOf(color.opacity) };
}

// The unique colors of the shapes, in the order they appear.
export function selectedColors(shapes: readonly WorkspaceShape[]): SelectedColor[] {
  const out: SelectedColor[] = [];
  const index = new Map<string, SelectedColor>();

  const push = (color: string, opacity: number, usage: ColorUsage): void => {
    const key = `${color}\u0000${opacity}`;
    const known = index.get(key);
    if (known !== undefined) {
      known.usages.push(usage);
      return;
    }
    const entry: SelectedColor = { color, opacity, usages: [usage] };
    index.set(key, entry);
    out.push(entry);
  };

  for (const shape of shapes) {
    const id = shape.id;
    if (Array.isArray(shape.fills)) {
      shape.fills.forEach((fill, position) => {
        const solid = solidColorOf(fill, "fill-color", "fill-opacity");
        if (solid !== null) push(solid.color, solid.opacity, { shapeId: id, prop: "fill", index: position });
      });
    }
    if (Array.isArray(shape.strokes)) {
      shape.strokes.forEach((stroke, position) => {
        const solid = solidColorOf(stroke, "stroke-color", "stroke-opacity");
        if (solid !== null) {
          push(solid.color, solid.opacity, { shapeId: id, prop: "stroke", index: position });
        }
      });
    }
    if (Array.isArray(shape.shadow)) {
      shape.shadow.forEach((shadow, position) => {
        const solid = shadowColorOf(shadow);
        if (solid !== null) push(solid.color, solid.opacity, { shapeId: id, prop: "shadow", index: position });
      });
    }
  }
  return out;
}

export interface ColorEdit {
  color?: string;
  // 0..1
  opacity?: number;
}

// The batch patch that recolors every usage: one ShapeUpdate per shape, so
// the canvas commits the list in one update-file call. A usage whose shape
// the caller did not pass is ignored.
export function colorUpdates(
  shapes: readonly WorkspaceShape[],
  usages: readonly ColorUsage[],
  edit: ColorEdit,
): ShapeUpdate[] {
  if (usages.length === 0) return [];
  const byId = new Map<string, WorkspaceShape>();
  for (const shape of shapes) byId.set(shape.id, shape);

  const grouped = new Map<string, ColorUsage[]>();
  for (const usage of usages) {
    if (!byId.has(usage.shapeId)) continue;
    const list = grouped.get(usage.shapeId);
    if (list === undefined) grouped.set(usage.shapeId, [usage]);
    else list.push(usage);
  }

  const updates: ShapeUpdate[] = [];
  for (const [shapeId, list] of grouped) {
    const shape = byId.get(shapeId);
    if (shape === undefined) continue;
    const attrs: Record<string, unknown> = {};

    const fills = list.filter((usage) => usage.prop === "fill");
    if (fills.length > 0 && Array.isArray(shape.fills)) {
      const next = shape.fills.map((fill, position) => {
        const usage = fills.find((item) => item.index === position);
        if (usage === undefined) return fill;
        const record = recordOf(fill);
        if (record === null) return fill;
        const copy = { ...record };
        if (edit.color !== undefined) copy["fill-color"] = edit.color;
        if (edit.opacity !== undefined) copy["fill-opacity"] = clamp01(edit.opacity);
        return copy;
      });
      attrs.fills = next;
    }

    const strokes = list.filter((usage) => usage.prop === "stroke");
    if (strokes.length > 0 && Array.isArray(shape.strokes)) {
      const next = shape.strokes.map((stroke, position) => {
        const usage = strokes.find((item) => item.index === position);
        if (usage === undefined) return stroke;
        const record = recordOf(stroke);
        if (record === null) return stroke;
        const copy = { ...record };
        if (edit.color !== undefined) copy["stroke-color"] = edit.color;
        if (edit.opacity !== undefined) copy["stroke-opacity"] = clamp01(edit.opacity);
        return copy;
      });
      attrs.strokes = next;
    }

    const shadows = list.filter((usage) => usage.prop === "shadow");
    if (shadows.length > 0 && Array.isArray(shape.shadow)) {
      const next = shape.shadow.map((shadow, position) => {
        const usage = shadows.find((item) => item.index === position);
        if (usage === undefined) return shadow;
        const record = recordOf(shadow);
        if (record === null) return shadow;
        const color = { ...recordOf(record.color) };
        if (edit.color !== undefined) color.color = edit.color;
        if (edit.opacity !== undefined) color.opacity = clamp01(edit.opacity);
        return { ...record, color };
      });
      attrs.shadow = next;
    }

    if (Object.keys(attrs).length > 0) updates.push({ id: shapeId, attrs });
  }
  return updates;
}

// The shape ids a row would select, in first-use order and without repeats.
export function usageShapeIds(color: SelectedColor): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const usage of color.usages) {
    if (seen.has(usage.shapeId)) continue;
    seen.add(usage.shapeId);
    out.push(usage.shapeId);
  }
  return out;
}
