// Worker-side thumbnail render (F9.14, engine port G4.6a): the port of
// render-thumbnail-with-wasm in frontend/src/app/worker/thumbnails.cljs.
//
// Since G4.6a the pass drives the TypeScript engine instead of the compiled
// $APP, in the same order the CLJS worker runs it:
//   decode get-file-data-for-thumbnail -> pick the use-for-thumbnail frame (or
//   the page bounds) -> OffscreenCanvas + initCanvasContext ->
//   initializeViewport(background, force-sync, render) ->
//   renderSyncShape (or renderSync) -> convertToBlob -> clearCanvas.
//
// Two shell-specific pieces remain:
// - The response's :objects is an app.common.types.objects-map ObjectsMap and
//   its transit read handler lives in app.main (main.js), which cannot load
//   in a worker. lib/transit already decodes the objects-map/v2 tag eagerly
//   into a plain uuid -> shape map, so the worker needs no CLJS handler.
// - The reference wraps the canvas PNG in an SVG with a background fill and
//   runs it through the rasterizer iframe, because it must produce a PNG for
//   create-file-thumbnail. The worker composes the same image directly: draw
//   the PNG on a 2D OffscreenCanvas painted with the page background and
//   convert that. No rasterizer round trip.
//
// Deviations, documented:
// - The CLJS pass flips wasm/disable-request-render? around the render; the
//   engine keeps that flag internal. The worker serializes requests and tears
//   the context down right after the blob, so no scheduled render can
//   interleave with the pass.
// - Google-backed and custom faces are not uploaded here (the worker has no
//   font catalog or bundle variants): the text writes the builtin face, the
//   same documented fallback as the viewer pass.

import {
  clearCanvas,
  fontIdToUuid,
  initCanvasContext,
  initializeViewport,
  objectBounds,
  renderSync,
  renderSyncShape,
  setObjects,
  updateTextLayout,
  writeHostAttrs,
  type ImageHost,
  type RenderWasmModule,
  type Shape,
} from "./render-wasm/engine";
import { resolveFileMedia } from "./viewer";
import {
  calculateDimensions,
  fixAspectRatio,
  thumbnailHeight,
  THUMBNAIL_WIDTH,
  type ThumbnailRect,
} from "./thumbnail";
import { decodeTransit } from "./transit";

// common/src/app/common/types/color.cljc cc/canvas: the backdrop the
// reference uses when the page has no background of its own.
export const DEFAULT_THUMBNAIL_BACKGROUND = "#E8E9EA";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

// The answer decodes to a plain uuid -> shape record: the objects-map transit
// handler builds a record, never a Map. The engine accepts either, but the
// bounds walk indexes by id, so the map union would not type.
export type ThumbnailObjects = Readonly<Record<string, unknown>>;

export interface ThumbnailPage {
  // Plain uuid -> shape map, the same model setObjects uploads.
  objects: ThumbnailObjects;
  // The frame marked use-for-thumbnail, or null when the page has none.
  frameId: string | null;
  // CSS color painted behind the render.
  background: string;
}

export interface ThumbnailRenderOptions {
  // Base URL of the media assets; empty means same origin.
  publicUri?: string;
  // Injected for the tests; the default fetches the URL and reads the body.
  fetchBytes?: (url: string) => Promise<Uint8Array>;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// The bounds walk reads plain records; the engine's upload `Shape` interface
// is the same data but carries no index signature.
function lookupShape(objects: ThumbnailObjects, id: string): Record<string, unknown> | undefined {
  const value = objects[id];
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

// get-file-data-for-thumbnail answers {:file-id ... :revn ... :page {...}}.
// The worker receives it undecoded (cmdRaw) and decodes it here; the
// objects-map read handler of lib/transit turns the page objects into a plain
// uuid -> shape map.
export function decodeThumbnailPage(raw: string): ThumbnailPage {
  const response = asRecord(decodeTransit<unknown>(raw));
  const page = asRecord(response?.page);
  if (page === undefined) {
    throw new Error("thumbnail: get-file-data-for-thumbnail answered without a page");
  }
  const objects = asRecord(page.objects);
  if (objects === undefined) {
    throw new Error("thumbnail: the page carries no objects");
  }
  const frame = page["thumbnail-frame-id"];
  const background = page.background;
  return {
    objects: objects as ThumbnailObjects,
    frameId: typeof frame === "string" ? frame : null,
    background:
      typeof background === "string" && background.length > 0
        ? background
        : DEFAULT_THUMBNAIL_BACKGROUND,
  };
}

function rectOf(bounds: { x: number; y: number; width: number; height: number }): ThumbnailRect {
  return {
    x: Number.isFinite(bounds.x) ? bounds.x : 0,
    y: Number.isFinite(bounds.y) ? bounds.y : 0,
    width: Number.isFinite(bounds.width) ? bounds.width : 0,
    height: Number.isFinite(bounds.height) ? bounds.height : 0,
  };
}

// app.common.types.shape-tree/get-root-objects: every shape reachable from
// the root's :shapes, frames themselves included but never entered, so a
// frame contributes its own content bounds once. The traversal order does
// not matter: the caller unions the rects. The bounds keep the compiled
// default of get-object-bounds (ignore-margin? true).
export function collectRootBounds(objects: ThumbnailObjects): ThumbnailRect[] {
  const root = lookupShape(objects, ZERO_UUID);
  if (root === undefined) return [];

  const pending: unknown[] = Array.isArray(root.shapes) ? [...root.shapes] : [];
  const bounds: ThumbnailRect[] = [];
  const processed = new Set<string>();

  while (pending.length > 0) {
    const id = pending.pop();
    if (typeof id !== "string" || processed.has(id)) continue;
    processed.add(id);

    const shape = lookupShape(objects, id);
    if (shape === undefined) continue;

    bounds.push(rectOf(objectBounds(objects, shape)));
    if (shape.type !== "frame") {
      const children: unknown[] = Array.isArray(shape.shapes) ? shape.shapes : [];
      for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]);
    }
  }
  return bounds;
}

// app.main.render/calculate-dimensions decides the page view box when no
// frame is marked; a marked frame contributes its own bounds. Both branches
// then fix the 2:3 aspect ratio, exactly like the reference worker.
export function computeViewBox(page: ThumbnailPage): ThumbnailRect {
  if (page.frameId !== null) {
    const frame = lookupShape(page.objects, page.frameId);
    if (frame !== undefined) {
      return fixAspectRatio(rectOf(objectBounds(page.objects, frame)));
    }
  }
  return calculateDimensions(collectRootBounds(page.objects));
}

// render-canvas-blob: the reference renders the PNG into an SVG whose
// background is the page color, then rasterizes it. The same pixels come
// from painting the background under the rendered bitmap.
async function compositeOnBackground(
  blob: Blob,
  width: number,
  height: number,
  background: string,
): Promise<Blob> {
  const bitmap = await createImageBitmap(blob);
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx === null) throw new Error("thumbnail: could not create a 2D context");
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    return await canvas.convertToBlob({ type: "image/png" });
  } finally {
    bitmap.close();
  }
}

interface UploadWork {
  textIds: string[];
  thumbnails: Promise<void>[];
  full: Promise<void>[];
}

// The host half of the upload: media URLs for fill/stroke images and the
// builtin font fallback for text. Every promise settles even on failure, so
// the pass can await them without a rejection stopping the thumbnail.
function createHost(module: RenderWasmModule, options: ThumbnailRenderOptions) {
  const publicUri = options.publicUri ?? "";
  const images: ImageHost = {
    resolveUrl: (imageId, thumbnail) =>
      resolveFileMedia(publicUri, { id: imageId }, { thumbnail }),
    ...(options.fetchBytes === undefined ? {} : { fetchBytes: options.fetchBytes }),
    onError: (cause: unknown, imageId: string) =>
      console.warn("[render-wasm] could not load a thumbnail asset:", imageId, cause),
  };

  const work: UploadWork = { textIds: [], thumbnails: [], full: [] };

  const onShape = (shape: Shape): void => {
    if (shape.type === "text") work.textIds.push(shape.id);
    const result = writeHostAttrs(module, shape, {
      text: {
        writeOptions: { normalizeFontId: (fontId) => fontIdToUuid(fontId) },
      },
      images,
      // The cold-load batch already carried the layout and the fills/strokes;
      // only the grid tracks and the host data remain.
      skipLayout: true,
      skipFillsStrokes: true,
    });
    for (const item of result.thumbnails) work.thumbnails.push(item);
    for (const item of result.full) work.full.push(item);
  };

  // process-pending: the layouts run first, then the thumbnail images, then
  // the full variants in order; a relayout follows so the text uses the
  // metrics of whatever landed.
  const settle = async (): Promise<void> => {
    for (const id of work.textIds) updateTextLayout(module, id);
    if (work.thumbnails.length > 0 || work.full.length > 0) {
      await Promise.allSettled(work.thumbnails);
      for (const item of work.full) {
        try {
          await item;
        } catch {
          // loadImage already reports; a rejection must not stop the pass.
        }
      }
      for (const id of work.textIds) updateTextLayout(module, id);
    }
  };

  return { onShape, settle };
}

// The wasm pass itself. The caller (the worker) serializes requests, and the
// context is torn down right after the blob.
export async function renderThumbnail(
  module: RenderWasmModule,
  page: ThumbnailPage,
  width: number = THUMBNAIL_WIDTH,
  options: ThumbnailRenderOptions = {},
): Promise<Blob> {
  const height = thumbnailHeight(width);
  // OffscreenCanvas truncates its size arguments; pass what the canvas
  // actually gets so the 2D composite matches the GL surface.
  const canvasWidth = Math.max(1, Math.trunc(width));
  const canvasHeight = Math.max(1, Math.trunc(height));
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  if (initCanvasContext(module, canvas) === undefined) {
    throw new Error("thumbnail: could not create a GL context");
  }

  const vbox = computeViewBox(page);
  const zoom = canvasWidth / vbox.width;
  const host = createHost(module, options);

  try {
    await new Promise<void>((resolve, reject) => {
      // initialize-viewport fires the render callback once (setObjects'
      // completion); the latch guards a second fire.
      let fired = false;
      const doRender = (): void => {
        if (fired) return;
        fired = true;
        void (async () => {
          try {
            await host.settle();
            if (page.frameId !== null) renderSyncShape(module, page.frameId);
            else renderSync(module);
            resolve();
          } catch (cause) {
            reject(cause);
          }
        })();
      };

      const started = initializeViewport(module, page.objects, zoom, vbox, {
        background: page.background,
        backgroundOpacity: 1,
        setObjects: (objects) => {
          setObjects(module, objects, {
            forceSync: true,
            onShape: host.onShape,
            render: doRender,
          });
        },
      });
      if (!started) {
        reject(new Error("thumbnail: could not initialize the viewport"));
      }
    });

    const rendered = await canvas.convertToBlob({ type: "image/png" });
    return await compositeOnBackground(rendered, canvasWidth, canvasHeight, page.background);
  } finally {
    // clear-canvas uses the reference defaults (lose-browser-context? true):
    // each pass owns its OffscreenCanvas, so nothing is kept for reuse.
    clearCanvas(module);
  }
}

// The worker entry: one raw RPC answer in, one PNG out.
export function renderThumbnailFromRaw(
  module: RenderWasmModule,
  raw: string,
  width: number = THUMBNAIL_WIDTH,
  options: ThumbnailRenderOptions = {},
): Promise<Blob> {
  return renderThumbnail(module, decodeThumbnailPage(raw), width, options);
}