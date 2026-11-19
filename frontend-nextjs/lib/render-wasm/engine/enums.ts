// The serializer enum table.
//
// app.common.render-wasm.enums builds this table from the Rust generator's
// `render_wasm_shared.js`, which the render-wasm build drops next to the
// artifact. The frontend artifact does not ship that file today (only the
// exporter build copies it), so the numbers are inlined here.
//
// The values are ABI constants: every name below is a Rust enum discriminant
// in render-wasm/src/enums.rs. When that file gains, drops or renumbers a
// variant, this table has to follow. enums.test.ts diffs it against any
// `render_wasm_shared.js` left in render-wasm/target, so a local build
// catches drift before it reaches a canvas.

// The two-sided map: serializer key -> enum export name.
export const SERIALIZER_EXPORTS = [
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
] as const;

export type SerializerKey = (typeof SERIALIZER_EXPORTS)[number][0];
export type EnumTable = Readonly<Record<string, number>>;
export type Serializers = Readonly<Record<SerializerKey, EnumTable>>;

export const SERIALIZERS: Serializers = {
  "raster-format": { png: 0, jpeg: 1, webp: 2 },
  "blur-type": { "layer-blur": 0, "background-blur": 1 },
  "blend-mode": {
    normal: 3,
    screen: 14,
    overlay: 15,
    darken: 16,
    lighten: 17,
    "color-dodge": 18,
    "color-burn": 19,
    "hard-light": 20,
    "soft-light": 21,
    difference: 22,
    exclusion: 23,
    multiply: 24,
    hue: 25,
    saturation: 26,
    color: 27,
    luminosity: 28,
  },
  "bool-type": { union: 0, difference: 1, intersection: 2, exclude: 3 },
  "font-style": { normal: 0, italic: 1 },
  "flex-direction": { row: 0, "row-reverse": 1, column: 2, "column-reverse": 3 },
  "grid-direction": { row: 0, column: 1 },
  "grow-type": { fixed: 0, "auto-width": 1, "auto-height": 2 },
  "align-items": { start: 0, end: 1, center: 2, stretch: 3 },
  "align-self": { none: 0, auto: 1, start: 2, end: 3, center: 4, stretch: 5 },
  "align-content": {
    start: 0,
    end: 1,
    center: 2,
    "space-between": 3,
    "space-around": 4,
    "space-evenly": 5,
    stretch: 6,
  },
  "justify-items": { start: 0, end: 1, center: 2, stretch: 3 },
  "justify-content": {
    start: 0,
    end: 1,
    center: 2,
    "space-between": 3,
    "space-around": 4,
    "space-evenly": 5,
    stretch: 6,
  },
  "justify-self": { none: 0, auto: 1, start: 2, end: 3, center: 4, stretch: 5 },
  "wrap-type": { wrap: 0, nowrap: 1 },
  "grid-track-type": { percent: 0, flex: 1, auto: 2, fixed: 3 },
  "shadow-style": { "drop-shadow": 0, "inner-shadow": 1 },
  "guide-kind": { vertical: 0, horizontal: 1 },
  "stroke-style": { solid: 0, dotted: 1, dashed: 2, mixed: 3 },
  "stroke-cap": {
    none: 0,
    "line-arrow": 1,
    "triangle-arrow": 2,
    "square-marker": 3,
    "circle-marker": 4,
    "diamond-marker": 5,
    round: 6,
    square: 7,
  },
  "shape-type": {
    frame: 0,
    group: 1,
    bool: 2,
    rect: 3,
    path: 4,
    text: 5,
    circle: 6,
    "svg-raw": 7,
  },
  "constraint-h": { none: 0, left: 1, right: 2, leftright: 3, center: 4, scale: 5 },
  "constraint-v": { none: 0, top: 1, bottom: 2, topbottom: 3, center: 4, scale: 5 },
  sizing: { fill: 0, fix: 1, auto: 2 },
  "vertical-align": { top: 0, center: 1, bottom: 2 },
  "fill-data": { solid: 0, linear: 1, radial: 2, image: 3 },
  "text-align": { left: 0, center: 1, right: 2, justify: 3 },
  "text-direction": { ltr: 0, rtl: 1 },
  "text-decoration": { none: 0, underline: 1, "line-through": 2, overline: 3 },
  "text-transform": { none: 0, uppercase: 1, lowercase: 2, capitalize: 3 },
  "multiple-state": { undefined: 0, single: 1, multiple: 2 },
  "transform-entry-kind": { parent: 0, child: 1 },
  "segment-data": { "move-to": 1, "line-to": 2, "curve-to": 3, close: 4 },
  "stroke-linecap": { butt: 0, round: 1, square: 2 },
  "stroke-linejoin": { miter: 0, round: 1, bevel: 2 },
  "fill-rule": { nonzero: 0, evenodd: 1 },
};

// The table the serializers read. A separate accessor keeps the call sites
// identical to the CLJS ones (`sr/serializers`) and leaves room for a
// per-build registration later without touching them.
export function serializers(): Serializers {
  return SERIALIZERS;
}
