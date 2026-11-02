// Worker-side thumbnail render (F9.14): the TypeScript port of
// render-thumbnail-with-wasm in frontend/src/app/worker/thumbnails.cljs.
//
// The flow matches the reference step for step:
//   decode get-file-data-for-thumbnail → pick the use-for-thumbnail frame (or
//   the page bounds) → OffscreenCanvas + init-canvas-context →
//   initialize-viewport(zoom, vbox, background, force-sync, on-render) →
//   render-sync-shape (or render-sync) → convertToBlob → clear-canvas.
//
// Two shell-specific pieces:
// - The response's :objects is an app.common.types.objects-map ObjectsMap,
//   and its transit read handler lives in app.main (main.js). main.js cannot
//   load in a worker (its module body needs a document), so the worker
//   registers the handler itself (registerObjectsMapHandler) with an eager
//   decoder: uuid -> transit-encoded shape string becomes uuid -> shape map.
// - The reference wraps the canvas PNG in an SVG with a background fill and
//   runs it through the rasterizer iframe, because it must produce a PNG for
//   create-file-thumbnail. The worker composes the same image directly: draw
//   the PNG on a 2D OffscreenCanvas painted with the page background and
//   convert that. No rasterizer round trip.
//
// Deviations, documented: the reference flips wasm/disable-request-render?
// around the pass; that atom is closure-private (same limitation as
// lib/render-wasm/frame-render.ts). The worker serializes requests and the
// context is torn down right after the blob, so no scheduled render can
// interleave with the pass.

import {
  arrayMap,
  call,
  get,
  KEY,
  keyword,
  uuid,
  type RendererApp,
} from "./render-wasm/interop";
import { renderSync, renderSyncShape } from "./render-wasm/pass-common";
import {
  calculateDimensions,
  fixAspectRatio,
  thumbnailHeight,
  THUMBNAIL_WIDTH,
  type ThumbnailRect,
} from "./thumbnail";

// common/src/app/common/types/color.cljc cc/canvas: the backdrop the
// reference uses when the page has no background of its own.
export const DEFAULT_THUMBNAIL_BACKGROUND = "#E8E9EA";

export const OBJECTS_MAP_TAG = "penpot/objects-map/v2";

const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

export interface ThumbnailPage {
  // CLJS map of uuid -> shape, as the renderer's set-objects expects.
  objects: unknown;
  // The frame marked use-for-thumbnail, or null when the page has none.
  frameId: string | null;
  // CSS color painted behind the render.
  background: string;
}

// The eager replacement for app.common.types.objects-map/from-data. transit
// calls it with the wire map (uuid -> transit-encoded shape string); every
// value is decoded now so the renderer sees plain CLJS shape maps. The
// ObjectsMap type itself would decode lazily on lookup, but it lives in
// app.main, which the worker cannot evaluate.
export function decodeObjectsMap(app: RendererApp, rep: unknown): unknown {
  let result = arrayMap(app, []);
  for (let s = call(app, KEY.seq, rep); s !== null && s !== undefined; s = call(app, KEY.next, s)) {
    const entry = call(app, KEY.first, s);
    const key = call(app, KEY.first, entry);
    const encoded = call(app, KEY.val, entry);
    result = call(app, KEY.assoc, result, key, call(app, KEY.decodeStr, encoded));
  }
  return result;
}

// add-handlers! takes one handler map per argument, and the variadic
// extraction takes the rest as an array. The map must be a real CLJS map:
// add-handlers! filters it with the :rfn keyword, and a plain JS object has
// no keyword lookup.
export function registerObjectsMapHandler(app: RendererApp): void {
  const handler = arrayMap(app, [
    [keyword(app, "id"), OBJECTS_MAP_TAG],
    [keyword(app, "rfn"), (rep: unknown) => decodeObjectsMap(app, rep)],
  ]);
  call(app, KEY.addHandlers, [handler]);
}

// get-file-data-for-thumbnail answers {:file-id ... :revn ... :page {...}}.
// The worker receives it undecoded (cmdRaw) because the shell's transit-js
// decoder has no penpot read handlers; only the compiled one does.
export function decodeThumbnailPage(app: RendererApp, raw: string): ThumbnailPage {
  const response = call(app, KEY.decodeStr, raw);
  const page = get(app, response, keyword(app, "page"));
  if (page === null || page === undefined) {
    throw new Error("thumbnail: get-file-data-for-thumbnail answered without a page");
  }
  const objects = get(app, page, keyword(app, "objects"));
  if (objects === null || objects === undefined) {
    throw new Error("thumbnail: the page carries no objects");
  }
  const frame = get(app, page, keyword(app, "thumbnail-frame-id"));
  const frameId = frame === null || frame === undefined ? null : call(app, KEY.str, frame);
  const background = get(app, page, keyword(app, "background"));
  return {
    objects,
    frameId: typeof frameId === "string" ? frameId : null,
    background:
      typeof background === "string" && background.length > 0
        ? background
        : DEFAULT_THUMBNAIL_BACKGROUND,
  };
}

function readNumber(app: RendererApp, map: unknown, name: string): number {
  const value = get(app, map, keyword(app, name));
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function rectFromBounds(app: RendererApp, bounds: unknown): ThumbnailRect {
  return {
    x: readNumber(app, bounds, "x"),
    y: readNumber(app, bounds, "y"),
    width: readNumber(app, bounds, "width"),
    height: readNumber(app, bounds, "height"),
  };
}

function collectShapes(app: RendererApp, shape: unknown): unknown[] {
  const ids: unknown[] = [];
  const shapes = get(app, shape, keyword(app, "shapes"));
  for (let s = call(app, KEY.seq, shapes); s !== null && s !== undefined; s = call(app, KEY.next, s)) {
    ids.push(call(app, KEY.first, s));
  }
  return ids;
}

// app.common.types.shape-tree/get-root-objects: every shape reachable from
// the root's :shapes, frames themselves included but never entered, so a
// frame contributes its own content bounds once. The traversal order does
// not matter: the caller unions the rects.
export function collectRootBounds(app: RendererApp, objects: unknown): ThumbnailRect[] {
  const root = get(app, objects, uuid(app, ZERO_UUID));
  if (root === null || root === undefined) return [];

  const pending = collectShapes(app, root);
  const bounds: ThumbnailRect[] = [];
  const processed = new Set<string>();

  while (pending.length > 0) {
    const id = pending.pop();
    const key = call(app, KEY.str, id);
    if (typeof key !== "string" || processed.has(key)) continue;
    processed.add(key);

    const shape = get(app, objects, id);
    if (shape === null || shape === undefined) continue;

    bounds.push(
      rectFromBounds(app, call(app, KEY.getObjectBounds, objects, shape)),
    );
    if (call(app, KEY.frameShapeQmark, shape) !== true) {
      const children = collectShapes(app, shape);
      for (let i = children.length - 1; i >= 0; i -= 1) pending.push(children[i]);
    }
  }
  return bounds;
}

// app.main.render/calculate-dimensions decides the page view box when no
// frame is marked; a marked frame contributes its own bounds. Both branches
// then fix the 2:3 aspect ratio, exactly like the reference worker.
export function computeViewBox(app: RendererApp, page: ThumbnailPage): ThumbnailRect {
  if (page.frameId !== null) {
    const frame = get(app, page.objects, uuid(app, page.frameId));
    if (frame !== null && frame !== undefined) {
      const bounds = call(app, KEY.getObjectBounds, page.objects, frame);
      return fixAspectRatio(rectFromBounds(app, bounds));
    }
  }
  return calculateDimensions(collectRootBounds(app, page.objects));
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

// The maximum time the worker waits for the async image pipeline
// (process-pending's rx/merge-map fetching media fills) before it
// force-renders without images. After `initialize-viewport` returns,
// shapes + text layouts are done; a subsequent `renderSync` produces
// a usable (image-less) thumbnail for the dashboard grid.
const RENDER_TIMEOUT_MS = 8_000;

// The wasm pass itself. Serialized by the caller (the worker runs one
// request at a time).
export function renderThumbnail(
  app: RendererApp,
  page: ThumbnailPage,
  width: number = THUMBNAIL_WIDTH,
): Promise<Blob> {
  const height = thumbnailHeight(width);
  // OffscreenCanvas truncates its size arguments; pass what the canvas
  // actually gets so the 2D composite matches the GL surface.
  const canvasWidth = Math.max(1, Math.trunc(width));
  const canvasHeight = Math.max(1, Math.trunc(height));
  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const gl = call(app, KEY.initCanvasContext, canvas);
  if (!gl) {
    return Promise.reject(new Error("thumbnail: could not create a GL context"));
  }

  const vbox = computeViewBox(app, page);
  const zoom = canvasWidth / vbox.width;

  return new Promise<Blob>((resolve, reject) => {
    // initialize-viewport fires on-render once (set-objects-sync's
    // completion callback); the latch guards a second fire.
    let fired = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const doRender = (): void => {
      if (fired) return;
      fired = true;
      if (timer !== null) { clearTimeout(timer); timer = null; }
      void (async () => {
        try {
          if (page.frameId !== null) renderSyncShape(app, page.frameId);
          else renderSync(app);
          const rendered = await canvas.convertToBlob({ type: "image/png" });
          resolve(await compositeOnBackground(rendered, canvasWidth, canvasHeight, page.background));
        } catch (cause) {
          reject(cause);
        } finally {
          // clear-canvas hands the GL context back with the reference's
          // defaults (lose-browser-context? true): each pass uses its own
          // OffscreenCanvas, so nothing is kept for reuse.
          call(app, KEY.clearCanvas, arrayMap(app, []));
        }
      })();
    };

    const onRender = (): void => doRender();

    // initialize-viewport reads :x/:y from the bounds and the rest from the
    // options map (background + force-sync + the render callback).
    call(
      app,
      KEY.initializeViewport,
      page.objects,
      zoom,
      arrayMap(app, [
        [keyword(app, "x"), vbox.x],
        [keyword(app, "y"), vbox.y],
      ]),
      arrayMap(app, [
        [keyword(app, "background"), page.background],
        [keyword(app, "force-sync"), true],
        [keyword(app, "on-render"), onRender],
      ]),
    );

    // Fallback: if on-render hasn't fired by now (sync path already fired
    // it inline), the async image pipeline is in-flight.  Start a timeout
    // so that stalled fetches (e.g. media server unreachable) don't hang
    // the worker forever.
    if (!fired) {
      timer = setTimeout(doRender, RENDER_TIMEOUT_MS);
    }
  });
}

// The worker entry: one raw RPC answer in, one PNG out.
export async function renderThumbnailFromRaw(
  app: RendererApp,
  raw: string,
  width: number = THUMBNAIL_WIDTH,
): Promise<Blob> {
  return renderThumbnail(app, decodeThumbnailPage(app, raw), width);
}