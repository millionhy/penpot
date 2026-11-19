// app.common.render-wasm.serializers, Node side.
//
// Every enum the serializer writes comes from the table `shared.js` exports
// (registered through `./enums.js`), so the numbers always match the built
// artifact. Values arrive from transit as plain strings, which is why `nameOf`
// is just the string itself; tests may also pass the keyword-like form.
//
// Mirrors `common/src/app/common/render_wasm/serializers.cljs`. Functions that
// only the browser workspace uses (guides, browser detection, structure
// modifiers) stay there until the exporter needs them.

import { raise } from "../errors.js";
import { serializers } from "./enums.js";

export type EnumValue = string | number | null | undefined;

// `d/name` for the string keywords transit decodes to.
export function nameOf(value: EnumValue): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function values(key: string): Record<string, number> {
  return serializers()[key] ?? {};
}

function translate(key: string, value: EnumValue, fallback: string): number | undefined {
  const table = values(key);
  return table[nameOf(value)] ?? table[fallback];
}

// Hex color plus opacity -> the 0xAARRGGBB word the Rust side reads.
export function hexToU32Argb(hex: string, opacity: number | undefined): number {
  const rgb = Number.parseInt(hex.slice(1), 16);
  const alpha = Math.floor((opacity ?? 1) * 0xff);
  return ((alpha << 24) | rgb) >>> 0;
}

// --- SHAPES

export function translateShapeType(type: EnumValue): number | undefined {
  return translate("shape-type", type, "rect");
}

export function translateBlendMode(mode: EnumValue): number | undefined {
  return translate("blend-mode", mode, "normal");
}

export function translateConstraintH(type: EnumValue): number | undefined {
  return translate("constraint-h", type, "none");
}

export function translateConstraintV(type: EnumValue): number | undefined {
  return translate("constraint-v", type, "none");
}

export function translateBoolType(type: EnumValue): number | undefined {
  return translate("bool-type", type, "union");
}

export function translateBlurType(type: EnumValue): number | undefined {
  return translate("blur-type", type, "layer-blur");
}

export function translateGrowType(type: EnumValue): number | undefined {
  return translate("grow-type", type, "fixed");
}

export function translateShadowStyle(style: EnumValue): number | undefined {
  return translate("shadow-style", style, "drop-shadow");
}

// --- STROKES

export function translateStrokeStyle(style: EnumValue): number | undefined {
  return translate("stroke-style", style, "solid");
}

export function translateStrokeCap(cap: EnumValue): number | undefined {
  return translate("stroke-cap", cap, "none");
}

export function translateStrokeLinecap(cap: EnumValue): number | undefined {
  return translate("stroke-linecap", cap, "butt");
}

export function translateStrokeLinejoin(join: EnumValue): number | undefined {
  return translate("stroke-linejoin", join, "miter");
}

export function translateFillRule(rule: EnumValue): number | undefined {
  return translate("fill-rule", rule, "nonzero");
}

// --- LAYOUT

export function translateLayoutFlexDir(dir: EnumValue): number | undefined {
  return values("flex-direction")[nameOf(dir)];
}

export function translateLayoutGridDir(dir: EnumValue): number | undefined {
  return values("grid-direction")[nameOf(dir)];
}

export function translateLayoutAlignItems(value: EnumValue): number | undefined {
  return translate("align-items", value, "start");
}

export function translateLayoutAlignContent(value: EnumValue): number | undefined {
  return translate("align-content", value, "stretch");
}

export function translateLayoutJustifyItems(value: EnumValue): number | undefined {
  return translate("justify-items", value, "start");
}

export function translateLayoutJustifyContent(value: EnumValue): number | undefined {
  return translate("justify-content", value, "stretch");
}

export function translateLayoutWrapType(value: EnumValue): number | undefined {
  return translate("wrap-type", value, "nowrap");
}

export function translateGridTrackType(type: EnumValue): number | undefined {
  return values("grid-track-type")[nameOf(type)];
}

export function translateLayoutSizing(value: EnumValue): number | undefined {
  return translate("sizing", value, "fix");
}

export function translateAlignSelf(value: EnumValue): number | undefined {
  return translate("align-self", value, "none");
}

export function translateJustifySelf(value: EnumValue): number | undefined {
  return translate("justify-self", value, "none");
}

export function translateTransformEntryKind(kind: EnumValue): number | undefined {
  return translate("transform-entry-kind", kind, "parent");
}

export function translateMultipleState(state: EnumValue): number | undefined {
  return translate("multiple-state", state, "undefined");
}

// --- TEXT

export function translateVerticalAlign(value: EnumValue): number | undefined {
  return translate("vertical-align", value, "top");
}

export function translateTextAlign(value: EnumValue): number | undefined {
  return translate("text-align", value, "left");
}

export function translateTextTransform(value: EnumValue): number | undefined {
  return translate("text-transform", value, "none");
}

export function translateTextDecoration(value: EnumValue): number | undefined {
  return translate("text-decoration", value, "none");
}

export function translateTextDirection(value: EnumValue): number | undefined {
  return translate("text-direction", value, "ltr");
}

export function translateFontStyle(style: EnumValue): number | undefined {
  const table = values("font-style");
  switch (style) {
    // NOTE: normal == regular, matching the CLJS model.
    case "normal":
    case "regular":
      return table.normal;
    case "italic":
      return table.italic;
    default:
      return table.normal;
  }
}

// --- RENDER

// Export format string -> RasterFormat code. No default on purpose: falling
// back to png would write png bytes under a jpeg/webp mtype.
export function translateRasterFormat(format: string): number {
  const code = values("raster-format")[format];
  if (code === undefined) {
    return raise({
      type: "internal",
      code: "unsupported-raster-format",
      hint: `unsupported raster format: ${format}`,
      format,
    });
  }
  return code;
}

// Numeric discriminant -> enum name, for values crossing back from wasm.
// A string (the keyword transit decoded) passes through untouched.
const reverseTables = new Map<string, Map<number, string>>();

export function untranslate(key: string, value: EnumValue, fallback: string): string | number | undefined {
  if (typeof value === "string") return value;

  let reverse = reverseTables.get(key);
  if (reverse === undefined) {
    reverse = new Map();
    for (const [name, code] of Object.entries(values(key))) reverse.set(code, name);
    reverseTables.set(key, reverse);
  }

  if (value === null || value === undefined) return fallback;
  return reverse.get(Number(value)) ?? fallback;
}
