// F9.3: the interactive-transform preview protocol and the post-commit
// geometry push, both replicated over the internal module
// (app.render-wasm.wasm/internal-module) because their $APP wrappers are
// inlined away by the optimizer (same precedent as pass-common.ts).
//
// The two CLJS homes mirrored here:
// - app.render-wasm.api: set-modifiers-start / set-modifiers / set-modifiers-
//   end / clean-modifiers, the per-gesture transform overrides the drag
//   preview paints with (a gesture sends the whole set again every frame);
// - app.render-wasm.shape: process-shape! + set-wasm-attr! for the attrs a
//   translation touches. Only :selrect and the path content of :path/:bool
//   shapes are backed in wasm (:x / :y / :points / :position-data fall
//   through to "property not in WASM"), which is exactly _use_shape +
//   _set_shape_selrect (+ the chunked path content) per shape.
//
// F9.3 T1 probe record (dev build, runtime-verified): every entry point
// below exists as a function; HEAPU8/HEAPU32/HEAPF32 are live views;
// _alloc_bytes(40) answers an offset and _free_bytes releases it; the
// modifiers start/end/clean lifecycle runs without trapping; request-render
// and wasm/ready? are plain functions on $APP; the get-file response carries
// revn (19), vern (0) and permissions["can-edit"] (true) under those exact
// keys.
//
// Buffer discipline (render-wasm/src/mem.rs): BUFFERU8 is a single slot.
// Every _alloc_bytes must be consumed by its consumer call (_set_modifiers,
// _set_shape_path_chunk_buffer) or released with _free_bytes, in the same
// synchronous task; a second alloc before that errors "Bytes already
// allocated". _free_bytes takes NO arguments. The heap views are re-read
// after every alloc: memory growth detaches the previous typed arrays.

import { call, KEY, uuidToU32, type RendererApp } from "./interop";

// MODIFIER-U8-SIZE (app.render-wasm.api): one uuid as 4 x u32 (16 bytes)
// followed by one matrix as 6 x f32 (24 bytes): a, b, c, d, e, f in that
// slot order (probed against TransformEntry's [u8; 40] layout).
const MODIFIER_U8_SIZE = 40;

// MAX_BUFFER_CHUNK_SIZE (app.common.render-wasm.api.props): the path content
// travels in 256 KiB chunks of the u32-addressed heap.
const MAX_PATH_CHUNK_BYTES = 256 * 1024;

// The (a, b, c, d, e, f) tuple of a penpot matrix; a translation uses
// (1, 0, 0, 1, dx, dy).
export type Matrix6 = readonly [number, number, number, number, number, number];

type InternalModule = Record<string, (...args: number[]) => unknown>;

function internalModule(app: RendererApp): InternalModule {
  const internal = app[KEY.internalModule] as InternalModule | undefined;
  if (internal === undefined) {
    throw new Error("render-wasm: internal module is not available");
  }
  return internal;
}

// The heap views live as properties on the same module object; read them
// through the module so a growth-swapped view is picked up on each read.
function heapU32Of(internal: InternalModule): Uint32Array {
  return internal.HEAPU32 as unknown as Uint32Array;
}

function heapF32Of(internal: InternalModule): Float32Array {
  return internal.HEAPF32 as unknown as Float32Array;
}

// True when the compiled internal module exposes `name` as a function. The
// module object is replaced during boot and its methods can disappear on a
// wasm rebuild, so callers query it right before enabling a feature.
export function hasInternal(app: RendererApp, name: string): boolean {
  const internal = app[KEY.internalModule] as Record<string, unknown> | undefined;
  return internal !== undefined && typeof internal[name] === "function";
}

// The internal entry points the drag preview needs (the set-modifiers
// protocol over a single packed allocation).
export const DRAG_PREVIEW_INTERNALS = [
  "_set_modifiers_start",
  "_set_modifiers",
  "_set_modifiers_end",
  "_clean_modifiers",
  "_alloc_bytes",
] as const;

// The entry points the post-commit geometry push needs (use-shape, selrect
// and the chunked path content of path/bool shapes).
export const GEOMETRY_PUSH_INTERNALS = [
  "_use_shape",
  "_set_shape_selrect",
  "_start_shape_path_buffer",
  "_set_shape_path_chunk_buffer",
  "_set_shape_path_buffer",
] as const;

// The subset of `names` missing from the internal module; empty when the
// ABI is complete. Callers warn once and disable the dependent feature.
export function missingInternals(app: RendererApp, names: readonly string[]): string[] {
  return names.filter((name) => !hasInternal(app, name));
}

function requestRender(app: RendererApp, cause: string): void {
  call(app, KEY.requestRender, cause);
}

// --- the interactive-transform preview (set-modifiers protocol) -------------

// Enter interactive transform mode: fast mode plus the atlas backdrop, so
// tiles are not rasterized sequentially mid-gesture. Pairs with endModifiers;
// the CLJS toggles it once per gesture (app.render-wasm.gesture).
export function startModifiers(app: RendererApp): void {
  internalModule(app)._set_modifiers_start();
}

// Leave interactive transform mode. Any pending async render scheduled under
// it is cancelled; the caller triggers the full-quality render once the
// gesture ends (a geometry push or a plain request-render).
export function endModifiers(app: RendererApp): void {
  internalModule(app)._set_modifiers_end();
}

// Drop every active modifier: the overrides stop applying and the shapes
// snap back to their base geometry in the next render. No render is
// requested here, mirroring app.render-wasm.api/clean-modifiers.
export function cleanModifiers(app: RendererApp): void {
  internalModule(app)._clean_modifiers();
}

// The cancellation path of a gesture (Escape, pointercancel, failed commit):
// end the interactive mode, drop the overrides and request the render that
// shows the base geometry again — the clear-local-transform sequence.
export function resetModifierPreview(app: RendererApp): void {
  endModifiers(app);
  cleanModifiers(app);
  requestRender(app, "clean-modifiers");
}

// Push one preview frame: the per-shape transform overrides. `entries` maps
// shape id -> matrix and MUST be the whole move set (the wasm side replaces
// its modifier map). The translation preview splats the same
// (1, 0, 0, 1, dx, dy) matrix over every shape of the move set.
export function configureModifiers(
  app: RendererApp,
  entries: ReadonlyArray<readonly [string, Matrix6]>,
): void {
  if (entries.length === 0) return;
  const internal = internalModule(app);
  const offset = internal._alloc_bytes(MODIFIER_U8_SIZE * entries.length) as number;
  // Re-read the heap views after the allocation: growth detaches them.
  const heapU32 = heapU32Of(internal);
  const heapF32 = heapF32Of(internal);
  let off32 = offset >> 2;
  for (const [id, matrix] of entries) {
    heapU32.set(uuidToU32(id), off32);
    off32 += 4;
    heapF32[off32 + 0] = matrix[0];
    heapF32[off32 + 1] = matrix[1];
    heapF32[off32 + 2] = matrix[2];
    heapF32[off32 + 3] = matrix[3];
    heapF32[off32 + 4] = matrix[4];
    heapF32[off32 + 5] = matrix[5];
    off32 += 6;
  }
  internal._set_modifiers();
  requestRender(app, "set-modifiers");
}

// --- the post-commit geometry push ------------------------------------------

// The geometry slice of a committed shape: the new selrect and, for
// path/bool shapes, the translated packed path bytes (28 per segment).
export interface GeometryShape {
  readonly id: string;
  readonly type: string;
}

export interface ShapeGeometry {
  readonly selrect: {
    readonly x1: number;
    readonly y1: number;
    readonly x2: number;
    readonly y2: number;
  };
  readonly pathContent?: Uint8Array;
}

function isPathLike(type: string): boolean {
  return type === "path" || type === "bool";
}

// set-wasm-attr! for one committed shape: make it current in the wasm pool,
// then push the new selrect and (path/bool) the new path content. The
// callers run this after a successful update-file, in the same task as the
// preview cleanup so no intermediate frame shows the stale geometry.
export function pushShapeGeometry(
  app: RendererApp,
  shape: GeometryShape,
  geometry: ShapeGeometry,
): void {
  const internal = internalModule(app);
  const [a, b, c, d] = uuidToU32(shape.id);
  internal._use_shape(a, b, c, d);
  const { x1, y1, x2, y2 } = geometry.selrect;
  internal._set_shape_selrect(x1, y1, x2, y2);
  if (geometry.pathContent !== undefined && isPathLike(shape.type)) {
    pushPathContent(app, geometry.pathContent);
  }
}

// set-shape-path-content (app.common.render-wasm.api.props): zero-pad the
// bytes to the u32 alignment, split them into <= 256 KiB chunks; each chunk
// copy consumes one buffer allocation and the trailing call rebuilds the
// current shape's segments from the accumulated buffer.
export function pushPathContent(app: RendererApp, bytes: Uint8Array): void {
  const internal = internalModule(app);
  const paddedLength = Math.ceil(bytes.byteLength / 4) * 4;
  const padded = new Uint8Array(paddedLength);
  padded.set(bytes);
  internal._start_shape_path_buffer();
  for (let offset = 0; offset < paddedLength; offset += MAX_PATH_CHUNK_BYTES) {
    const end = Math.min(offset + MAX_PATH_CHUNK_BYTES, paddedLength);
    const chunk = padded.subarray(offset, end);
    const words = new Uint32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength >>> 2);
    const heapOffset = (internal._alloc_bytes(chunk.byteLength) as number) >> 2;
    const heapU32 = heapU32Of(internal);
    heapU32.set(words, heapOffset);
    internal._set_shape_path_chunk_buffer();
  }
  internal._set_shape_path_buffer();
}

// The post-commit sequence (F9.3 AD7): leave the preview mode, drop the
// overrides, re-push every moved shape's geometry and request one
// full-quality render — all in the same synchronous task, so the switch
// from preview to committed geometry never shows an intermediate frame.
export function commitShapeGeometry(
  app: RendererApp,
  shapes: ReadonlyArray<readonly [GeometryShape, ShapeGeometry]>,
): void {
  endModifiers(app);
  cleanModifiers(app);
  for (const [shape, geometry] of shapes) {
    pushShapeGeometry(app, shape, geometry);
  }
  requestRender(app, "set-wasm-attrs");
}
