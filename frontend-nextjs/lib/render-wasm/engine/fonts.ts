// The font ABI of app.render-wasm.api.fonts and the font-id mapping of
// app.common.fonts.
//
// The renderer keys every face by (uuid, weight, style): `_store_font` takes
// the TTF bytes through the one pending allocation (`mem::bytes()`), and
// `_store_font_url` records the source URL the SVG export needs. Fetching the
// bytes, choosing the closest variant and remembering which faces failed are
// host concerns; this module only writes what the renderer reads and answers
// the two questions the host asks it (`isFontUploaded`, `fontIdToUuid`).
//
// The google catalog is compiled into the CLJS build (`gfonts.*.json`). The
// TypeScript side takes it through `resolveGoogleId`, so the engine keeps no
// font data of its own.

import { call } from "./call";
import { alloc, heapU8 } from "./memory";
import { live, type RenderWasmModule } from "./module";
import { translateFontStyle, type EnumValue } from "./serializers";
import { ZERO_UUID, isUuid, uuidToU32 } from "./uuid";

// cfnt/font-id->backend, and the default face weight.
export const GFONT_PREFIX = "gfont-";
export const CUSTOM_PREFIX = "custom-";
export const DEFAULT_FONT_WEIGHT = 400;

const encoder = new TextEncoder();

export type FontBackend = "google" | "custom" | "builtin";

// A face the renderer can store or look up: the wasm uuid plus the weight and
// style that tell variants of one family apart.
export interface FontFace {
  id: string;
  weight?: number;
  style?: string | number | null;
}

// font-id -> backend: the `gfont-`/`custom-` prefixes name the source, and
// everything else (the bundled family, unknown or malformed ids) is builtin.
export function fontIdBackend(fontId: unknown): FontBackend {
  if (typeof fontId !== "string") return "builtin";
  if (fontId.startsWith(GFONT_PREFIX)) return "google";
  if (fontId.startsWith(CUSTOM_PREFIX)) return "custom";
  return "builtin";
}

// cfnt/font-id->uuid. Only the custom prefix carries its uuid; a google id
// needs the compiled catalog entry, and a builtin id is the zero uuid the
// renderer resolves to its default font.
export function fontIdToUuid(
  fontId: unknown,
  resolveGoogleId?: (fontId: string) => string | undefined,
): string {
  const backend = fontIdBackend(fontId);
  if (backend === "google") {
    const id = typeof fontId === "string" ? resolveGoogleId?.(fontId) : undefined;
    return isUuid(id) ? id : ZERO_UUID;
  }
  if (backend === "custom") {
    const id = (fontId as string).slice(CUSTOM_PREFIX.length);
    return isUuid(id) ? id : ZERO_UUID;
  }
  return ZERO_UUID;
}

// serialize-font-style: the RawFontStyle values; anything but italic is normal.
export function serializeFontStyle(style: unknown): number {
  if (typeof style === "number") return style === 1 ? 1 : 0;
  return translateFontStyle(style as EnumValue) ?? 0;
}

function quartetOf(face: FontFace): Uint32Array {
  return uuidToU32(face.id);
}

function weightOf(face: FontFace): number {
  return face.weight ?? DEFAULT_FONT_WEIGHT;
}

function callWithFace(
  module: RenderWasmModule,
  name: string,
  face: FontFace,
  trailing: readonly unknown[],
): unknown {
  const quartet = quartetOf(face);
  return call(
    module,
    name,
    quartet[0],
    quartet[1],
    quartet[2],
    quartet[3],
    weightOf(face),
    serializeFontStyle(face.style),
    ...trailing,
  );
}

// store-font: hands the TTF bytes to the renderer. `emoji` and `fallback`
// mark the two auxiliary stores the text engine keeps.
export function storeFont(
  module: RenderWasmModule,
  face: FontFace,
  bytes: Uint8Array | ArrayBuffer,
  options: { emoji?: boolean; fallback?: boolean } = {},
): boolean {
  if (!live()) return false;

  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const offset = alloc(module, data.byteLength);
  heapU8(module).set(data, offset);

  // The renderer takes the allocation through `mem::bytes()`; nothing to free.
  callWithFace(module, "_store_font", face, [
    options.emoji === true,
    options.fallback === true,
  ]);
  return true;
}

// store-font-url: records where the face came from (the SVG export reads it).
// A missing or blank URL is a no-op, like the CLJS guard.
export function storeFontUrl(
  module: RenderWasmModule,
  face: FontFace,
  url: string | null | undefined,
): boolean {
  if (!live() || url === null || url === undefined || url.trim() === "") return false;

  const data = encoder.encode(url);
  const offset = alloc(module, data.byteLength);
  heapU8(module).set(data, offset);

  callWithFace(module, "_store_font_url", face, []);
  return true;
}

// is-font-uploaded: the renderer already holds a face with this weight, style
// and emoji flag.
export function isFontUploaded(
  module: RenderWasmModule,
  face: FontFace,
  emoji = false,
): boolean {
  if (!live()) return false;
  return callWithFace(module, "_is_font_uploaded", face, [emoji]) !== 0;
}

// update-text-layout: re-measure one shape with the fonts stored so far.
export function updateTextLayout(module: RenderWasmModule, id: string): void {
  if (!live()) return;
  const quartet = uuidToU32(id);
  call(module, "_update_shape_text_layout_for", quartet[0], quartet[1], quartet[2], quartet[3]);
}

// force-update-text-layout: the same, ignoring the cached layout. Used after
// a pending font resolves so the extrect and tiles use real glyph metrics.
export function forceUpdateTextLayout(module: RenderWasmModule, id: string): void {
  if (!live()) return;
  const quartet = uuidToU32(id);
  call(
    module,
    "_force_update_shape_text_layout_for",
    quartet[0],
    quartet[1],
    quartet[2],
    quartet[3],
  );
}