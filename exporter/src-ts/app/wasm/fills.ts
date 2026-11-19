// app.common.types.fills (.impl), Node side.
//
// The exporter never reads fills back from binary, so this only needs the
// writers: one fill record is FILL_U8_SIZE bytes (a 4-byte type/flags gap plus
// the largest payload, the gradient), and a fills block is a 4-byte count
// header followed by the records. Mirrors `types/fills/impl.cljc` byte for
// byte; the metadata/read-back half of that namespace stays in CLJS.
//
// Values arrive from transit as plain objects with string keys.

import { raise } from "../errors.js";
import { getU32 } from "../uuid.js";

export const MAX_GRADIENT_STOPS = 16;
export const MAX_FILLS = 8;

export const GRADIENT_STOP_U8_SIZE = 8;
export const GRADIENT_U8_SIZE = 156;
export const SOLID_U8_SIZE = 4;
export const IMAGE_U8_SIZE = 36;
export const FILL_U8_SIZE = 4 + Math.max(GRADIENT_U8_SIZE, IMAGE_U8_SIZE, SOLID_U8_SIZE);

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

// coerce + take MAX_FILLS, like the CLJS from-plain constructor.
export function coerce(fills: Fills | null | undefined): Fills {
  if (fills === null || fills === undefined) return [];
  return fills.slice(0, MAX_FILLS);
}

// 4-byte header with the fill count plus one record per fill.
export function getByteSize(fills: Fills): number {
  return 4 + fills.length * FILL_U8_SIZE;
}

function hexToRgb(hex: string): number {
  return Number.parseInt(hex.slice(1), 16);
}

function rgbToRgba(rgb: number, alpha: number): number {
  const a = Math.floor(alpha * 0xff) | 0;
  return ((a << 24) | rgb) >>> 0;
}

function uuidBytes(id: string): Uint32Array {
  return getU32(id);
}

// Writes [u8 type][3 bytes pad][payload] at `offset`. Returns the next offset.
export function writeSolidFill(
  view: DataView,
  offset: number,
  opacity: number,
  color: string,
): number {
  view.setUint8(offset, 0x00);
  view.setInt32(offset + 4, rgbToRgba(hexToRgb(color), opacity) | 0, true);
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
    view.setInt32(at, rgbToRgba(hexToRgb(stop.color), stop.opacity ?? 1) | 0, true);
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
  const quartet = uuidBytes(image.id);
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

export function writeFill(view: DataView, offset: number, fill: Fill): number {
  const opacity = fill["fill-opacity"] ?? 1.0;
  const color = fill["fill-color"];
  const gradient = fill["fill-color-gradient"];
  const image = fill["fill-image"];

  if (color !== undefined) return writeSolidFill(view, offset, opacity, color);
  if (gradient !== undefined) return writeGradientFill(view, offset, opacity, gradient);
  if (image !== undefined) return writeImageFill(view, offset, opacity, image);

  return raise({
    type: "internal",
    code: "invalid-fill",
    hint: "found invalid fill on encoding fills to binary format",
  });
}

// Writes the count header and records at `offset` (a byte offset in `target`).
// The caller allocated exactly `getByteSize(fills)` bytes.
export function writeTo(fills: Fills, target: Uint8Array, offset: number): number {
  const view = new DataView(target.buffer, target.byteOffset, target.byteLength);

  view.setUint8(offset, fills.length);
  let at = offset + 4;
  for (const fill of fills) at = writeFill(view, at, fill);
  return at;
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
