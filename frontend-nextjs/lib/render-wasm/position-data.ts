// update-page-position-data (F6.4): computes the position-data of the text
// shapes that lack it, the port of update-page-position-data in
// app.main.data.viewer. The CLJS runs it after bundle-fetched through a
// dedicated 64x64 offscreen pass: init-canvas-context, then set-objects
// callback (a per-shape serializer this bundle does not export), then
// calculate-position-data per shape, then clear-canvas. The bundle is a
// fixed artifact older than that callback export, so the pass reuses the
// model the viewport already loaded instead: the viewport calls this from
// its on-render callback, after set-objects serialized the page and the
// font pass ran, which is the earliest point calculate-position-data is
// meaningful. The calculation itself is not ported: the compiled
// calculate_position_data does use-shape, calls into Rust and deserializes
// the result into a CLJS vector of plain maps, which is exactly what the
// CLJS wrapper consumes.
//
// calculate-position-data answers nil when the wasm context is not
// initialized (a thumbnail render may have torn it down). A pass that hits
// nil is not cached, so the next viewport run (after its re-init) retries.

import { KEY, call, get, keyword, type RendererApp } from "./interop";

export interface PositionDataResult {
  // The objects map with :position-data assoc'ed into the shapes that got
  // a fresh computation; the same reference when nothing changed.
  objects: unknown;
  // How many shapes were computed in this call (0 when the cache answered
  // or when every text shape already had position-data).
  computed: number;
  // True when the pass ran to completion (every missing shape computed, or
  // none missing) and its result is cached; false when a computation
  // answered nil and the pass must retry later.
  complete: boolean;
}

// One finished pass per app and page: later viewport runs (zoom changes,
// re-inits after a thumbnail render) answer from here. Only completed
// passes are cached, so a torn-down wasm context cannot freeze a partial
// result.
const positionCaches = new WeakMap<RendererApp, Map<string, unknown>>();

function isTextShape(app: RendererApp, shape: unknown): boolean {
  return call(app, KEY.textShapeQmark, shape) === true;
}

export function updatePagePositionData(
  app: RendererApp,
  objects: unknown,
  pageId: string,
): PositionDataResult {
  let cache = positionCaches.get(app);
  if (cache !== undefined) {
    const cached = cache.get(pageId);
    if (cached !== undefined) return { objects: cached, computed: 0, complete: true };
  }

  const positionDataKey = keyword(app, "position-data");
  let out = objects;
  let computed = 0;
  let complete = true;

  // The CLJS keeps the objects map unchanged and assocs per shape; the
  // walk here rebuilds nothing until a shape actually gets an entry.
  let s = call(app, KEY.seq, objects);
  while (s !== null && s !== undefined) {
    const entry = call(app, KEY.first, s);
    const shape = call(app, KEY.val, entry);
    const hasData = get(app, shape, positionDataKey);
    if (hasData === null && isTextShape(app, shape)) {
      const data = call(app, KEY.calculatePositionData, shape);
      if (data === null || data === undefined) {
        // The wasm context is not live (or the shape vanished): retry on
        // the next run instead of caching a half-done pass.
        complete = false;
      } else {
        const key = call(app, KEY.first, entry);
        const next = call(app, KEY.assoc, shape, positionDataKey, data);
        out = call(app, KEY.assoc, out, key, next);
        computed += 1;
      }
    }
    s = call(app, KEY.next, s);
  }

  if (complete) {
    if (cache === undefined) {
      cache = new Map();
      positionCaches.set(app, cache);
    }
    cache.set(pageId, out);
  }

  return { objects: out, computed, complete };
}
