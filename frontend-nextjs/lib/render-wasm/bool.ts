// The boolean-operation bridge (app.render-wasm.api/calculate-bool).
//
// The wasm computes the resulting path; the file only stores it. The
// protocol, ported from api.cljs:
// - _start_temp_objects swaps in a scratch pool (the scene keeps its own);
// - _init_shapes_pool reserves the pool for the descendants we upload;
// - set_object writes each child-with-self (the same record the workspace
//   uploads);
// - _alloc_bytes + one uuid quartet per operand id, written in reverse
//   order (calculate-bool* walks (rseq ids) and the wasm reads the buffer
//   back to front);
// - _calculate_bool(type) frees that buffer itself and answers a pointer
//   to [segment-count][segments], 28 bytes each;
// - _free_bytes releases the answer, _end_temp_objects restores the scene
//   pool (leaving it swapped makes the next call panic).
//
// The CLJS falls back to its pure implementation when the render context is
// unusable, because calculate-bool runs while loading a file too. This build
// computes booleans on demand only (create-bool and change-bool-type), so an
// unready renderer answers null and the caller keeps the file untouched
// instead of committing a guessed shape.

import { PathData } from "@/lib/transit";
import { KEY, call, uuidToU32, type RendererApp } from "@/lib/render-wasm/interop";
import { cljsShape } from "@/lib/render-wasm/shape-upload";
import { getChildrenIdsWithSelf } from "@/lib/workspace-component";
import type { WorkspaceObjects } from "@/lib/workspace";
import type { BoolType } from "@/lib/workspace-bool";

// RawBoolType (render-wasm/src/wasm/paths/bools.rs).
const RAW_BOOL_TYPE: Record<BoolType, number> = {
  union: 0,
  difference: 1,
  intersection: 2,
  exclude: 3,
};

// path.impl/SEGMENT-U8-SIZE (28) in u32 words.
const SEGMENT_U32_SIZE = 7;

// The internal module surface the boolean protocol uses. HEAPU32 is read
// after every allocation: a growing memory detaches the previous view.
interface BoolModule {
  _start_temp_objects(): void;
  _end_temp_objects(): void;
  _init_shapes_pool(count: number): void;
  _alloc_bytes(size: number): number;
  _free_bytes(): void;
  _calculate_bool(boolType: number): number;
  HEAPU32: Uint32Array;
}

function boolModule(app: RendererApp): BoolModule {
  const internal = app[KEY.internalModule];
  if (internal === undefined || internal === null) {
    throw new Error("render-wasm: the internal module is not loaded");
  }
  return internal as unknown as BoolModule;
}

// api.cljs initialized? (wasm/ready?): the temp-pool protocol is unsafe
// while the renderer is missing or reloading.
export function boolReady(app: RendererApp | null): boolean {
  if (app === null) return false;
  try {
    return call(app, KEY.wasmReady) === true;
  } catch {
    return false;
  }
}

// calculate-bool: the packed content of the boolean result, or null when the
// protocol is unavailable or the operands produce no geometry.
export function calculateBool(
  app: RendererApp,
  shape: Readonly<Record<string, unknown>>,
  objects: WorkspaceObjects,
): PathData | null {
  if (!boolReady(app)) return null;
  const boolType = shape["bool-type"];
  const rawType =
    typeof boolType === "string" ? RAW_BOOL_TYPE[boolType as BoolType] : undefined;
  if (rawType === undefined) return null;
  const operands = Array.isArray(shape.shapes)
    ? shape.shapes.filter((id): id is string => typeof id === "string")
    : [];
  if (operands.length === 0) return null;

  const tool = boolModule(app);
  tool._start_temp_objects();
  try {
    // cfh/get-children-with-self in the operand order: the wasm walks the
    // pool by uuid, so every operand needs its whole subtree present.
    const descendants: string[] = [];
    for (const id of operands) {
      if (objects[id] === undefined || objects[id] === null) continue;
      descendants.push(...getChildrenIdsWithSelf(objects, id));
    }
    if (descendants.length === 0) return null;
    tool._init_shapes_pool(descendants.length);
    for (const id of descendants) {
      const child = objects[id];
      if (child === undefined || child === null) continue;
      call(app, KEY.setObject, cljsShape(app, child));
    }

    const pointer = tool._alloc_bytes(16 * operands.length);
    const heap = tool.HEAPU32;
    let offset = pointer >>> 2;
    for (let index = operands.length - 1; index >= 0; index -= 1) {
      const [a, b, c, d] = uuidToU32(operands[index]);
      heap[offset] = a;
      heap[offset + 1] = b;
      heap[offset + 2] = c;
      heap[offset + 3] = d;
      offset += 4;
    }

    const resultPointer = tool._calculate_bool(rawType);
    const resultOffset = resultPointer >>> 2;
    // _calculate_bool may have grown the memory: re-read the view.
    const resultHeap = tool.HEAPU32;
    const length = resultHeap[resultOffset];
    if (!(length > 0)) {
      tool._free_bytes();
      return null;
    }
    const words = resultHeap.slice(
      resultOffset + 1,
      resultOffset + 1 + length * SEGMENT_U32_SIZE,
    );
    tool._free_bytes();
    return new PathData(new Uint8Array(words.buffer, words.byteOffset, words.byteLength));
  } finally {
    tool._end_temp_objects();
  }
}
