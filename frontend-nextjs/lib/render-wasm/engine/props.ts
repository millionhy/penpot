// The browser-free shape setters of app.common.render-wasm.api.props.
//
// These only touch the FFI and the shared byte layouts, so they run the same
// in the browser and under Node. Setters that need a host data source (font
// bytes, image pixels, SVG static markup) stay in the caller and run through
// the `setObjects` hook.
//
// Buffer discipline (render-wasm/src/mem.rs): the artifact keeps ONE pending
// allocation. Every `_alloc_bytes` must be consumed by its setter or released
// with `_free_bytes` in the same synchronous task, and the heap views must be
// re-read after the allocation because growth detaches them.

import { call } from "./call";
import { hexToArgbU32 } from "./colors";
import {
  FILL_U8_SIZE,
  STROKE_HEADER_U8_SIZE,
  coerce,
  getByteSize,
  strokeAlignment,
  writeFills,
  writeGradientFill,
  writeImageFill,
  writeSolidFill,
  writeStrokeFill,
  type Fill,
  type Fills,
  type Stroke,
} from "./fills";
import { alloc, dataView, heapU8, heapU32 } from "./memory";
import type { RenderWasmModule } from "./module";
import {
  translateBlurType,
  translateBoolType,
  translateFillRule,
  translateGrowType,
  translateShadowStyle,
  translateStrokeCap,
  translateStrokeLinecap,
  translateStrokeLinejoin,
  translateStrokeStyle,
} from "./serializers";

// app.common.render-wasm.api.props/MAX-BUFFER-CHUNK-SIZE.
export const MAX_BUFFER_CHUNK_SIZE = 256 * 1024;

export interface Blur {
  hidden?: boolean;
  value?: number;
}

export interface Shadow {
  color?: { color: string; opacity?: number };
  blur?: number;
  spread?: number;
  "offset-x"?: number;
  "offset-y"?: number;
  style?: string;
  hidden?: boolean;
}

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

export type PathContent = Uint8Array | ArrayBuffer;

// --- effects and flags

export function setShapeBoolType(module: RenderWasmModule, boolType: string | null | undefined): void {
  call(module, "_set_shape_bool_type", translateBoolType(boolType));
}

export function setShapeGrowType(module: RenderWasmModule, growType: string | null | undefined): void {
  call(module, "_set_shape_grow_type", translateGrowType(growType));
}

export function setShapeBlur(module: RenderWasmModule, blur: Blur | null | undefined): void {
  const type = translateBlurType("layer-blur");
  if (blur === null || blur === undefined) {
    call(module, "_clear_shape_blur", type);
    return;
  }
  call(module, "_set_shape_blur", type, blur.hidden === true, blur.value ?? 0);
}

export function setShapeBackgroundBlur(
  module: RenderWasmModule,
  blur: Blur | null | undefined,
): void {
  const type = translateBlurType("background-blur");
  if (blur === null || blur === undefined) {
    call(module, "_clear_shape_blur", type);
    return;
  }
  call(module, "_set_shape_blur", type, blur.hidden === true, blur.value ?? 0);
}

export function setShapeShadows(module: RenderWasmModule, shadows: readonly Shadow[]): void {
  call(module, "_clear_shape_shadows");
  for (const shadow of shadows) {
    const color = shadow.color;
    const rgba = hexToArgbU32(color?.color ?? "#000000", color?.opacity);
    call(
      module,
      "_add_shape_shadow",
      rgba,
      shadow.blur ?? 0,
      shadow.spread ?? 0,
      shadow["offset-x"] ?? 0,
      shadow["offset-y"] ?? 0,
      translateShadowStyle(shadow.style),
      shadow.hidden === true,
    );
  }
}

export function setMasked(module: RenderWasmModule, masked: boolean): void {
  call(module, "_set_shape_masked_group", masked);
}

// --- fills and strokes

// Serializes the fill records for the CURRENT shape. Image bytes are the
// caller's job; it gets the coerced fills back to find the image ids.
export function writeShapeFills(
  module: RenderWasmModule,
  fills: Fills | null | undefined,
): Fills | null {
  if (fills === null || fills === undefined || fills.length === 0) {
    call(module, "_clear_shape_fills");
    return null;
  }

  const coerced = coerce(fills);
  const offset = alloc(module, getByteSize(coerced));
  writeFills(dataView(heapU8(module)), offset, coerced);
  call(module, "_set_shape_fills");
  return coerced;
}

function writeStroke(module: RenderWasmModule, stroke: Stroke): string | undefined {
  const width = stroke["stroke-width"] ?? 1.0;
  const style = translateStrokeStyle(stroke["stroke-style"]) ?? 0;
  const align = strokeAlignment(stroke["stroke-alignment"]);
  const capStart = translateStrokeCap(stroke["stroke-cap-start"]) ?? 0;
  const capEnd = translateStrokeCap(stroke["stroke-cap-end"]) ?? 0;
  // -1 is the "unset" sentinel; the renderer keeps its default pattern.
  const dash = stroke["stroke-dash"] ?? -1;
  const gap = stroke["stroke-gap"] ?? -1;

  // The fill record is written into the pending allocation, so it is taken
  // before the stroke call consumes anything else.
  const offset = alloc(module, FILL_U8_SIZE);
  const view = dataView(heapU8(module));

  if (align === 1) {
    call(module, "_add_shape_inner_stroke", width, style, capStart, capEnd, dash, gap);
  } else if (align === 2) {
    call(module, "_add_shape_outer_stroke", width, style, capStart, capEnd, dash, gap);
  } else {
    call(module, "_add_shape_center_stroke", width, style, capStart, capEnd, dash, gap);
  }

  const top = stroke["stroke-width-top"] ?? width;
  const right = stroke["stroke-width-right"] ?? width;
  const bottom = stroke["stroke-width-bottom"] ?? width;
  const left = stroke["stroke-width-left"] ?? width;
  if (top !== right || top !== bottom || top !== left) {
    call(module, "_set_shape_stroke_sides", top, right, bottom, left);
  }

  const image = stroke["stroke-image"];
  if (
    stroke["stroke-color"] === undefined &&
    stroke["stroke-color-gradient"] === undefined &&
    image === undefined
  ) {
    // A stroke without paint keeps the renderer default; the allocation is
    // released so the next stroke can take it.
    call(module, "_free_bytes");
    return undefined;
  }

  writeStrokeFill(view, offset, stroke);
  call(module, "_add_shape_stroke_fill");
  return image?.id;
}

// Writes the stroke list of the CURRENT shape. Returns the image ids its
// stroke fills reference, so the caller can provision their bytes.
export function writeShapeStrokes(
  module: RenderWasmModule,
  strokes: readonly Stroke[] | null | undefined,
): string[] {
  call(module, "_clear_shape_strokes");

  const imageIds: string[] = [];
  for (const stroke of strokes ?? []) {
    if (stroke.hidden === true) continue;
    const imageId = writeStroke(module, stroke);
    if (imageId !== undefined) imageIds.push(imageId);
  }
  return imageIds;
}

// Writes one 36-byte stroke header plus its fill record. Pure byte writing:
// only the batch upload uses it, to inline strokes in a shape record.
export function writeStrokeData(view: DataView, offset: number, stroke: Stroke): number {
  const width = stroke["stroke-width"] ?? 1.0;
  const style = translateStrokeStyle(stroke["stroke-style"]) ?? 0;
  const align = strokeAlignment(stroke["stroke-alignment"]);
  const capStart = translateStrokeCap(stroke["stroke-cap-start"]) ?? 0;
  const capEnd = translateStrokeCap(stroke["stroke-cap-end"]) ?? 0;
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

  return writeStrokeFill(view, offset + STROKE_HEADER_U8_SIZE, stroke);
}

// --- svg attrs and path geometry

export function setShapeSvgAttrs(module: RenderWasmModule, attrs: ShapeSvgAttrs): void {
  const style = attrs.style;
  const fillRule = translateFillRule(style?.fillRule ?? attrs.fillRule) ?? 0;
  const linecap = translateStrokeLinecap(style?.strokeLinecap ?? attrs.strokeLinecap) ?? 0;
  const linejoin = translateStrokeLinejoin(style?.strokeLinejoin ?? attrs.strokeLinejoin) ?? 0;
  const fillNone = (style?.fill ?? attrs.fill) === "none";
  call(module, "_set_shape_svg_attrs", fillRule, linecap, linejoin, fillNone);
}

export function setShapeSvgRawContent(module: RenderWasmModule, content: string): void {
  const size = content.length + 1;
  const offset = alloc(module, size);
  call(module, "stringToUTF8", content, offset, size);
  call(module, "_set_shape_svg_raw_content");
}

// The chunked path upload: pad to 4 bytes, copy 256 KiB at a time and let the
// trailing call rebuild the current shape's segments from the buffer.
export function setShapePathContent(module: RenderWasmModule, content: PathContent): void {
  const bytes = content instanceof Uint8Array ? content : new Uint8Array(content);
  const paddedLength = Math.ceil(bytes.byteLength / 4) * 4;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);

  call(module, "_start_shape_path_buffer");
  for (let offset = 0; offset < paddedLength; offset += MAX_BUFFER_CHUNK_SIZE) {
    const end = Math.min(offset + MAX_BUFFER_CHUNK_SIZE, paddedLength);
    const chunk = padded.subarray(offset, end);
    const words = new Uint32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >>> 2);
    const heapOffset = offset32Of(alloc(module, chunk.byteLength));
    // Re-read after the allocation: growth detaches the previous view.
    heapU32(module).set(words, heapOffset);
    call(module, "_set_shape_path_chunk_buffer");
  }
  call(module, "_set_shape_path_buffer");
}

function offset32Of(byteOffset: number): number {
  return byteOffset >>> 2;
}

// Re-exported for the callers that build stroke lists from a shape.
export type { Fill, Fills, Stroke };