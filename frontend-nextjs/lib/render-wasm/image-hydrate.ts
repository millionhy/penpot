// The image-fill hydration shared by the page load and the remote changes
// (F8.2). The renderer draws an image fill only once the pixels of its media
// id sit in the wasm image store, and the fill itself carries just the media
// id: the host fetches the bytes and registers them under the (shape, image)
// pair.
//
// The page load ran this as a closure in the canvas (第2项 image tool); a
// remote file-change that adds a shape with an image fill, or sets a fill on
// an existing one, needs the same work, so it lives here as one helper.
//
// One fetch per media id (a second shape with the same image reuses the
// bytes), one store call per (shape, image) pair. A failing fetch leaves an
// empty fill and only reports through onError; it never fails the caller.
// The stroke-image fills of a legacy file stay until their slice lands.

import { config } from "@/lib/config";
import type { RendererApp } from "@/lib/render-wasm/interop";
import { storeImageBytes } from "@/lib/render-wasm/image-store";
import {
  dataUriBytes,
  imageMediaUrl,
  type ImageFillReference,
} from "@/lib/workspace-image";

export interface ImageHydrateOptions {
  // The origin the media endpoint lives under; default config.publicUri.
  publicUri?: string;
  // Injected for the tests; default is fetch + arrayBuffer.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
  // Injected for the tests; default writes through storeImageBytes.
  store?: (shapeId: string, imageId: string, bytes: Uint8Array) => void;
  // The load effect passes its mount guard so a disposed canvas stops
  // halfway; the remote path has none and leaves it undefined.
  isAlive?: () => boolean;
  onError?: (cause: unknown) => void;
}

async function defaultFetchBytes(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`the media fetch answered ${response.status}`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

export async function hydrateImageReferences(
  app: RendererApp,
  references: readonly ImageFillReference[],
  options: ImageHydrateOptions = {},
): Promise<void> {
  if (references.length === 0) return;
  const publicUri = options.publicUri ?? config.publicUri;
  const fetchBytes = options.fetchBytes ?? defaultFetchBytes;
  const store =
    options.store ??
    ((shapeId: string, imageId: string, bytes: Uint8Array): void => {
      storeImageBytes(app, shapeId, imageId, bytes);
    });
  const cache = new Map<string, Uint8Array>();

  for (const reference of references) {
    try {
      let bytes = cache.get(reference.imageId);
      if (bytes === undefined) {
        const dataUri = reference.dataUri;
        if (dataUri !== undefined) {
          const decoded = dataUriBytes(dataUri);
          if (decoded === null) continue;
          bytes = decoded;
        } else {
          bytes = await fetchBytes(imageMediaUrl(reference.imageId, publicUri));
        }
        cache.set(reference.imageId, bytes);
      }
      // The fetch awaited above may outlive the canvas of the load effect.
      if (options.isAlive !== undefined && !options.isAlive()) return;
      store(reference.shapeId, reference.imageId, bytes);
    } catch (cause: unknown) {
      if (options.onError !== undefined) options.onError(cause);
      else console.warn("[workspace] could not load an image fill:", cause);
    }
  }
}
