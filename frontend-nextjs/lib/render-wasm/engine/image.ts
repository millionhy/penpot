// The image registry host: the browser half of `render-wasm/src/wasm/fills/
// image.rs` plus the fetch-and-store loop of app.render-wasm.api.
//
// The fill record carries only the media id; the pixels reach wasm through
// `_store_image`, which takes the single pending allocation:
//   0..16   shape uuid
//   16..32  image uuid (the file media id)
//   32..36  is_thumbnail flag (u32, little endian)
//   36..    the encoded image bytes
// The renderer decodes the bytes itself, so PNG/JPEG/WebP and SVG share this
// one path. The compiled frontend decodes raster images in the browser and
// hands over a WebGL texture (`_store_image_from_texture`) only to avoid a
// second decode; the Next host keeps the single encoded-bytes path, which
// also covers SVG.
//
// `_is_image_cached` answers 1 when the store already holds the image for the
// requested thumbnail variant. A hit still registers the public URL, because
// SVG export emits the linked `<image href>` for every image it draws.
//
// Nothing here fetches on its own: `resolveUrl` and `fetchBytes` come from the
// caller, so the engine stays free of the app's media endpoint and the tests
// stay offline.

import { call } from "./call";
import { getImageIds, getStrokeImageIds, type Fill } from "./fills";
import { alloc, dataView, heapU8 } from "./memory";
import { live, type RenderWasmModule } from "./module";
import type { Shape } from "./upload";
import { isUuid, uuidToU32 } from "./uuid";

export const IMAGE_HEADER_U8_SIZE = 36;

// The image ids a shape references: its fills in order, then the image of
// every visible stroke. A group has no strokes to draw.
export function shapeImageIds(shape: Shape): string[] {
  const fills: readonly Fill[] = shape.fills ?? [];
  const strokes =
    shape.type === "group" ? [] : (shape.strokes ?? []).filter((stroke) => stroke.hidden !== true);
  return [...getImageIds(fills), ...getStrokeImageIds(strokes)];
}

// The image ids of the span fills of a text content tree. Spans are the only
// place a text shape carries image fills; the paragraphs have none.
export function textImageIds(content: unknown): string[] {
  const ids: string[] = [];
  const set = paragraphsOf(content)[0];
  for (const paragraph of set ?? []) {
    for (const span of paragraph.children ?? []) {
      ids.push(...getImageIds(span.fills ?? []));
    }
  }
  return ids;
}

interface TextSpanLike {
  fills?: readonly Fill[];
}

interface TextParagraphLike {
  children?: readonly TextSpanLike[];
}

interface TextSetLike {
  children?: readonly TextParagraphLike[];
}

interface TextContentLike {
  children?: readonly TextSetLike[];
}

function paragraphsOf(content: unknown): readonly (readonly TextParagraphLike[])[] {
  if (content === null || typeof content !== "object") return [];
  const sets = (content as TextContentLike).children;
  if (!Array.isArray(sets)) return [];
  return sets.map((set) => set?.children ?? []);
}

// is-image-cached: one yes/no for the (image, thumbnail) pair.
export function isImageCached(
  module: RenderWasmModule,
  imageId: string,
  thumbnail = false,
): boolean {
  if (!live()) return false;
  const words = uuidToU32(imageId);
  return (
    call<number>(module, "_is_image_cached", words[0], words[1], words[2], words[3], thumbnail) ===
    1
  );
}

export function storeImage(
  module: RenderWasmModule,
  shapeId: string,
  imageId: string,
  bytes: Uint8Array,
  thumbnail = false,
): void {
  if (!live()) return;

  const offset = alloc(module, IMAGE_HEADER_U8_SIZE + bytes.byteLength);
  // Re-read after the allocation: growth detaches the previous views.
  const heap = heapU8(module);
  writeUuid(heap, offset, shapeId);
  writeUuid(heap, offset + 16, imageId);
  dataView(heap).setUint32(offset + 32, thumbnail ? 1 : 0, true);
  heap.set(bytes, offset + IMAGE_HEADER_U8_SIZE);

  call(module, "_store_image");
  // `_store_image` takes the allocation through `mem::bytes()`, so the header
  // and the payload travel with it and nothing is freed here.
}

// The uuid as four little-endian u32 words, the form every id argument and
// every id field in a buffer use.
function writeUuid(heap: Uint8Array, offset: number, id: string): void {
  const view = dataView(heap);
  const words = uuidToU32(id);
  for (let index = 0; index < 4; index += 1) {
    view.setUint32(offset + index * 4, words[index], true);
  }
}

// store-image-url!: registers the URL the pixels came from, for SVG export.
export function storeImageUrl(
  module: RenderWasmModule,
  imageId: string,
  url: string | null | undefined,
): boolean {
  if (!live()) return false;
  if (url === null || url === undefined || url.trim() === "") return false;

  const bytes = new TextEncoder().encode(url);
  const offset = alloc(module, bytes.byteLength);
  heapU8(module).set(bytes, offset);
  const words = uuidToU32(imageId);
  call(module, "_store_image_url", words[0], words[1], words[2], words[3]);
  return true;
}

export interface ImageHost {
  // The public URL of a media id, or undefined when the model has none. The
  // URL is registered even when the pixels are already cached.
  resolveUrl?: (imageId: string, thumbnail: boolean) => string | undefined;
  // Injected for the tests; the default fetches the URL and reads the body.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  onError?: (cause: unknown, imageId: string) => void;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the image fetch answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

// process-fill-image: register the URL, then fetch and store only on a miss.
// The returned promise resolves even when the fetch fails, so an ignored
// promise cannot surface as an unhandled rejection; the failure goes to
// `onError` (or the console).
export function loadImage(
  module: RenderWasmModule,
  shapeId: string,
  imageId: string,
  thumbnail: boolean,
  host: ImageHost = {},
): Promise<void> | undefined {
  if (!live()) return undefined;
  if (!isUuid(imageId)) return undefined;

  const url = host.resolveUrl?.(imageId, thumbnail);
  storeImageUrl(module, imageId, url);
  if (isImageCached(module, imageId, thumbnail)) return undefined;

  if (url === undefined) return undefined;

  const fetchBytes = host.fetchBytes ?? defaultFetchBytes;
  return fetchBytes(url)
    .then((bytes) => {
      if (!live()) return;
      storeImage(module, shapeId, imageId, bytes, thumbnail);
    })
    .catch((cause: unknown) => {
      if (host.onError !== undefined) host.onError(cause, imageId);
      else console.warn("[render-wasm] could not load an image:", imageId, cause);
    });
}

// The image work of one shape: every fill and visible-stroke image.
export function loadShapeImages(
  module: RenderWasmModule,
  shape: Shape,
  thumbnail: boolean,
  host: ImageHost = {},
): Promise<void>[] {
  const pending: Promise<void>[] = [];
  for (const imageId of shapeImageIds(shape)) {
    const work = loadImage(module, shape.id, imageId, thumbnail, host);
    if (work !== undefined) pending.push(work);
  }
  return pending;
}

// The image work of a text shape: the span fills of its content.
export function loadTextImages(
  module: RenderWasmModule,
  shapeId: string,
  content: unknown,
  thumbnail: boolean,
  host: ImageHost = {},
): Promise<void>[] {
  const pending: Promise<void>[] = [];
  for (const imageId of textImageIds(content)) {
    if (!isUuid(imageId)) continue;
    const work = loadImage(module, shapeId, imageId, thumbnail, host);
    if (work !== undefined) pending.push(work);
  }
  return pending;
}
