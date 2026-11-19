// app.wasm.enums: binds the enum table emitted by `render-wasm/build export`.
//
// `shared.js` ships next to the artifact and is not committed; the worker
// imports it and hands its exports here, which both checks for gaps and keeps
// the table for the serializers. The table maps a serializer key to the enum
// object from the generated build, so the numbers always match the artifact.

import { raise } from "../errors.js";

export type Serializers = Record<string, Record<string, number>>;

// The serializer key and the export name it comes from.
export const SERIALIZER_EXPORTS: ReadonlyArray<readonly [string, string]> = [
  ["raster-format", "RasterFormat"],
  ["blur-type", "RawBlurType"],
  ["blend-mode", "RawBlendMode"],
  ["bool-type", "RawBoolType"],
  ["font-style", "RawFontStyle"],
  ["flex-direction", "RawFlexDirection"],
  ["grid-direction", "RawGridDirection"],
  ["grow-type", "RawGrowType"],
  ["align-items", "RawAlignItems"],
  ["align-self", "RawAlignSelf"],
  ["align-content", "RawAlignContent"],
  ["justify-items", "RawJustifyItems"],
  ["justify-content", "RawJustifyContent"],
  ["justify-self", "RawJustifySelf"],
  ["wrap-type", "RawWrapType"],
  ["grid-track-type", "RawGridTrackType"],
  ["shadow-style", "RawShadowStyle"],
  ["guide-kind", "RawGuideKind"],
  ["stroke-style", "RawStrokeStyle"],
  ["stroke-cap", "RawStrokeCap"],
  ["shape-type", "RawShapeType"],
  ["constraint-h", "RawConstraintH"],
  ["constraint-v", "RawConstraintV"],
  ["sizing", "RawSizing"],
  ["vertical-align", "RawVerticalAlign"],
  ["fill-data", "RawFillData"],
  ["text-align", "RawTextAlign"],
  ["text-direction", "RawTextDirection"],
  ["text-decoration", "RawTextDecoration"],
  ["text-transform", "RawTextTransform"],
  ["multiple-state", "MultipleState"],
  ["transform-entry-kind", "RawTransformEntryKind"],
  ["segment-data", "RawSegmentData"],
  ["stroke-linecap", "RawStrokeLineCap"],
  ["stroke-linejoin", "RawStrokeLineJoin"],
  ["fill-rule", "RawFillRule"],
];

let table: Serializers | undefined;

// A stale shared.js leaves some keys undefined; that has to fail loudly or the
// serializers write zeroes into the design state.
export function initSerializers(next: Record<string, unknown>): void {
  const missing = Object.keys(next).filter((key) => next[key] === undefined);

  if (missing.length > 0) {
    raise({
      type: "internal",
      code: "stale-wasm-enums",
      hint: "stale or incomplete render-wasm shared.js",
      missing,
    });
  }

  table = next as Serializers;
}

export function serializers(): Serializers {
  if (table === undefined) {
    return raise({
      type: "internal",
      code: "wasm-enums-not-ready",
      hint: "render-wasm serializers are not registered",
    });
  }
  return table;
}

export function setSerializers(next: Serializers | undefined): void {
  table = next;
}

// Turns the module namespace of `shared.js` into the table the serializers use.
export function fromShared(shared: Record<string, unknown>): Serializers {
  const next: Record<string, unknown> = {};
  for (const [key, name] of SERIALIZER_EXPORTS) next[key] = shared[name];
  initSerializers(next);
  return serializers();
}
