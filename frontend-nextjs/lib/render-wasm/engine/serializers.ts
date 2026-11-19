// The enum translators of app.common.render-wasm.serializers.
//
// The tables live in `enums.ts`; this file is the call-site layer that keeps
// the compiled names (`translateBlendMode`, `translateShapeType`, ...) and
// hides the two lookup shapes: some tables have a default value, some answer
// undefined so the caller keeps its own sentinel.
//
// Values arrive from the model as plain strings (`"frame"`, `"drop-shadow"`),
// never keywords, so `nameOf` is a string cast with a nil guard.

import { serializers } from "./enums";

export type EnumValue = string | number | null | undefined;

export function nameOf(value: EnumValue): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function values(key: string): Readonly<Record<string, number>> {
  const table = serializers() as Readonly<Record<string, Readonly<Record<string, number>>>>;
  return table[key] ?? {};
}

function translate(key: string, value: EnumValue, fallback: string): number | undefined {
  const table = values(key);
  return table[nameOf(value)] ?? table[fallback];
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

// Structure modifiers have no Rust enum yet (the CLJS side carries a `case`).
export function translateStructureModifierType(type: EnumValue): number | undefined {
  switch (nameOf(type)) {
    case "remove-children":
      return 1;
    case "add-children":
      return 2;
    case "scale-content":
      return 3;
    default:
      return undefined;
  }
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
  // NOTE: normal == regular, matching the CLJS model.
  return style === "italic" ? table.italic : table.normal;
}

// --- GUIDES

export function translateGuideKind(kind: EnumValue): number | undefined {
  return translate("guide-kind", kind, "vertical");
}