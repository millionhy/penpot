// set-object and set-objects: the cold-load shape upload.
//
// Shapes arrive as a page's object map (id -> plain shape with kebab-case
// keys). They must reach the renderer in tree order, parents before
// children, or the pool resolves a child before its parent exists.
//
// The upload itself is chunked: structural attrs (base props, children,
// blur, shadows, masked, bool/grow, flex, layout item, fills, strokes) go as
// one `_set_shapes_batch` per chunk, while the per-shape tail (svg attrs,
// path bytes) and the host-specific attrs run afterwards shape by shape. The
// tail lives here because it is host independent; text content, image bytes,
// grid tracks and the svg-raw markup arrive through `onShape`, the seam the
// later slices fill in.
//
// Two paths, as in the compiled original:
// - sync below ASYNC_THRESHOLD shapes (or with forceSync), no loading state;
// - async in chunks of BATCH_MAX_SHAPES with a yield between chunks, wrapped
//   in the shapes-loading protocol so the render loop defers frames.

import { call } from "./call";
import { ASYNC_THRESHOLD } from "./render-loop";
import { live, type RenderWasmModule } from "./module";
import { setShapePathContent, setShapeSvgAttrs, type PathContent } from "./props";
import { useShape } from "./select";
import { applySvgDerived } from "./svg-derived";
import {
  flushShapesBatch,
  setShapeUpload,
  type Shape,
  type UploadOptions,
} from "./upload";
import type { ShapeSvgAttrs } from "./props";
import { ZERO_UUID } from "./uuid";

export const BATCH_MAX_SHAPES = 512;

// Batch records always carry the layout and the fills/strokes sections in
// the workspace cold load; the incremental single-shape upload leaves both
// to the per-shape setters.
export const BATCH_UPLOAD_OPTIONS: UploadOptions = {
  includeLayout: true,
  includeFillsStrokes: true,
};

export type ShapeObjects =
  | Readonly<Record<string, unknown>>
  | ReadonlyMap<string, unknown>;

export type ShapeLookup = (id: string) => Shape | undefined;

function lookup(objects: ShapeObjects, id: string): Shape | undefined {
  const value =
    objects instanceof Map
      ? objects.get(id)
      : (objects as Readonly<Record<string, unknown>>)[id];
  return value === undefined ? undefined : (value as Shape);
}

function childIds(shape: Shape): string[] {
  const ids: string[] = [];
  for (const id of shape.shapes ?? []) {
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

// A shape plus its descendants, depth first in `shapes` order, parents
// before children. The visited set guards a malformed model (a cycle would
// otherwise recurse forever).
function collect(objects: ShapeObjects, id: string, out: Shape[], seen: Set<string>): void {
  if (seen.has(id)) return;
  seen.add(id);

  const shape = lookup(objects, id);
  if (shape === undefined) return;

  out.push(shape);
  for (const childId of childIds(shape)) collect(objects, childId, out, seen);
}

// shapes-in-tree-order: ids from the root when the map has one, otherwise
// from every shape whose parent is not in the map (filtered subsets, e.g.
// thumbnail data).
export function shapesInTreeOrder(objects: ShapeObjects): Shape[] {
  const out: Shape[] = [];
  const seen = new Set<string>();

  if (lookup(objects, ZERO_UUID) !== undefined) {
    collect(objects, ZERO_UUID, out, seen);
    return out;
  }

  const values = objects instanceof Map ? Array.from(objects.values()) : Object.values(objects);
  for (const value of values) {
    const shape = value as Shape;
    const parentId = shape["parent-id"];
    if (typeof parentId === "string" && lookup(objects, parentId) !== undefined) continue;
    collect(objects, shape.id, out, seen);
  }
  return out;
}

function pathBytes(content: unknown): Uint8Array | undefined {
  if (content instanceof Uint8Array) return content;
  if (content instanceof ArrayBuffer) return new Uint8Array(content);
  // A decoded `penpot/path-data` value (lib/transit PathData) carries the
  // packed segments in `bytes`; the bundle of the viewer decodes to that
  // shape, so the tail reads them without the engine importing the model.
  if (content !== null && typeof content === "object") {
    const bytes = (content as { bytes?: unknown }).bytes;
    if (bytes instanceof Uint8Array) return bytes;
  }
  return undefined;
}

// True when `shape` needs the per-shape svg-attrs/path tail after the
// structural upload.
export function needsShapeTail(shape: Shape): boolean {
  if (shape["svg-attrs"] !== null && shape["svg-attrs"] !== undefined) return true;
  if (shape.type !== "path" && shape.type !== "bool") return false;
  return pathBytes(shape.content) !== undefined;
}

export function writeShapeTail(module: RenderWasmModule, shape: Shape): void {
  const attrs = shape["svg-attrs"];
  if (attrs !== null && attrs !== undefined) {
    setShapeSvgAttrs(module, attrs as ShapeSvgAttrs);
  }

  if (shape.type === "path" || shape.type === "bool") {
    const bytes = pathBytes(shape.content);
    if (bytes !== undefined) setShapePathContent(module, bytes as PathContent);
  }
}

// serialize-shape!: the structural upload plus the tail, for one shape whose
// record is not part of a batch (the incremental edit path). The svg-derived
// attrs land first, so the record and the tail carry the fills, blur and
// shadow the source SVG implies.
export function serializeShape(module: RenderWasmModule, shape: Shape): Shape {
  const prepared = applySvgDerived(shape);
  setShapeUpload(module, prepared, { includeLayout: false });
  if (needsShapeTail(prepared)) writeShapeTail(module, prepared);
  return prepared;
}

// serialize-shapes-batch!: one `_set_shapes_batch`, then select and write the
// tail of every shape that needs it. Every shape passes through the svg
// derivation first, like the compiled serializer.
export function serializeShapesBatch(
  module: RenderWasmModule,
  shapes: readonly Shape[],
  options: UploadOptions = BATCH_UPLOAD_OPTIONS,
): readonly Shape[] {
  if (shapes.length === 0) return shapes;
  const prepared = shapes.map((shape) => applySvgDerived(shape));
  flushShapesBatch(module, prepared, options);
  for (const shape of prepared) {
    if (!needsShapeTail(shape)) continue;
    useShape(module, shape.id);
    writeShapeTail(module, shape);
  }
  return prepared;
}

// The shape-loading state the render loop owns (RenderLoop implements it).
export interface ShapesLoadingSink {
  beginShapesLoading(): void;
  endShapesLoading(): void;
  resetViewInteraction(): void;
  requestRender(reason: string): boolean;
}

export interface SetObjectsOptions {
  loop?: ShapesLoadingSink;
  // Force the synchronous path regardless of the shape count.
  forceSync?: boolean;
  // Fires right after the shapes reach wasm (and after the tiles are rebuilt
  // on the async path), before any image or font work starts.
  onShapesReady?: () => void;
  // Replaces the default `loop.requestRender("set-objects-complete")`.
  render?: () => void;
  // Host-specific attrs of one uploaded shape (text, images, grid, svg-raw).
  onShape?: (shape: Shape) => void;
  yieldToBrowser?: () => Promise<void>;
  asyncThreshold?: number;
  batchMaxShapes?: number;
}

function defaultYield(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function requestRender(options: SetObjectsOptions): void {
  if (options.render !== undefined) {
    options.render();
    return;
  }
  options.loop?.requestRender("set-objects-complete");
}

function uploadChunk(
  module: RenderWasmModule,
  shapes: readonly Shape[],
  options: SetObjectsOptions,
): void {
  const prepared = serializeShapesBatch(module, shapes, BATCH_UPLOAD_OPTIONS);
  if (options.onShape === undefined) return;
  for (const shape of prepared) options.onShape(shape);
}

function finishSync(module: RenderWasmModule, options: SetObjectsOptions): void {
  options.onShapesReady?.();
  if (!live()) return;

  // Rebuild the tile index so `_render` maps shapes to tiles after a page
  // switch, and drop whatever gesture was open.
  call(module, "_set_view_end");
  options.loop?.resetViewInteraction();
  requestRender(options);
}

function setObjectsSync(
  module: RenderWasmModule,
  shapes: readonly Shape[],
  options: SetObjectsOptions,
): void {
  uploadChunk(module, shapes, options);
  finishSync(module, options);
}

async function setObjectsAsync(
  module: RenderWasmModule,
  shapes: readonly Shape[],
  options: SetObjectsOptions,
): Promise<void> {
  const chunkSize = options.batchMaxShapes ?? BATCH_MAX_SHAPES;
  const yieldToBrowser = options.yieldToBrowser ?? defaultYield;

  options.loop?.beginShapesLoading();
  call(module, "_begin_loading");

  try {
    for (let index = 0; index < shapes.length; index += chunkSize) {
      uploadChunk(module, shapes.slice(index, index + chunkSize), options);
      await yieldToBrowser();
    }

    options.onShapesReady?.();
    if (!live()) {
      options.loop?.endShapesLoading();
      return;
    }

    // Show the shapes: end the loading overlay and unblock rendering, then
    // rebuild the tile index.
    call(module, "_end_loading");
    options.loop?.endShapesLoading();
    call(module, "_set_view_end");
    options.loop?.resetViewInteraction();
    requestRender(options);
  } catch (cause) {
    try {
      call(module, "_end_loading");
    } catch {
      // The context is gone; the loading flag still has to clear.
    }
    options.loop?.endShapesLoading();
    // The caller has already replaced the model; a failed upload must not
    // escape into a promise nobody observes.
    console.error("Async WASM shape loading failed", cause);
  }
}

// set-object: one shape through the incremental path.
export function setObject(
  module: RenderWasmModule,
  shape: Shape,
  options: Pick<SetObjectsOptions, "onShape"> = {},
): Shape | undefined {
  if (!live()) return undefined;
  const prepared = serializeShape(module, shape);
  options.onShape?.(prepared);
  return prepared;
}

// set-objects: the cold-load path. Returns the promise of the async path and
// undefined for the synchronous one, matching the compiled original.
export function setObjects(
  module: RenderWasmModule,
  objects: ShapeObjects,
  options: SetObjectsOptions = {},
): Promise<void> | undefined {
  if (!live()) return undefined;

  const shapes = shapesInTreeOrder(objects);
  const threshold = options.asyncThreshold ?? ASYNC_THRESHOLD;

  if (options.forceSync === true || shapes.length < threshold) {
    setObjectsSync(module, shapes, options);
    return undefined;
  }
  return setObjectsAsync(module, shapes, options);
}