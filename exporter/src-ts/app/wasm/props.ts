// app.common.render-wasm.api.props, Node side.
//
// The browser-free shape setters the exporter needs: fills, strokes, SVG
// attributes and path geometry. Records go through the shared byte layouts in
// `fills.js`/`path.js`; image bytes and font data stay host-specific and are
// provisioned separately by the driver.
//
// Mirrors `common/src/app/common/render_wasm/api/props.cljs`.

import { call } from "./call.js";
import {
  FILL_U8_SIZE,
  coerce,
  getByteSize,
  writeGradientFill,
  writeImageFill,
  writeSolidFill,
  writeTo,
  type Fill,
  type Fills,
} from "./fills.js";
import { dataView, heapU8, alloc } from "./memory.js";
import { setShapePathContent, type PathContent } from "./path.js";
import {
  translateFillRule,
  translateStrokeCap,
  translateStrokeLinecap,
  translateStrokeLinejoin,
  translateStrokeStyle,
} from "./serializers.js";
import { module, type WasmModule } from "../wasm.js";

export const STROKE_ALIGN_CENTER = 0;
export const STROKE_ALIGN_INNER = 1;
export const STROKE_ALIGN_OUTER = 2;

export interface ShapeSvgAttrs {
  style?: {
    fillRule?: string;
    strokeLinecap?: string;
    strokeLinejoin?: string;
    fill?: string;
    filter?: string;
    fillOpacity?: string | number;
  };
  fillRule?: string;
  strokeLinecap?: string;
  strokeLinejoin?: string;
  fill?: string;
  filter?: string;
  fillOpacity?: string | number;
}

export interface Stroke extends Fill {
  hidden?: boolean;
  "stroke-opacity"?: number;
  "stroke-color"?: string;
  "stroke-color-gradient"?: Fill["fill-color-gradient"];
  "stroke-image"?: Fill["fill-image"];
  "stroke-width"?: number;
  "stroke-style"?: string;
  "stroke-alignment"?: string;
  "stroke-cap-start"?: string;
  "stroke-cap-end"?: string;
  "stroke-dash"?: number;
  "stroke-gap"?: number;
  "stroke-width-top"?: number;
  "stroke-width-right"?: number;
  "stroke-width-bottom"?: number;
  "stroke-width-left"?: number;
}

// Writes the fill records and appends them to the current shape. Image bytes
// are the caller's job. Returns the coerced fills, or null when there was
// nothing to write.
export function writeShapeFills(
  fills: Fills | null | undefined,
  target: WasmModule = module(),
): Fills | null {
  if (fills === null || fills === undefined || fills.length === 0) {
    call(target, "_clear_shape_fills");
    return null;
  }

  const coerced = coerce(fills);
  const offset = alloc(target, getByteSize(coerced));
  writeTo(coerced, heapU8(target), offset);
  call(target, "_set_shape_fills");
  return coerced;
}

// Gradient wins over image, image over color — the order the editor's stroke
// setter uses, which differs from a fill's own resolution order.
function writeStrokeFill(view: DataView, offset: number, stroke: Stroke): number {
  const opacity = stroke["stroke-opacity"] ?? 1.0;
  const color = stroke["stroke-color"];
  const gradient = stroke["stroke-color-gradient"];
  const image = stroke["stroke-image"];

  if (gradient !== undefined) return writeGradientFill(view, offset, opacity, gradient);
  if (image !== undefined) return writeImageFill(view, offset, opacity, image);
  if (color !== undefined) return writeSolidFill(view, offset, opacity, color);

  // A stroke without paint still inserts an empty solid record, as CLJS does.
  return writeSolidFill(view, offset, 0.0, "#000000");
}

function strokeAlignment(alignment: string | undefined): number {
  if (alignment === "inner") return STROKE_ALIGN_INNER;
  if (alignment === "outer") return STROKE_ALIGN_OUTER;
  return STROKE_ALIGN_CENTER;
}

// Writes one 36-byte stroke header plus its fill record. Pure byte writing:
// only the batch upload uses it, for the strokes it inlines in a shape record.
export function writeStrokeData(view: DataView, offset: number, stroke: Stroke): number {
  const width = stroke["stroke-width"] ?? 1.0;
  const style = translateStrokeStyle(stroke["stroke-style"]) ?? 0;
  const align = strokeAlignment(stroke["stroke-alignment"]);
  const capStart = translateStrokeCap(stroke["stroke-cap-start"]) ?? 0;
  const capEnd = translateStrokeCap(stroke["stroke-cap-end"]) ?? 0;
  // -1 is the "unset" sentinel; the renderer then keeps its default pattern.
  const dash = stroke["stroke-dash"] ?? -1;
  const gap = stroke["stroke-gap"] ?? -1;

  const top = stroke["stroke-width-top"] ?? width;
  const right = stroke["stroke-width-right"] ?? width;
  const bottom = stroke["stroke-width-bottom"] ?? width;
  const left = stroke["stroke-width-left"] ?? width;

  view.setFloat32(offset, width, true);
  view.setUint8(offset + 4, style);
  view.setUint8(offset + 5, align);
  view.setUint8(offset + 6, capStart);
  view.setUint8(offset + 7, capEnd);
  view.setFloat32(offset + 8, dash, true);
  view.setFloat32(offset + 12, gap, true);
  view.setUint8(offset + 16, top !== right || top !== bottom || top !== left ? 1 : 0);
  view.setFloat32(offset + 20, top, true);
  view.setFloat32(offset + 24, right, true);
  view.setFloat32(offset + 28, bottom, true);
  view.setFloat32(offset + 32, left, true);

  return writeStrokeFill(view, offset + 36, stroke);
}

// The incremental setter: one FFI call sequence per stroke. The fill record
// goes in its own allocation because `_add_shape_stroke_fill` takes the whole
// buffer, so a packed multi-stroke block would strand every record after it.
function writeStroke(stroke: Stroke, target: WasmModule): void {
  const width = stroke["stroke-width"] ?? 1.0;
  const style = translateStrokeStyle(stroke["stroke-style"]) ?? 0;
  const align = strokeAlignment(stroke["stroke-alignment"]);
  const capStart = translateStrokeCap(stroke["stroke-cap-start"]) ?? 0;
  const capEnd = translateStrokeCap(stroke["stroke-cap-end"]) ?? 0;
  const dash = stroke["stroke-dash"] ?? -1;
  const gap = stroke["stroke-gap"] ?? -1;

  if (align === STROKE_ALIGN_INNER) {
    call(target, "_add_shape_inner_stroke", width, style, capStart, capEnd, dash, gap);
  } else if (align === STROKE_ALIGN_OUTER) {
    call(target, "_add_shape_outer_stroke", width, style, capStart, capEnd, dash, gap);
  } else {
    call(target, "_add_shape_center_stroke", width, style, capStart, capEnd, dash, gap);
  }

  const top = stroke["stroke-width-top"] ?? width;
  const right = stroke["stroke-width-right"] ?? width;
  const bottom = stroke["stroke-width-bottom"] ?? width;
  const left = stroke["stroke-width-left"] ?? width;
  if (top !== right || top !== bottom || top !== left) {
    call(target, "_set_shape_stroke_sides", top, right, bottom, left);
  }

  // A stroke without paint keeps the renderer default: no fill record, and so
  // no allocation either. The reader expects exactly one record per buffer.
  if (
    stroke["stroke-color"] === undefined &&
    stroke["stroke-color-gradient"] === undefined &&
    stroke["stroke-image"] === undefined
  ) {
    return;
  }

  const offset = alloc(target, FILL_U8_SIZE);
  writeStrokeFill(dataView(heapU8(target)), offset, stroke);
  call(target, "_add_shape_stroke_fill");
}

// Writes the stroke list of the current shape and returns the image ids the
// stroke fills reference, so the caller can provision their bytes.
export function writeShapeStrokes(
  strokes: readonly Stroke[] | null | undefined,
  target: WasmModule = module(),
): string[] {
  call(target, "_clear_shape_strokes");

  const imageIds: string[] = [];
  for (const stroke of strokes ?? []) {
    if (stroke.hidden) continue;

    writeStroke(stroke, target);
    const image = stroke["stroke-image"];
    if (image !== undefined) imageIds.push(image.id);
  }

  return imageIds;
}

export function setShapeSvgAttrs(attrs: ShapeSvgAttrs, target: WasmModule = module()): void {
  const style = attrs.style;
  const fillRule = translateFillRule(style?.fillRule ?? attrs.fillRule) ?? 0;
  const linecap = translateStrokeLinecap(style?.strokeLinecap ?? attrs.strokeLinecap) ?? 0;
  const linejoin = translateStrokeLinejoin(style?.strokeLinejoin ?? attrs.strokeLinejoin) ?? 0;
  const fillNone = (style?.fill ?? attrs.fill) === "none";

  call(target, "_set_shape_svg_attrs", fillRule, linecap, linejoin, fillNone);
}

export function setShapePath(content: PathContent, target: WasmModule = module()): void {
  setShapePathContent(content, target);
}
