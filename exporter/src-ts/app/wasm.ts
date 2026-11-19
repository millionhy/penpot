// app.wasm: the headless driver for the render-wasm module under Node.
//
// The GPU-free counterpart of the browser's app.render-wasm.api. It loads the
// emscripten artifact, boots it through `_init_headless`, and exposes font
// provisioning, the image store and shape rendering. Serialization stays in
// the portable leaves (app.wasm.serialize / text), so this module owns only
// the Node runtime and the headless render calls.
//
// The artifact must be built with `-sENVIRONMENT=web,node`; `resources/wasm`
// is the same path in devenv and inside the bundle.

import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { raise } from "./errors.js";
import { createLogger, setLevel } from "./logging.js";
import * as uuid from "./uuid.js";
import { call } from "./wasm/call.js";
import { alloc, dataView, free, heapU32, heapU8, offset32, writeBuffer } from "./wasm/memory.js";

const log = createLogger("app.wasm");
setLevel("app.wasm", "info");

export const defaultViewportWidth = 1920;
export const defaultViewportHeight = 1080;

// Built render-wasm artifact, relative to the process working directory.
export const artifactDir = "resources/wasm";

// Byte budget the image store is trimmed to between requests. Also the default
// when the operator did not set `wasm-worker-image-cache-size`.
export const imageCacheSize = 256 * 1024 * 1024;

// render_shape_raster result header: [len u32][w u32][h u32].
export const rasterHeaderBytes = 12;
// render_shape_pdf / render_shape_svg result header: [len u32] only.
export const lenHeaderBytes = 4;
// get_fonts_for_shape entry: [uuid 16 bytes][weight u32][style u32].
export const fontEntryBytes = 24;
// store_image buffer: [shape uuid 16][image uuid 16][is_thumbnail u32].
export const imageHeaderBytes = 36;

export interface WasmModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  [key: string]: unknown;
}

// One font family as the headless store keys it. The id is the u32 quartet the
// wasm calls consume; weight/style are the same numbers the serializer writes.
export interface FontFamily {
  id: Uint32Array;
  weight: number;
  style: number;
  emoji?: boolean;
  fallback?: boolean;
}

export interface ProvisionOptions {
  "font-url"?: (family: FontFamily) => string | undefined;
}

let internal: WasmModule | undefined;

export function setModule(next: WasmModule | undefined): void {
  internal = next;
}

export function reset(): void {
  internal = undefined;
}

// Every driver call needs the booted module. Raising here keeps the failure
// readable instead of a TypeError on undefined somewhere in the FFI.
export function module(): WasmModule {
  if (internal === undefined) {
    return raise({
      type: "internal",
      code: "wasm-not-ready",
      hint: "render-wasm module is not initialized",
    });
  }
  return internal;
}

type EmscriptenFactory = (
  config: Record<string, unknown>,
) => Promise<WasmModule> | WasmModule;

// The runtime WebAssembly API, named locally because the project does not pull
// the DOM lib into the exporter.
type WebAssemblyApi = {
  instantiate(bytes: Uint8Array, imports: unknown): Promise<{ instance: unknown }>;
};

function webassembly(): WebAssemblyApi {
  return (globalThis as unknown as { WebAssembly: WebAssemblyApi }).WebAssembly;
}

// Loads the artifact under Node and boots it headless. Callers hold the
// returned module; the shared one is what the serializers read.
export async function init(
  width = defaultViewportWidth,
  height = defaultViewportHeight,
): Promise<WasmModule> {
  const dir = artifactDir;
  const jsPath = path.resolve(dir, "render-wasm.js");
  const wasmPath = path.resolve(dir, "render-wasm.wasm");
  const wasmBytes = readFileSync(wasmPath);

  log.info({ hint: "loading render-wasm (headless)", js: jsPath });

  const namespace = (await import(pathToFileURL(jsPath).href)) as {
    default: EmscriptenFactory;
  };

  // Bypass the web fetch loader: instantiate from the local bytes.
  const created = await namespace.default({
    instantiateWasm(
      imports: unknown,
      success: (instance: unknown) => void,
    ): Record<string, never> {
      void webassembly()
        .instantiate(wasmBytes, imports)
        .then(({ instance }) => {
          success(instance);
        });
      return {};
    },
    locateFile: (file: string) => path.resolve(dir, file),
    printErr: (text: string) => log.warn({ wasm: text }),
  });

  setModule(created);
  call(created, "_init_headless", width, height);
  log.info({ hint: "render-wasm headless module ready", width, height });
  return created;
}

// --- FONTS

// Distinct font families the subtree rooted at `shapeId` needs, read from the
// loaded wasm tree. The result buffer is copied out before it is freed.
export function fontsForShape(shapeId: string): FontFamily[] {
  const target = module();
  const buf = uuid.getU32(shapeId);
  const offset = call<number>(
    target,
    "_get_fonts_for_shape",
    buf[0],
    buf[1],
    buf[2],
    buf[3],
  );
  const heap = heapU32(target);
  const count = heap[offset32(offset)];

  const entries: FontFamily[] = [];
  for (let index = 0; index < count; index += 1) {
    const base = offset + 4 + index * fontEntryBytes;
    const at = (delta: number) => heap[offset32(base + delta)];
    entries.push({
      id: Uint32Array.from([at(0), at(4), at(8), at(12)]),
      weight: at(16),
      style: at(20),
    });
  }

  free(target);
  return entries;
}

function fontKey(family: FontFamily): string {
  return `${family.id[0]}:${family.id[1]}:${family.id[2]}:${family.id[3]}:${family.weight}:${family.style}`;
}

// One export overwhelmingly repeats the same few families, so deduping here
// means one download and one `_store_font` per family.
export function fontsForShapes(shapeIds: readonly string[]): FontFamily[] {
  const seen = new Set<string>();
  const out: FontFamily[] = [];

  for (const shapeId of shapeIds) {
    for (const family of fontsForShape(shapeId)) {
      const key = fontKey(family);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(family);
    }
  }

  return out;
}

function familyId(family: FontFamily): [number, number, number, number] {
  return [family.id[0], family.id[1], family.id[2], family.id[3]];
}

// Uploads one font's TTF bytes keyed by family. `_store_font` releases the
// wasm buffer itself, so this must NOT call `_free_bytes`: doing so would drop
// a buffer a later writer already owns.
export function storeFont(family: FontFamily, fontBytes: Uint8Array | ArrayBuffer): void {
  const target = module();
  const bytes = fontBytes instanceof Uint8Array ? fontBytes : new Uint8Array(fontBytes);
  const ptr = alloc(target, bytes.byteLength);
  heapU8(target).set(bytes, ptr);
  call(
    target,
    "_store_font",
    ...familyId(family),
    family.weight,
    family.style,
    family.emoji === true,
    family.fallback === true,
  );
}

// Registers the public URL a family was loaded from. The SVG export emits one
// `@font-face` per family from these, and skips families without one.
export function storeFontUrl(family: FontFamily, url: string): void {
  const target = module();
  const bytes = Buffer.from(url, "utf-8");
  const ptr = alloc(target, bytes.byteLength);
  writeBuffer(heapU8(target), bytes, ptr);
  call(target, "_store_font_url", ...familyId(family), family.weight, family.style);
}

// Resets the store. Must run once per request, or fonts accumulate across
// exports on the shared module.
export function clearFonts(): void {
  call(module(), "_clear_fonts");
}

// Text is laid out while serializing with the fallback font, so the layout has
// to be recomputed after the real fonts land or the metrics are wrong. Forced:
// `update_layout` early-returns when the content is unchanged.
export function updateTextLayout(shapeId: string): void {
  const buf = uuid.getU32(shapeId);
  call(module(), "_force_update_shape_text_layout_for", buf[0], buf[1], buf[2], buf[3]);
}

// Resolves and uploads every family `shapeIds` needs, each fetched once. The
// font source stays outside the driver through the injected resolvers.
export async function provisionFonts(
  shapeIds: readonly string[],
  resolveFont: (family: FontFamily) => Promise<Uint8Array | ArrayBuffer | null | undefined>,
  options: ProvisionOptions = {},
): Promise<void> {
  const families = fontsForShapes(shapeIds);

  await Promise.all(
    families.map(async (family) => {
      const bytes = await resolveFont(family);
      if (bytes === null || bytes === undefined) return;

      storeFont(family, bytes);
      const url = options["font-url"]?.(family);
      if (url !== undefined) storeFontUrl(family, url);
    }),
  );
}

// --- IMAGES

// True when the store already holds the full-size image. The store survives
// between requests, so a cached image is not fetched again.
export function imageCached(imageId: string): boolean {
  const buf = uuid.getU32(imageId);
  return call<number>(module(), "_is_image_cached", buf[0], buf[1], buf[2], buf[3], false) !== 0;
}

// Registers the public URL an image came from. The SVG export links it from
// there and falls back to Skia base64 when missing. Blank URLs are ignored.
export function storeImageUrl(imageId: string, url: string | null | undefined): void {
  if (url === null || url === undefined || url.trim() === "") return;

  const target = module();
  const bytes = Buffer.from(url, "utf-8");
  const ptr = alloc(target, bytes.byteLength);
  writeBuffer(heapU8(target), bytes, ptr);
  const quartet = uuid.getU32(imageId);
  call(target, "_store_image_url", quartet[0], quartet[1], quartet[2], quartet[3]);
}

// Uploads one image's *encoded* bytes (SVG output decodes them through Skia).
// The reader wants [shape uuid][image uuid][is_thumbnail][encoded bytes];
// images are keyed by image uuid, so the shape uuid stays zero. `_store_image`
// releases the buffer itself, so no free here either.
export function storeImage(imageId: string, imageBytes: Uint8Array | ArrayBuffer): void {
  const target = module();
  const bytes = imageBytes instanceof Uint8Array ? imageBytes : new Uint8Array(imageBytes);
  const ptr = alloc(target, imageHeaderBytes + bytes.byteLength);
  const heap = heapU8(target);
  const view = dataView(heap);

  for (const delta of [0, 4, 8, 12]) view.setUint32(ptr + delta, 0, true);

  const quartet = uuid.getU32(imageId);
  for (let index = 0; index < 4; index += 1) {
    view.setUint32(ptr + 16 + index * 4, quartet[index], true);
  }

  view.setUint32(ptr + 32, 0, true);
  heap.set(bytes, ptr + imageHeaderBytes);

  call(target, "_store_image");
}

// Evicts least-recently-used images until at most `maxBytes` remain. Returns
// the number evicted. Called between requests, never mid-render.
export function evictImages(maxBytes: number): number {
  return call<number>(module(), "_evict_images_to_budget", maxBytes);
}

// --- RENDER

// Copies the payload out of a `_render_shape_*` result buffer and frees it.
function readRenderResult(offset: number, headerBytes: number): Uint8Array {
  const target = module();
  const len = heapU32(target)[offset32(offset)];
  const bytes = heapU8(target).slice(offset + headerBytes, offset + headerBytes + len);
  free(target);
  return bytes;
}

// Encoded image bytes on a CPU surface. `format` is the RasterFormat number
// the serializers translate from the export keyword.
export function renderShapeRaster(shapeId: string, scale: number, format: number): Uint8Array {
  const buf = uuid.getU32(shapeId);
  const offset = call<number>(
    module(),
    "_render_shape_raster",
    buf[0],
    buf[1],
    buf[2],
    buf[3],
    scale,
    format,
  );
  return readRenderResult(offset, rasterHeaderBytes);
}

export function renderShapePdf(shapeId: string, scale: number): Uint8Array {
  const buf = uuid.getU32(shapeId);
  const offset = call<number>(
    module(),
    "_render_shape_pdf",
    buf[0],
    buf[1],
    buf[2],
    buf[3],
    scale,
  );
  return readRenderResult(offset, lenHeaderBytes);
}

export function renderShapeSvg(shapeId: string, scale: number): Uint8Array {
  const buf = uuid.getU32(shapeId);
  const offset = call<number>(
    module(),
    "_render_shape_svg",
    buf[0],
    buf[1],
    buf[2],
    buf[3],
    scale,
  );
  return readRenderResult(offset, lenHeaderBytes);
}
