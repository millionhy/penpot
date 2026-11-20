// Viewport primitives of app.render-wasm.api (G4.2): the view transform,
// the render options that follow the dpr, and the viewport bootstrap.
//
// Every function here is a direct transcription of the CLJS body, including
// the guard each one uses. The distinction matters at runtime and is easy to
// get wrong when porting: `wasm/live?` (context exists, not lost) gates the
// reload-internal calls, while `wasm/ready?` (live and not mid-reload) gates
// the ones the application drives.
//
// Deviation: the compiled `initialize-viewport` ends in `set-objects`, which
// belongs to the shape-upload slice. The port takes it as a callback so the
// call order (_set_canvas_background, _set_view, _init_shapes_pool, upload)
// stays in one place and the upload slice plugs in without moving code.

import { call } from "./call";
import { hexToArgbU32 } from "./colors";
import { live, ready, type RenderWasmModule } from "./module";
import { uuidToU32 } from "./uuid";

export interface Point {
  x: number;
  y: number;
}

// The viewbox of the compiled API: design-space top-left corner. WASM takes
// the negated values (the view matrix translates instead of panning).
export function setView(module: RenderWasmModule, zoom: number, vbox: Point): void {
  call(module, "_set_view", zoom, -vbox.x, -vbox.y);
}

// set-viewer-viewport!: no interaction bookkeeping, just the transform and
// the tile-index rebuild. Used by the viewer's offscreen passes.
export function setViewerViewport(
  module: RenderWasmModule,
  zoom: number,
  vbox: Point,
): boolean {
  if (!ready()) return false;
  setView(module, zoom, vbox);
  call(module, "_set_view_end");
  return true;
}

// render-sync: paint the whole view synchronously. `initialized?` of the
// compiled API is the `ready?` guard here (live and not mid-reload).
export function renderSync(module: RenderWasmModule): boolean {
  if (!ready()) return false;
  call(module, "_render_sync");
  return true;
}

// render-sync-shape: paint a single shape over the current view. The
// compiled body also clears internal-frame-id afterwards; that is bookkeeping
// for later calls, and the TS port passes the id with every call.
export function renderSyncShape(module: RenderWasmModule, shapeId: string): boolean {
  if (!ready()) return false;
  const words = uuidToU32(shapeId);
  call(module, "_render_sync_shape", words[0], words[1], words[2], words[3]);
  return true;
}

// resize-viewbox: CSS pixels. Allowed during a reload after re-init, hence
// the `live?` guard instead of `ready?`.
export function resizeViewbox(
  module: RenderWasmModule,
  width: number,
  height: number,
): boolean {
  if (!live()) return false;
  call(module, "_resize_viewbox", width, height);
  return true;
}

export function setRenderOptions(
  module: RenderWasmModule,
  flags: number,
  dpr: number,
): boolean {
  if (!live()) return false;
  call(module, "_set_render_options", flags, dpr);
  return true;
}

export function setCanvasBackground(
  module: RenderWasmModule,
  hex: string,
  opacity = 1,
): boolean {
  if (!live()) return false;
  call(module, "_set_canvas_background", hexToArgbU32(hex, opacity));
  return true;
}

// --- Debug flags (api.cljs debug-flags)

export const DEBUG_FLAG_VIEWBOX = 0b0001;
export const DEBUG_FLAG_TEXT_EDITOR = 0b0100;
export const DEBUG_FLAG_RENDER_INFO = 0b1000;

export interface DebugFlagOptions {
  viewbox?: boolean;
  textEditorWasm?: boolean;
  renderInfo?: boolean;
}

export function debugFlags(options: DebugFlagOptions = {}): number {
  let flags = 0;
  if (options.viewbox === true) flags |= DEBUG_FLAG_VIEWBOX;
  if (options.textEditorWasm === true) flags |= DEBUG_FLAG_TEXT_EDITOR;
  if (options.renderInfo === true) flags |= DEBUG_FLAG_RENDER_INFO;
  return flags;
}

// --- Route parameters (wasm-get-numeric-value)

// A positive finite number from a query string or an already parsed value.
// The compiled helper parses strings with parseFloat and rejects NaN and
// non-positive values, so `?dpr=2` can be overridden but `?dpr=0` cannot.
export function numericValue(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number.parseFloat(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

export type RouteParams = Readonly<Record<string, unknown>> | URLSearchParams;

export function readNumericParam(params: RouteParams, name: string): number | undefined {
  if (params instanceof URLSearchParams) return numericValue(params.get(name));
  return numericValue(params[name]);
}

// The tunables init-canvas-context pushes with `_set_<name>` when the route
// carries them. Order is irrelevant; the list is the contract.
export const ROUTE_RENDER_PARAMS = [
  "antialias_threshold",
  "viewport_interest_area_threshold",
  "max_blocking_time_ms",
  "node_batch_threshold",
  "blur_downscale_threshold",
] as const;

export type RouteRenderParam = (typeof ROUTE_RENDER_PARAMS)[number];

// wasm-set-param-from-route-params-if-present, for the whole list. Returns
// the names that reached the module, which is what the tests assert on.
export function applyRouteParams(
  module: RenderWasmModule,
  params: RouteParams | undefined,
): RouteRenderParam[] {
  if (params === undefined) return [];
  const applied: RouteRenderParam[] = [];
  for (const name of ROUTE_RENDER_PARAMS) {
    const value = readNumericParam(params, name);
    if (value === undefined) continue;
    call(module, `_set_${name}`, value);
    applied.push(name);
  }
  return applied;
}

// --- Viewport bootstrap

export type ShapeMap =
  | Readonly<Record<string, unknown>>
  | ReadonlyMap<string, unknown>;

// `(count (vals base-objects))` of the compiled original: the shape pool
// capacity, which has to cover every object or the upload drops the tail.
export function objectCount(objects: ShapeMap): number {
  return objects instanceof Map ? objects.size : Object.keys(objects).length;
}

export interface InitializeViewportOptions {
  background?: string;
  backgroundOpacity?: number;
  // `set-objects` of the upload slice. Required: without it the viewport
  // would be transformed but empty.
  setObjects: (objects: ShapeMap) => void;
  // `stop-progressive-render!`: the compiled function cancels a pending tile
  // pass before it clears the shapes pool. Pass `RenderLoop#stopProgressiveRender`.
  stopProgressiveRender?: () => void;
}

// initialize-viewport: stop the pending pass, clear the background, place the
// view, size the shape pool and upload the objects. Returns false when the
// context is not live (the compiled body is a no-op then).
export function initializeViewport(
  module: RenderWasmModule,
  objects: ShapeMap,
  zoom: number,
  vbox: Point,
  options: InitializeViewportOptions,
): boolean {
  if (!live()) return false;

  options.stopProgressiveRender?.();
  if (options.background !== undefined) {
    setCanvasBackground(module, options.background, options.backgroundOpacity ?? 1);
  }
  setView(module, zoom, vbox);
  call(module, "_init_shapes_pool", objectCount(objects));
  options.setObjects(objects);
  return true;
}