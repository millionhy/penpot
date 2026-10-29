// The image tool model (第2项): the upload of a picked file and the rect
// shape that carries it as an image fill.
//
// Ported from:
// - frontend/src/app/main/data/workspace/media.cljs (process-blobs: a blob
//   at or past the chunk size goes through the three-step session API and
//   assemble-file-media-object, a smaller one goes straight through
//   upload-file-media-object; image-uploaded: the fill carries the media id,
//   its width/height, the mtype and keep-aspect-ratio, and the shape is a
//   rect centered on the drop point with the natural image size);
// - frontend/src/app/main/ui/workspace/top_toolbar.cljs (image-upload-tool*:
//   the file picker accepts the image types and allows several files; the
//   drop point is the center of the viewport);
// - common/src/app/common/types/shape.cljc (setup-proportions: an image
//   fill locks the proportion to width / height).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises the model.
//
// Deviations from the CLJS original, documented:
// - SVG files are rejected: the wasm image store decodes bitmaps only, and
//   the svg-upload path (svg->clj shape trees) is a later slice.
// - The image fires no notification and no loading indicator; the canvas
//   logs a failed upload and keeps the file untouched.

import { cmd, cmdUpload } from "@/lib/rpc";
import { DEFAULT_UPLOAD_CHUNK_SIZE, uploadBlobChunked } from "@/lib/uploads";
import { IDENTITY_TRANSFORM, type WorkspaceShape } from "@/lib/workspace";

// media/image-types; the picker accepts all of them even though the SVG
// branch answers an error below.
export const IMAGE_ACCEPT = "image/jpeg,image/png,image/webp,image/gif,image/svg+xml";

// The bitmap types the wasm image store can decode.
const BITMAP_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);

// media/strip-image-extension over the picked file name.
export function stripImageExtension(name: string): string {
  return name.replace(/\.[^./\\]+$/, "");
}

export function isBitmapImage(file: File): boolean {
  return BITMAP_TYPES.has(file.type);
}

// The media object the backend answers: the fields image-uploaded reads.
export interface UploadedImage {
  id: string;
  name?: string;
  width: number;
  height: number;
  mtype: string;
  [key: string]: unknown;
}

// process-blobs' upload-blob: the chunked session above the threshold,
// the one-shot multipart below it. is-local is false for the workspace
// picker (the files live on the server).
export async function uploadImage(file: File, fileId: string): Promise<UploadedImage> {
  const name = stripImageExtension(file.name) || "image";
  if (file.size >= DEFAULT_UPLOAD_CHUNK_SIZE) {
    const { sessionId } = await uploadBlobChunked(file);
    return cmd<UploadedImage>("assemble-file-media-object", {
      "session-id": sessionId,
      "file-id": fileId,
      "is-local": false,
      name,
      mtype: file.type,
    });
  }
  return cmdUpload<UploadedImage>("upload-file-media-object", {
    "file-id": fileId,
    "is-local": false,
    name,
    content: file,
  });
}

// types.fills/create with an image payload.
export function imageFill(image: UploadedImage): Record<string, unknown> {
  return {
    "fill-opacity": 1,
    "fill-image": {
      width: image.width,
      height: image.height,
      mtype: image.mtype,
      id: image.id,
      "keep-aspect-ratio": true,
    },
  };
}

// cf/resolve-file-media for a stored image: the media id under
// assets/by-file-media-id. A data-uri fill carries its payload inline
// instead (the CLJS prefers the data-uri when one is present).
export function imageMediaUrl(imageId: string, publicUri: string): string {
  const base = publicUri.endsWith("/") ? publicUri : publicUri + "/";
  return base + "assets/by-file-media-id/" + imageId;
}

// One image fill of a loaded shape. The renderer needs the pixels under the
// media id before it can draw the fill, and the shape id tells it which
// record to touch.
export interface ImageFillReference {
  shapeId: string;
  imageId: string;
  dataUri?: string;
}

// The key of one (shape, image) pair, shared by the reference scan and the
// remote-change diff below.
function referenceKey(shapeId: string, imageId: string): string {
  return shapeId + "\u0000" + imageId;
}

// The image fills of a loaded model, one entry per (shape, image) pair. The
// shapes come from lib/workspace; a fill without a string id is skipped.
export function imageFillReferences(
  objects: Readonly<Record<string, WorkspaceShape>>,
): ImageFillReference[] {
  const references: ImageFillReference[] = [];
  const seen = new Set<string>();
  for (const shape of Object.values(objects)) {
    if (shape === null || typeof shape !== "object") continue;
    const fills = shape.fills;
    if (!Array.isArray(fills)) continue;
    for (const fill of fills) {
      if (fill === null || typeof fill !== "object") continue;
      const image = (fill as { "fill-image"?: unknown })["fill-image"];
      if (image === null || typeof image !== "object") continue;
      const id = (image as { id?: unknown }).id;
      if (typeof id !== "string" || id.length === 0) continue;
      const key = referenceKey(shape.id, id);
      if (seen.has(key)) continue;
      seen.add(key);
      const dataUri = (image as { "data-uri"?: unknown })["data-uri"];
      references.push({
        shapeId: shape.id,
        imageId: id,
        ...(typeof dataUri === "string" ? { dataUri } : {}),
      });
    }
  }
  return references;
}

// The image fills the second model adds (F8.2): a remote change that draws a
// shape with an image fill, or sets one on an existing shape. The pairs the
// first model already had are registered in the wasm image store, so only
// the new ones need their pixels fetched. Order follows the second model.
export function newImageFillReferences(
  before: Readonly<Record<string, WorkspaceShape>>,
  after: Readonly<Record<string, WorkspaceShape>>,
): ImageFillReference[] {
  const known = new Set<string>();
  for (const reference of imageFillReferences(before)) {
    known.add(referenceKey(reference.shapeId, reference.imageId));
  }
  return imageFillReferences(after).filter(
    (reference) => !known.has(referenceKey(reference.shapeId, reference.imageId)),
  );
}

// The bytes of a base64 data-uri, or null when the payload is not one.
export function dataUriBytes(uri: string): Uint8Array | null {
  const comma = uri.indexOf(",");
  if (comma < 0) return null;
  const header = uri.slice(0, comma);
  if (!header.endsWith(";base64")) return null;
  let binary: string;
  try {
    binary = atob(uri.slice(comma + 1));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export interface ImageCenter {
  x: number;
  y: number;
}

// image-uploaded + create-and-add-shape :rect: the shape takes the natural
// image size, centers on the drop point (rounded, like mth/round) and locks
// its proportion. `id` and `parentId` come from the caller so the builder
// stays deterministic under test.
export function createImageShape(
  image: UploadedImage,
  center: ImageCenter,
  parentId: string,
  id: string,
): WorkspaceShape {
  const width = image.width > 0 ? image.width : 0.01;
  const height = image.height > 0 ? image.height : 0.01;
  const x = Math.round(center.x - width / 2);
  const y = Math.round(center.y - height / 2);
  const x2 = x + width;
  const y2 = y + height;
  return {
    id,
    type: "rect",
    name: image.name ?? "Image",
    "parent-id": parentId,
    "frame-id": parentId,
    x,
    y,
    width,
    height,
    selrect: { x, y, width, height, x1: x, y1: y, x2, y2 },
    points: [
      { x, y },
      { x: x2, y },
      { x: x2, y: y2 },
      { x, y: y2 },
    ],
    transform: { ...IDENTITY_TRANSFORM },
    "transform-inverse": { ...IDENTITY_TRANSFORM },
    rotation: 0,
    proportion: width / height,
    "proportion-lock": true,
    fills: [imageFill(image)],
    strokes: [],
    r1: 0,
    r2: 0,
    r3: 0,
    r4: 0,
  };
}
