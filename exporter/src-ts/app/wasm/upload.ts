// app.common.render-wasm.api.upload, Node side.
//
// The enlarged per-shape structural upload consumed by `_set_shapes_batch`: a
// 104-byte base record, a section mask, then the base properties' children,
// blur, shadows, layout, fills and strokes in the fixed order the Rust reader
// expects. Each shape becomes one length-prefixed record inside a single
// `_set_shapes_batch` allocation, which the module consumes itself.
//
// Mirrors `common/src/app/common/render_wasm/api/upload.cljs`.

import { raise } from "../errors.js";
import { getU32, isUuid, zero } from "../uuid.js";
import { call } from "./call.js";
import { FILL_U8_SIZE, coerce, getByteSize, writeTo, type Fills } from "./fills.js";
import { alloc, dataView, heapU8 } from "./memory.js";
import {
  hexToU32Argb,
  translateAlignSelf,
  translateBlendMode,
  translateBoolType,
  translateConstraintH,
  translateConstraintV,
  translateGrowType,
  translateLayoutAlignContent,
  translateLayoutAlignItems,
  translateLayoutFlexDir,
  translateLayoutJustifyContent,
  translateLayoutJustifyItems,
  translateLayoutSizing,
  translateLayoutWrapType,
  translateShadowStyle,
  translateShapeType,
} from "./serializers.js";
import { writeStrokeData, type ShapeSvgAttrs, type Stroke } from "./props.js";
import { module, type WasmModule } from "../wasm.js";

export const BASE_PROPS_U8_SIZE = 104;
export const FLAG_CLIP_CONTENT = 0x01;
export const FLAG_HIDDEN = 0x02;

export const SECTION_CHILDREN = 0x01;
export const SECTION_BLUR_LAYER = 0x02;
export const SECTION_BLUR_BG = 0x04;
export const SECTION_SHADOWS = 0x08;
export const SECTION_MASKED = 0x10;
export const SECTION_BOOL_TYPE = 0x20;
export const SECTION_GROW_TYPE = 0x40;
export const SECTION_LAYOUT_ITEM = 0x80;
export const SECTION_FLEX = 0x100;
export const SECTION_FILLS = 0x200;
export const SECTION_STROKES = 0x400;

// Stroke header before the fill record (must match upload_batch.rs).
export const STROKE_HEADER_U8_SIZE = 36;

export interface Shadow {
  color?: { color: string; opacity?: number };
  blur?: number;
  spread?: number;
  "offset-x"?: number;
  "offset-y"?: number;
  style?: string;
  hidden?: boolean;
}

export interface Blur {
  hidden?: boolean;
  value?: number;
}

export interface Shape {
  id: string;
  type: string;
  "parent-id"?: string;
  "show-content"?: boolean;
  hidden?: boolean;
  "blend-mode"?: string;
  "constraints-h"?: string;
  "constraints-v"?: string;
  opacity?: number;
  rotation?: number;
  transform?: {
    a?: number;
    b?: number;
    c?: number;
    d?: number;
    e?: number;
    f?: number;
  };
  selrect?: { x1?: number; y1?: number; x2?: number; y2?: number };
  r1?: number;
  r2?: number;
  r3?: number;
  r4?: number;
  shapes?: readonly string[];
  blur?: Blur | null;
  "background-blur"?: Blur | null;
  shadow?: readonly Shadow[];
  "masked-group"?: boolean;
  "bool-type"?: string | null;
  "grow-type"?: string | null;
  layout?: string;
  "layout-flex-dir"?: string;
  "layout-gap"?: { "row-gap"?: number; "column-gap"?: number };
  "layout-align-items"?: string;
  "layout-align-content"?: string;
  "layout-justify-items"?: string;
  "layout-justify-content"?: string;
  "layout-wrap-type"?: string;
  "layout-padding"?: { p1?: number; p2?: number; p3?: number; p4?: number };
  "layout-item-margin"?: { m1?: number; m2?: number; m3?: number; m4?: number };
  "layout-item-h-sizing"?: string;
  "layout-item-v-sizing"?: string;
  "layout-item-align-self"?: string;
  "layout-item-max-h"?: number;
  "layout-item-min-h"?: number;
  "layout-item-max-w"?: number;
  "layout-item-min-w"?: number;
  "layout-item-absolute"?: boolean;
  "layout-item-z-index"?: number;
  fills?: Fills;
  strokes?: readonly Stroke[];
  content?: unknown;
  "svg-attrs"?: ShapeSvgAttrs;
}

export interface UploadOptions {
  includeLayout?: boolean;
  includeFillsStrokes?: boolean;
}

function writeUuid(view: DataView, offset: number, id: string): number {
  const quartet = getU32(id);
  for (let index = 0; index < 4; index += 1) {
    view.setUint32(offset + index * 4, quartet[index], true);
  }
  return offset + 16;
}

function isFlexLayout(shape: Shape): boolean {
  return shape.type === "frame" && shape.layout === "flex";
}

function writeBaseProps(view: DataView, offset: number, shape: Shape): number {
  const clipContent = shape.type === "frame" && shape["show-content"] !== true;
  const hidden = shape.hidden === true;
  const flags = (clipContent ? FLAG_CLIP_CONTENT : 0) | (hidden ? FLAG_HIDDEN : 0);
  const blendMode = translateBlendMode(shape["blend-mode"]) ?? 0;
  const constraintH = translateConstraintH(shape["constraints-h"] ?? "none") ?? 0;
  const constraintV = translateConstraintV(shape["constraints-v"] ?? "none") ?? 0;
  const opacity = shape.opacity ?? 1.0;
  const rotation = shape.rotation ?? 0.0;

  const transform = shape.transform;
  const [ta, tb, tc, td, te, tf] =
    transform === undefined
      ? [1.0, 0.0, 0.0, 1.0, 0.0, 0.0]
      : [
          transform.a ?? 0,
          transform.b ?? 0,
          transform.c ?? 0,
          transform.d ?? 0,
          transform.e ?? 0,
          transform.f ?? 0,
        ];

  const selrect = shape.selrect;
  const [sx1, sy1, sx2, sy2] =
    selrect === undefined
      ? [0.0, 0.0, 0.0, 0.0]
      : [selrect.x1 ?? 0, selrect.y1 ?? 0, selrect.x2 ?? 0, selrect.y2 ?? 0];

  writeUuid(view, offset, shape.id);
  writeUuid(view, offset + 16, shape["parent-id"] ?? zero);
  view.setUint8(offset + 32, translateShapeType(shape.type) ?? 0);
  view.setUint8(offset + 33, flags);
  view.setUint8(offset + 34, blendMode);
  view.setUint8(offset + 35, constraintH);
  view.setUint8(offset + 36, constraintV);
  view.setFloat32(offset + 40, opacity, true);
  view.setFloat32(offset + 44, rotation, true);
  view.setFloat32(offset + 48, ta, true);
  view.setFloat32(offset + 52, tb, true);
  view.setFloat32(offset + 56, tc, true);
  view.setFloat32(offset + 60, td, true);
  view.setFloat32(offset + 64, te, true);
  view.setFloat32(offset + 68, tf, true);
  view.setFloat32(offset + 72, sx1, true);
  view.setFloat32(offset + 76, sy1, true);
  view.setFloat32(offset + 80, sx2, true);
  view.setFloat32(offset + 84, sy2, true);
  view.setFloat32(offset + 88, shape.r1 ?? 0.0, true);
  view.setFloat32(offset + 92, shape.r2 ?? 0.0, true);
  view.setFloat32(offset + 96, shape.r3 ?? 0.0, true);
  view.setFloat32(offset + 100, shape.r4 ?? 0.0, true);
  return offset + BASE_PROPS_U8_SIZE;
}

function writeBlur(view: DataView, offset: number, blur: Blur): number {
  view.setUint8(offset, blur.hidden === true ? 1 : 0);
  view.setFloat32(offset + 4, blur.value ?? 0, true);
  return offset + 8;
}

function writeShadow(view: DataView, offset: number, shadow: Shadow): number {
  const color = shadow.color;
  view.setUint32(offset, hexToU32Argb(color?.color ?? "#000000", color?.opacity), true);
  view.setFloat32(offset + 4, shadow.blur ?? 0, true);
  view.setFloat32(offset + 8, shadow.spread ?? 0, true);
  view.setFloat32(offset + 12, shadow["offset-x"] ?? 0, true);
  view.setFloat32(offset + 16, shadow["offset-y"] ?? 0, true);
  view.setUint8(offset + 20, translateShadowStyle(shadow.style) ?? 0);
  view.setUint8(offset + 21, shadow.hidden === true ? 1 : 0);
  return offset + 24;
}

function writeFlex(view: DataView, offset: number, shape: Shape): number {
  const dir = translateLayoutFlexDir(shape["layout-flex-dir"] ?? "row") ?? 0;
  const gap = shape["layout-gap"];
  const padding = shape["layout-padding"];

  view.setUint8(offset, dir);
  view.setUint8(offset + 1, translateLayoutAlignItems(shape["layout-align-items"]) ?? 0);
  view.setUint8(offset + 2, translateLayoutAlignContent(shape["layout-align-content"]) ?? 0);
  view.setUint8(offset + 3, translateLayoutJustifyItems(shape["layout-justify-items"]) ?? 0);
  view.setUint8(offset + 4, translateLayoutJustifyContent(shape["layout-justify-content"]) ?? 0);
  view.setUint8(offset + 5, translateLayoutWrapType(shape["layout-wrap-type"]) ?? 0);
  view.setFloat32(offset + 8, gap?.["row-gap"] ?? 0, true);
  view.setFloat32(offset + 12, gap?.["column-gap"] ?? 0, true);
  view.setFloat32(offset + 16, padding?.p1 ?? 0, true);
  view.setFloat32(offset + 20, padding?.p2 ?? 0, true);
  view.setFloat32(offset + 24, padding?.p3 ?? 0, true);
  view.setFloat32(offset + 28, padding?.p4 ?? 0, true);
  return offset + 32;
}

function writeLayoutItem(view: DataView, offset: number, shape: Shape): number {
  const margins = shape["layout-item-margin"];
  const maxH = shape["layout-item-max-h"];
  const minH = shape["layout-item-min-h"];
  const maxW = shape["layout-item-max-w"];
  const minW = shape["layout-item-min-w"];

  const flags =
    (maxH === undefined ? 0 : 0x01) |
    (minH === undefined ? 0 : 0x02) |
    (maxW === undefined ? 0 : 0x04) |
    (minW === undefined ? 0 : 0x08) |
    (shape["layout-item-absolute"] === true ? 0x10 : 0);

  view.setFloat32(offset, margins?.m1 ?? 0, true);
  view.setFloat32(offset + 4, margins?.m2 ?? 0, true);
  view.setFloat32(offset + 8, margins?.m3 ?? 0, true);
  view.setFloat32(offset + 12, margins?.m4 ?? 0, true);
  view.setUint8(offset + 16, translateLayoutSizing(shape["layout-item-h-sizing"]) ?? 0);
  view.setUint8(offset + 17, translateLayoutSizing(shape["layout-item-v-sizing"]) ?? 0);
  view.setUint8(offset + 18, flags);
  view.setUint8(offset + 19, translateAlignSelf(shape["layout-item-align-self"]) ?? 0);
  view.setFloat32(offset + 20, maxH ?? 0, true);
  view.setFloat32(offset + 24, minH ?? 0, true);
  view.setFloat32(offset + 28, maxW ?? 0, true);
  view.setFloat32(offset + 32, minW ?? 0, true);
  view.setInt32(offset + 36, shape["layout-item-z-index"] ?? 0, true);
  return offset + 40;
}

// Same layout as `_set_shape_fills`: a one-byte count, three pad bytes, then
// the records.
function writeFillsSection(view: DataView, offset: number, fills: Fills | undefined): number {
  const coerced = coerce(fills ?? []);
  writeTo(coerced, new Uint8Array(view.buffer, view.byteOffset, view.byteLength), offset);
  return offset + getByteSize(coerced);
}

function visibleStrokes(shape: Shape): readonly Stroke[] {
  if (shape.type === "group") return [];
  return (shape.strokes ?? []).filter((stroke) => !stroke.hidden);
}

function writeStrokesSection(view: DataView, offset: number, strokes: readonly Stroke[]): number {
  view.setUint32(offset, strokes.length, true);
  let at = offset + 4;
  for (const stroke of strokes) at = writeStrokeData(view, at, stroke);
  return at;
}

function childrenOf(shape: Shape): string[] {
  return (shape.shapes ?? []).filter((id): id is string => typeof id === "string" && isUuid(id));
}

// Serializes one shape's structural payload at `offset` (payload only, no
// length prefix). Returns the offset after the payload.
export function writeShapePayload(
  view: DataView,
  offset: number,
  shape: Shape,
  options: UploadOptions = {},
): number {
  const includeLayout = options.includeLayout === true;
  const includeFillsStrokes = options.includeFillsStrokes === true;

  const children = childrenOf(shape);
  const blur = shape.blur;
  const backgroundBlur = shape["background-blur"];
  const shadows = shape.shadow ?? [];
  const masked = shape.type === "group" && shape["masked-group"] === true;
  const boolType = shape.type === "bool" ? shape["bool-type"] : undefined;
  const growType = shape.type === "text" ? shape["grow-type"] : undefined;
  const flex = includeLayout && isFlexLayout(shape);
  const strokes = includeFillsStrokes ? visibleStrokes(shape) : [];

  let mask = SECTION_CHILDREN;
  if (blur !== undefined && blur !== null) mask |= SECTION_BLUR_LAYER;
  if (backgroundBlur !== undefined && backgroundBlur !== null) mask |= SECTION_BLUR_BG;
  if (shadows.length > 0) mask |= SECTION_SHADOWS;
  if (shape.type === "group") mask |= SECTION_MASKED;
  if (boolType !== undefined && boolType !== null) mask |= SECTION_BOOL_TYPE;
  if (growType !== undefined && growType !== null) mask |= SECTION_GROW_TYPE;
  if (flex) mask |= SECTION_FLEX;
  if (includeLayout) mask |= SECTION_LAYOUT_ITEM;
  if (includeFillsStrokes) mask |= SECTION_FILLS | SECTION_STROKES;

  let at = writeBaseProps(view, offset, shape);
  view.setUint32(at, mask, true);
  at += 4;

  view.setUint32(at, children.length, true);
  at += 4;
  for (const id of children) at = writeUuid(view, at, id);

  if (blur !== undefined && blur !== null) at = writeBlur(view, at, blur);
  if (backgroundBlur !== undefined && backgroundBlur !== null) {
    at = writeBlur(view, at, backgroundBlur);
  }

  if (shadows.length > 0) {
    view.setUint32(at, shadows.length, true);
    at += 4;
    for (const shadow of shadows) at = writeShadow(view, at, shadow);
  }

  if (shape.type === "group") {
    view.setUint8(at, masked ? 1 : 0);
    at += 4;
  }

  if (boolType !== undefined && boolType !== null) {
    view.setUint8(at, translateBoolType(boolType) ?? 0);
    at += 4;
  }

  if (growType !== undefined && growType !== null) {
    view.setUint8(at, translateGrowType(growType) ?? 0);
    at += 4;
  }

  // FLEX before LAYOUT-ITEM: the Rust reader clears the layout on flex.
  if (flex) at = writeFlex(view, at, shape);
  if (includeLayout) at = writeLayoutItem(view, at, shape);
  if (includeFillsStrokes) at = writeFillsSection(view, at, shape.fills);
  if (includeFillsStrokes) at = writeStrokesSection(view, at, strokes);

  return at;
}

export function payloadByteSize(shape: Shape, options: UploadOptions = {}): number {
  const includeLayout = options.includeLayout === true;
  const includeFillsStrokes = options.includeFillsStrokes === true;

  const children = childrenOf(shape);
  const shadows = shape.shadow ?? [];
  const blur = shape.blur;
  const backgroundBlur = shape["background-blur"];
  const flex = includeLayout && isFlexLayout(shape);
  const fillsSize = includeFillsStrokes ? getByteSize(coerce(shape.fills ?? [])) : 0;
  const strokes = includeFillsStrokes ? visibleStrokes(shape) : [];
  const strokesSize = includeFillsStrokes
    ? 4 + strokes.length * (STROKE_HEADER_U8_SIZE + FILL_U8_SIZE)
    : 0;

  return (
    BASE_PROPS_U8_SIZE +
    4 + // mask
    (4 + 16 * children.length) +
    (blur !== undefined && blur !== null ? 8 : 0) +
    (backgroundBlur !== undefined && backgroundBlur !== null ? 8 : 0) +
    (shadows.length > 0 ? 4 + 24 * shadows.length : 0) +
    (shape.type === "group" ? 4 : 0) +
    (shape.type === "bool" && shape["bool-type"] !== null && shape["bool-type"] !== undefined ? 4 : 0) +
    (shape.type === "text" && shape["grow-type"] !== null && shape["grow-type"] !== undefined ? 4 : 0) +
    (flex ? 32 : 0) +
    (includeLayout ? 40 : 0) +
    fillsSize +
    strokesSize
  );
}

// One `[u32 payload_len][payload]` record. The writer and the size estimator
// must agree exactly; a mismatch would shift every later record.
export function encodeShapeRecord(shape: Shape, options: UploadOptions = {}): Uint8Array {
  const capacity = 4 + payloadByteSize(shape, options);
  const buffer = new ArrayBuffer(capacity);
  const view = new DataView(buffer);
  const end = writeShapePayload(view, 4, shape, options);

  if (end !== capacity) {
    raise({
      type: "internal",
      code: "upload-record-size-mismatch",
      hint: `upload record size mismatch: wrote ${end} expected ${capacity}`,
    });
  }

  view.setUint32(0, end - 4, true);
  return new Uint8Array(buffer, 0, end);
}

export function flushShapesBatch(
  shapes: readonly Shape[],
  options: UploadOptions = {},
  target: WasmModule = module(),
): void {
  if (shapes.length === 0) return;

  const records = shapes.map((shape) => encodeShapeRecord(shape, options));
  const total = 4 + records.reduce((acc, record) => acc + record.byteLength, 0);
  const offset = alloc(target, total);
  const heap = heapU8(target);
  const view = dataView(heap);

  view.setUint32(offset, records.length, true);
  let at = offset + 4;
  for (const record of records) {
    heap.set(record, at);
    at += record.byteLength;
  }

  // The Rust side takes ownership of the buffer; do not free it here.
  call(target, "_set_shapes_batch");
}

export function setShapeUpload(
  shape: Shape,
  options: UploadOptions = {},
  target: WasmModule = module(),
): void {
  flushShapesBatch([shape], options, target);
}
