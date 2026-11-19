// The fill record layout of app.common.types.fills (and the stroke header of
// app.common.render-wasm.api.props).
//
// One fill record is FILL_U8_SIZE bytes: a one-byte type, three pad bytes and
// the largest payload (the gradient). A fills block is a four-byte count
// header followed by the records. The numbers must match
// `render-wasm/src/serializers/fills.rs`; the Rust reader never validates, it
// just advances by the fixed record size.
//
// Strokes reuse the same fill payload behind a 36-byte header; the batch
// upload inlines both, the incremental setters in `props.ts` write them one
// call at a time.

import { EngineError } from "./errors";
import { hexToArgbU32 } from "./colors";
import { uuidToU32 } from "./uuid";

export const MAX_GRADIENT_STOPS = 16;
export const MAX_FILLS = 8;

export const GRADIENT_STOP_U8_SIZE = 8;
export const GRADIENT_U8_SIZE = 156;
export const SOLID_U8_SIZE = 4;
export const IMAGE_U8_SIZE = 36;
export const FILL_U8_SIZE =
  4 + Math.max(GRADIENT_U8_SIZE, IMAGE_U8_SIZE, SOLID_U8_SIZE);

// Stroke header before its fill record (must match upload_batch.rs).
export const STROKE_HEADER_U8_SIZE = 36;

export const STROKE_ALIGN_CENTER = 0;
export const STROKE_ALIGN_INNER = 1;
export const STROKE_ALIGN_OUTER = 2;

export interface GradientStop {
  color: string;
  opacity?: number;
  offset: number;
}

export interface FillGradient {
  type?: string;
  "start-x"?: number;
  "start-y"?: number;
  "end-x"?: number;
  "end-y"?: number;
  width?: number;
  stops?: readonly GradientStop[];
}

export interface FillImage {
  id: string;
  width?: number;
  height?: number;
  mtype?: string;
  "keep-aspect-ratio"?: boolean;
  transform?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
}

export interface Fill {
  "fill-color"?: string;
  "fill-opacity"?: number;
  "fill-color-gradient"?: FillGradient;
  "fill-image"?: FillImage;
}

export type Fills = readonly Fill[];

// The stroke shape the fill writers take: the paint lives under
// stroke-* keys, but the byte layout is a fill record.
export interface StrokePaint {
  "stroke-opacity"?: number;
  "stroke-color"?: string;
  "stroke-color-gradient"?: FillGradient;
  "stroke-image"?: FillImage;
}

export interface Stroke extends StrokePaint {
  hidden?: boolean;
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

// coerce + take MAX_FILLS, like the CLJS from-plain constructor.
export function coerce(fills: Fills | null | undefined): Fills {
  if (fills === null || fills === undefined) return [];
  return fills.slice(0, MAX_FILLS);
}

// Four-byte header with the fill count plus one record per fill.
export function getByteSize(fills: Fills): number {
  return 4 + fills.length * FILL_U8_SIZE;
}

// Image ids referenced by image fills, in order of appearance.
export function getImageIds(fills: Fills): string[] {
  const ids: string[] = [];
  for (const fill of fills) {
    const image = fill["fill-image"];
    if (image !== undefined) ids.push(image.id);
  }
  return ids;
}

export function getStrokeImageIds(strokes: readonly Stroke[]): string[] {
  const ids: string[] = [];
  for (const stroke of strokes) {
    const image = stroke["stroke-image"];
    if (image !== undefined) ids.push(image.id);
  }
  return ids;
}

// Writes [u8 type][3 bytes pad][payload] at `offset`. Returns the next offset.
export function writeSolidFill(
  view: DataView,
  offset: number,
  opacity: number,
  color: string,
): number {
  view.setUint8(offset, 0x00);
  view.setUint32(offset + 4, hexToArgbU32(color, opacity), true);
  return offset + FILL_U8_SIZE;
}

export function writeGradientFill(
  view: DataView,
  offset: number,
  opacity: number,
  gradient: FillGradient,
): number {
  const stops = (gradient.stops ?? []).slice(0, MAX_GRADIENT_STOPS);
  const type = gradient.type === "linear" ? 0x01 : 0x02;
  const alpha = Math.floor(opacity * 0xff);

  view.setUint8(offset, type);
  view.setFloat32(offset + 4, gradient["start-x"] ?? 0, true);
  view.setFloat32(offset + 8, gradient["start-y"] ?? 0, true);
  view.setFloat32(offset + 12, gradient["end-x"] ?? 0, true);
  view.setFloat32(offset + 16, gradient["end-y"] ?? 0, true);
  view.setUint8(offset + 20, alpha);
  view.setFloat32(offset + 24, gradient.width ?? 0, true);
  view.setUint8(offset + 28, stops.length);

  let at = offset + 32;
  for (const stop of stops) {
    view.setUint32(at, hexToArgbU32(stop.color, stop.opacity ?? 1), true);
    view.setFloat32(at + 4, Number(stop.offset), true);
    at += GRADIENT_STOP_U8_SIZE;
  }

  return offset + FILL_U8_SIZE;
}

export function writeImageFill(
  view: DataView,
  offset: number,
  opacity: number,
  image: FillImage,
): number {
  const quartet = uuidToU32(image.id);
  const alpha = Math.floor(opacity * 0xff);
  const keepAspectRatio = image["keep-aspect-ratio"] === true ? 0x01 : 0x00;
  const transform = image.transform;
  const flags = (keepAspectRatio | (transform === undefined ? 0x00 : 0x02)) >>> 0;

  view.setUint8(offset, 0x03);
  for (let index = 0; index < 4; index += 1) {
    view.setUint32(offset + 4 + index * 4, quartet[index], true);
  }
  view.setUint8(offset + 20, alpha);
  view.setUint8(offset + 21, flags);
  view.setUint16(offset + 22, 0, true);
  view.setInt32(offset + 24, image.width ?? 0, true);
  view.setInt32(offset + 28, image.height ?? 0, true);
  view.setFloat32(offset + 32, transform?.x ?? 0, true);
  view.setFloat32(offset + 36, transform?.y ?? 0, true);
  view.setFloat32(offset + 40, transform?.width ?? 1, true);
  view.setFloat32(offset + 44, transform?.height ?? 1, true);

  return offset + FILL_U8_SIZE;
}

// A fill resolves color -> gradient -> image (the model's own order).
export function writeFill(view: DataView, offset: number, fill: Fill): number {
  const opacity = fill["fill-opacity"] ?? 1.0;
  const color = fill["fill-color"];
  const gradient = fill["fill-color-gradient"];
  const image = fill["fill-image"];

  if (color !== undefined) return writeSolidFill(view, offset, opacity, color);
  if (gradient !== undefined) return writeGradientFill(view, offset, opacity, gradient);
  if (image !== undefined) return writeImageFill(view, offset, opacity, image);

  throw new EngineError("wasm-critical", "render-wasm: invalid fill", {
    hint: "found invalid fill on encoding fills to binary format",
  });
}

// A stroke resolves gradient -> image -> color, the opposite of a fill, and
// inserts an empty solid record when it has no paint at all.
export function writeStrokeFill(
  view: DataView,
  offset: number,
  stroke: StrokePaint,
): number {
  const opacity = stroke["stroke-opacity"] ?? 1.0;
  const color = stroke["stroke-color"];
  const gradient = stroke["stroke-color-gradient"];
  const image = stroke["stroke-image"];

  if (gradient !== undefined) return writeGradientFill(view, offset, opacity, gradient);
  if (image !== undefined) return writeImageFill(view, offset, opacity, image);
  if (color !== undefined) return writeSolidFill(view, offset, opacity, color);

  return writeSolidFill(view, offset, 0.0, "#000000");
}

// The count header and records at `offset` (a byte offset in `view`). The
// caller allocated exactly `getByteSize(fills)` bytes.
export function writeFills(view: DataView, offset: number, fills: Fills): number {
  view.setUint8(offset, fills.length);
  let at = offset + 4;
  for (const fill of fills) at = writeFill(view, at, fill);
  return at;
}

export function strokeAlignment(alignment: string | undefined): number {
  if (alignment === "inner") return STROKE_ALIGN_INNER;
  if (alignment === "outer") return STROKE_ALIGN_OUTER;
  return STROKE_ALIGN_CENTER;
}