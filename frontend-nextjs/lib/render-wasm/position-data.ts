// update-page-position-data (F6.4, engine port of G4.5b): computes the
// position-data of the text shapes that lack it, the port of
// update-page-position-data in app.main.data.viewer.
//
// The CLJS runs a dedicated 64x64 offscreen pass: init-canvas-context, then
// set-objects-callback over the shapes, then calculate-position-data per
// shape, then clear-canvas. The engine viewer already uploaded the whole page
// to the shared context, so this module reuses that model instead: the
// viewport calls it from its on-render callback, after the set-objects pass
// serialized the page and the font pass ran, which is the earliest point
// calculate-position-data is meaningful.
//
// calculate-position-data answers undefined when the wasm context is not
// ready (a thumbnail render may have torn it down). A pass that hits
// undefined is not cached, so the next viewport run (after its re-init)
// retries.
//
// Deviations from the CLJS original, documented:
// - The CLJS feeds the calculations through a throwaway context holding only
//   the text shapes; this port asks the shared viewer context, which holds
//   the whole page. The returned value is the same attrs vector.
// - The CLJS applies the result as :mod-obj changes so the viewer model
//   carries the position-data; the port returns the updated map and the
//   viewport only records the pass state. The hotspot layer never reads
//   position-data, so the model stays untouched until a consumer needs it.

import { calculatePositionData, type PositionDataAttrs } from "./engine/position-data";
import type { PositionDataShape } from "./engine/position-data";
import type { RenderWasmModule } from "./engine";

export interface PositionDataResult {
  // The objects map with position-data assoc'ed into the shapes that got a
  // fresh computation; the same reference when nothing changed.
  objects: Readonly<Record<string, unknown>>;
  // How many shapes were computed in this call (0 when the cache answered
  // or when every text shape already had position-data).
  computed: number;
  // True when the pass ran to completion (every missing shape computed, or
  // none missing) and its result is cached; false when a computation
  // answered undefined and the pass must retry later.
  complete: boolean;
}

// One finished pass per module and page: later viewport runs (zoom changes,
// re-inits after a thumbnail render) answer from here. Only completed passes
// are cached, so a torn-down wasm context cannot freeze a partial result.
const positionCaches = new WeakMap<
  RenderWasmModule,
  Map<string, Readonly<Record<string, unknown>>>
>();

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function updatePagePositionData(
  module: RenderWasmModule,
  objects: Readonly<Record<string, unknown>>,
  pageId: string,
): PositionDataResult {
  let cache = positionCaches.get(module);
  if (cache !== undefined) {
    const cached = cache.get(pageId);
    if (cached !== undefined) return { objects: cached, computed: 0, complete: true };
  }

  let out: Readonly<Record<string, unknown>> = objects;
  let computed = 0;
  let complete = true;

  // The walk rebuilds the map only when a shape actually gets an entry, and
  // then copies once: the shape loop runs on the original values.
  const updates = new Map<string, PositionDataAttrs[]>();
  for (const [id, shape] of Object.entries(objects)) {
    if (!isObject(shape)) continue;
    if (shape.type !== "text") continue;
    if (shape["position-data"] !== undefined && shape["position-data"] !== null) continue;
    // A text shape always carries both fields on decoded objects.
    const data = calculatePositionData(module, shape as unknown as PositionDataShape);
    if (data === undefined) {
      // The wasm context is not ready (or the shape vanished): retry on the
      // next run instead of caching a half-done pass.
      complete = false;
      continue;
    }
    updates.set(id, data);
    computed += 1;
  }

  if (updates.size > 0) {
    const next: Record<string, unknown> = { ...objects };
    for (const [id, data] of updates) {
      next[id] = { ...(objects[id] as Record<string, unknown>), "position-data": data };
    }
    out = next;
  }

  if (complete) {
    if (cache === undefined) {
      cache = new Map();
      positionCaches.set(module, cache);
    }
    cache.set(pageId, out);
  }

  return { objects: out, computed, complete };
}

// Test seam: drop the cached passes of one module (the module singleton
// outlives a page switch between tests).
export function resetPositionDataCache(module: RenderWasmModule): void {
  positionCaches.delete(module);
}
