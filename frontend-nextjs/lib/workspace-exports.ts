// The exports menu of the workspace style panel (F9.14): the export specs of
// a shape (its :exports vector) and the pure surgery behind the rows.
//
// Ported from:
// - common/src/app/common/types/shape/export.cljc (schema:export: a type, a
//   positive scale and a suffix);
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/exports.cljs
//   (add-export appends {:type :png :suffix "" :scale 1}, delete-export
//   splices by index, and the scale select only shows for the bitmap types).
//
// Deviations from the CLJS original, documented (AD12):
// - The download button is not wired: the render-wasm build ships no export
//   entry point, so the panel edits the specs and shows the button disabled.
// - A multi selection keeps the batch read-only; the single-shape menu owns
//   the rows.

import type { WorkspaceShape } from "@/lib/workspace";

export type ExportType = "png" | "jpeg" | "webp" | "svg" | "pdf";

export interface ExportSpec {
  type: ExportType;
  // positive number; the select offers the catalog steps.
  scale: number;
  suffix: string;
}

const TYPES = new Set<string>(["png", "jpeg", "webp", "svg", "pdf"]);

// The format select, in the CLJS order and labels.
export const EXPORT_TYPES: readonly { value: ExportType; label: string }[] = [
  { value: "png", label: "PNG" },
  { value: "jpeg", label: "JPG" },
  { value: "webp", label: "WEBP" },
  { value: "svg", label: "SVG" },
  { value: "pdf", label: "PDF" },
];

// The size select of the bitmap formats.
export const EXPORT_SCALES: readonly { value: string; label: string }[] = [
  { value: "0.5", label: "0.5x" },
  { value: "0.75", label: "0.75x" },
  { value: "1", label: "1x" },
  { value: "1.5", label: "1.5x" },
  { value: "2", label: "2x" },
  { value: "3", label: "3x" },
  { value: "4", label: "4x" },
  { value: "6", label: "6x" },
];

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function cloneSpec(spec: ExportSpec): ExportSpec {
  return { ...spec };
}

// The :exports of a shape, sanitized; an unknown type or a non-positive
// scale drops the row instead of breaking the panel.
export function exportsOf(shape: WorkspaceShape): ExportSpec[] {
  const exports = shape["exports"];
  if (!Array.isArray(exports)) return [];
  const out: ExportSpec[] = [];
  for (const item of exports) {
    const record = recordOf(item);
    if (record === null) continue;
    const type = record.type;
    if (typeof type !== "string" || !TYPES.has(type)) continue;
    const scale = record.scale;
    const suffix = record.suffix;
    out.push({
      type: type as ExportType,
      scale: typeof scale === "number" && Number.isFinite(scale) && scale > 0 ? scale : 1,
      suffix: typeof suffix === "string" ? suffix : "",
    });
  }
  return out;
}

// dwsh/add-export: the default spec of the add button.
export function newExport(): ExportSpec {
  return { type: "png", scale: 1, suffix: "" };
}

export function addExport(exports: readonly ExportSpec[]): ExportSpec[] {
  return [...exports.map(cloneSpec), newExport()];
}

export function removeExport(
  exports: readonly ExportSpec[],
  index: number,
): ExportSpec[] {
  return exports.filter((_, position) => position !== index).map(cloneSpec);
}

// The format select: an unknown value keeps the stored type. A switch to a
// vector format keeps the scale on the model (schema:export requires a
// positive one) while the row hides it.
export function withExportType(
  exports: readonly ExportSpec[],
  index: number,
  type: string,
): ExportSpec[] {
  if (!TYPES.has(type)) return exports.map(cloneSpec);
  return exports.map((spec, position) =>
    position === index ? { ...spec, type: type as ExportType } : spec,
  );
}

export function withExportScale(
  exports: readonly ExportSpec[],
  index: number,
  scale: number,
): ExportSpec[] {
  if (!Number.isFinite(scale) || scale <= 0) return exports.map(cloneSpec);
  return exports.map((spec, position) =>
    position === index ? { ...spec, scale } : spec,
  );
}

export function withExportSuffix(
  exports: readonly ExportSpec[],
  index: number,
  suffix: string,
): ExportSpec[] {
  return exports.map((spec, position) =>
    position === index ? { ...spec, suffix } : spec,
  );
}

// The scale select only applies to the bitmap formats.
export function scaleEnabled(spec: ExportSpec): boolean {
  return spec.type === "png" || spec.type === "jpeg" || spec.type === "webp";
}

// The :exports attribute a commit sends; the empty list clears the attr the
// same way the CLJS remove-all does.
export function exportPatch(exports: readonly ExportSpec[]): ExportSpec[] {
  return exports.map(cloneSpec);
}
