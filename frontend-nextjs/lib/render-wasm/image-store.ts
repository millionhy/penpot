// The host side of the wasm image registry (第2项 image tool).
//
// render-wasm/src/wasm/fills/image.rs exposes store_image as a C entry
// point. The function reads one buffer from the single bytes slot
// (crate::mem::bytes) and frees it itself, so the host allocates with
// _alloc_bytes, writes the payload and calls _store_image with no arguments.
//
// Buffer layout:
//   0..16   shape uuid
//   16..32  image uuid (the file media object id)
//   32..36  is_thumbnail flag (u32, little endian)
//   36..    the encoded image bytes
//
// The image fill in the shape record references the same media id, so the
// renderer resolves the bitmap as soon as the next frame runs.

import { KEY, call, uuidToU32, type RendererApp } from "@/lib/render-wasm/interop";

// The entry points the image store needs from the internal module.
export const IMAGE_STORE_INTERNALS = ["_store_image", "_alloc_bytes"] as const;

const IMAGE_HEADER_SIZE = 36;

type InternalModule = Record<string, (...args: number[]) => unknown> & {
  HEAPU8?: Uint8Array;
  HEAPU32?: Uint32Array;
};

function internalModule(app: RendererApp): InternalModule {
  const internal = app[KEY.internalModule] as InternalModule | undefined;
  if (internal === undefined) {
    throw new Error("render-wasm: internal module is not available");
  }
  return internal;
}

// Register the pixels of one image file under the media id of the fill.
// The shape id is carried in the payload because the CLJS api uses it to
// touch the shapes that already reference the image; the shape must be in
// the wasm model before this call.
export function storeImageBytes(
  app: RendererApp,
  shapeId: string,
  imageId: string,
  bytes: Uint8Array,
  thumbnail = false,
): void {
  const internal = internalModule(app);
  const offset = internal._alloc_bytes(IMAGE_HEADER_SIZE + bytes.byteLength) as number;
  // Re-read after the allocation: growth detaches the previous views.
  const heapU8 = internal.HEAPU8;
  const heapU32 = internal.HEAPU32;
  if (heapU8 === undefined || heapU32 === undefined) {
    throw new Error("render-wasm: the heap views are not available");
  }

  const wordOffset = offset >> 2;
  heapU32.set(uuidToU32(shapeId), wordOffset);
  heapU32.set(uuidToU32(imageId), wordOffset + 4);
  heapU32[wordOffset + 8] = thumbnail ? 1 : 0;
  heapU8.set(bytes, offset + IMAGE_HEADER_SIZE);

  internal._store_image();
  call(app, KEY.requestRender, null);
}
