// The host side of the wasm image registry (第2项 image tool), over the
// TypeScript engine (G4.6b).
//
// `engine/image.ts` owns the buffer layout:
//   0..16   shape uuid
//   16..32  image uuid (the file media object id)
//   32..36  is_thumbnail flag (u32, little endian)
//   36..    the encoded image bytes
//
// The image fill in the shape record references the same media id, so the
// renderer resolves the bitmap as soon as the next frame runs. The shape must
// be in the wasm model before this call.

import { storeImage } from "@/lib/render-wasm/engine";
import type { WorkspaceApp } from "@/lib/render-wasm/workspace-app";

// Register the pixels of one image file under the media id of the fill.
export function storeImageBytes(
  app: WorkspaceApp,
  shapeId: string,
  imageId: string,
  bytes: Uint8Array,
  thumbnail = false,
): void {
  storeImage(app.module, shapeId, imageId, bytes, thumbnail);
  app.loop.requestRender("store-image");
}
