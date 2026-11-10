// The engine-facing half of the wasm text pipeline (D11): it feeds the faces
// that lib/render-wasm/fonts.ts resolves into the render-wasm module through
// the same internal exports the CLJS original uses, then asks the engine to
// re-layout the shapes that consume them.
//
// Ported from frontend/src/app/render_wasm/api/fonts.cljs:
// - store-font-buffer (L144) -> storeFontFace: _alloc_bytes(len) -> write the
//   bytes into the heap view -> _store_font -> store-font-url (L124). The font
//   bytes are NOT passed as a pointer argument: _store_font implicitly reads
//   the buffer the previous _alloc_bytes produced (render-wasm mem::bytes()),
//   so the alloc+write MUST come first, and _store_font_url repeats the dance
//   for the encoded URL.
// - font-stored? (L267) -> isFontUploaded: _is_font_uploaded answered non-zero.
// - update-text-layout / force-update-text-layout (L103/L113) -> these take the
//   SHAPE uuid (not the family uuid) and re-run the shape text layout.
//
// The wasm/live? guard wraps store and the layout calls, like the original; the
// store family uuid words come from ResolvedFontFace.wasmIdWords (fonts.ts).

import { call, KEY, uuidToU32, type RendererApp } from "@/lib/render-wasm/interop";
import type { ResolvedFontFace } from "@/lib/render-wasm/fonts";

// The subset of the emscripten module this slice touches. HEAPU8 is the live
// Uint8Array view over the whole linear memory (CLJS reads it with
// gobj/get "HEAPU8"); writing through a view over its .buffer is how the bytes
// reach the allocation _alloc_bytes returned.
interface FontWasmModule {
  readonly HEAPU8: Uint8Array;
  _alloc_bytes(len: number): number;
  _store_font(
    a: number,
    b: number,
    c: number,
    d: number,
    weight: number,
    style: number,
    isEmoji: boolean,
    isFallback: boolean,
  ): unknown;
  _store_font_url(
    a: number,
    b: number,
    c: number,
    d: number,
    weight: number,
    style: number,
  ): unknown;
  _is_font_uploaded(
    a: number,
    b: number,
    c: number,
    d: number,
    weight: number,
    style: number,
    isEmoji: boolean,
  ): number;
  _update_shape_text_layout_for(a: number, b: number, c: number, d: number): unknown;
  _force_update_shape_text_layout_for(
    a: number,
    b: number,
    c: number,
    d: number,
  ): unknown;
}

function fontModule(app: RendererApp): FontWasmModule {
  return app[KEY.internalModule] as unknown as FontWasmModule;
}

// Copy `source` into a heap view over the region _alloc_bytes just reserved,
// mirroring `(js/Uint8Array. (.-buffer heap) ptr size)` + `.set`.
function writeHeap(mod: FontWasmModule, source: Uint8Array): void {
  const ptr = mod._alloc_bytes(source.byteLength);
  new Uint8Array(mod.HEAPU8.buffer, ptr, source.byteLength).set(source);
}

// store-font-url: register the same-origin source URL for the face so the
// engine can report / re-fetch it. Skipped for a blank url like the original.
function storeFontUrl(mod: FontWasmModule, face: ResolvedFontFace): void {
  const url = face.ttfUrl;
  if (url === undefined || url === null || url.trim() === "") return;
  const [a, b, c, d] = face.wasmIdWords;
  writeHeap(mod, new TextEncoder().encode(url));
  mod._store_font_url(a, b, c, d, face.weight, face.style);
}

// store-font-buffer: push the fetched TTF bytes for one resolved face into the
// engine, then attach its URL. Returns false (no-op) when the renderer is not
// live, matching the (wasm/live?) guard, so callers can degrade safely.
export function storeFontFace(
  app: RendererApp,
  face: ResolvedFontFace,
  ttfBuffer: ArrayBuffer,
): boolean {
  if (call(app, KEY.wasmLive) !== true) return false;
  const mod = fontModule(app);
  const [a, b, c, d] = face.wasmIdWords;
  writeHeap(mod, new Uint8Array(ttfBuffer));
  mod._store_font(a, b, c, d, face.weight, face.style, face.isEmoji, face.isFallback);
  storeFontUrl(mod, face);
  return true;
}

// font-stored?: whether the engine already holds this exact face (family uuid
// + integer weight + integer style + emoji). Callers use it to skip a fetch.
export function isFontUploaded(app: RendererApp, face: ResolvedFontFace): boolean {
  const [a, b, c, d] = face.wasmIdWords;
  return fontModule(app)._is_font_uploaded(a, b, c, d, face.weight, face.style, face.isEmoji) !== 0;
}

// update-text-layout: re-run the layout of the text shape `shapeId` (the SHAPE
// uuid) against the now-available faces.
export function updateTextLayout(app: RendererApp, shapeId: string): void {
  if (call(app, KEY.wasmLive) !== true) return;
  const [a, b, c, d] = uuidToU32(shapeId);
  fontModule(app)._update_shape_text_layout_for(a, b, c, d);
}

// force-update-text-layout: the forced counterpart, used when a face landed
// after the shape was already laid out (the font-stored subscriber path).
export function forceUpdateTextLayout(app: RendererApp, shapeId: string): void {
  if (call(app, KEY.wasmLive) !== true) return;
  const [a, b, c, d] = uuidToU32(shapeId);
  fontModule(app)._force_update_shape_text_layout_for(a, b, c, d);
}
