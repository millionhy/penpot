// F9.11: the wasm-side geometry propagation (app.render-wasm.api/
// propagate-modifiers). The layout reflow and the constraint spread live in
// the Rust renderer (shapes/modifiers.rs plus reflow_flex_layout /
// reflow_grid_layout); the shell only sends the transforms of the roots and
// applies the matrices the renderer returns.
//
// An IDENTITY matrix is not a no-op: the renderer turns it into a reflow
// mark (shapes/modifiers.rs, "We use the identity transform as a mark that a
// reflow is needed"). Sending identity for a layout frame therefore asks for
// a full reflow of its children, and sending identity for one of its children
// asks the same of the nearest layout ancestor.
//
// The entry layout mirrors app.render-wasm.api/propagate-modifiers:
// - input, 44 bytes per entry: uuid as 4 x u32 (16) + matrix as 6 x f32 (24)
//   + kind as u32 (4). kind 1 = child (spread to the children), 0 = parent
//   (already a child result, do not spread again);
// - output: one u32 count followed by 10 u32 per entry (uuid 4 + matrix 6).
//
// Buffer discipline (render-wasm/src/mem.rs): BUFFERU8 is a single slot. The
// input is consumed by _propagate_modifiers, which writes the result into the
// same slot; the caller frees it with _free_bytes (no arguments) after
// reading. The heap views are re-read after every allocation.

import { KEY, uuidToU32, type RendererApp } from "./interop";
import type { Matrix6 } from "./modifiers";

const INPUT_ENTRY_U8_SIZE = 44;
const OUTPUT_ENTRY_U32_SIZE = 10;

// RawTransformEntryKind (render-wasm/src/wasm/transforms.rs).
const KIND_PARENT = 0;
const KIND_CHILD = 1;

// The internal entry points a reflow needs. _free_bytes is not gated: a
// missing one leaks one buffer, it does not break the propagation.
export const PROPAGATE_INTERNALS = ["_propagate_modifiers", "_alloc_bytes"] as const;

type InternalModule = Record<string, (...args: number[]) => unknown> & {
  HEAPU32?: Uint32Array;
  HEAPF32?: Float32Array;
  _free_bytes?: () => void;
};

function internalModule(app: RendererApp): InternalModule {
  const internal = app[KEY.internalModule] as InternalModule | undefined;
  if (internal === undefined) {
    throw new Error("render-wasm: internal module is not available");
  }
  return internal;
}

// One transform to propagate. `propagate` defaults to true, the "geometry
// root" case (kind :child in the CLJS caller); false marks a result the
// renderer already spread (kind :parent).
export interface PropagateEntry {
  readonly id: string;
  readonly matrix: Matrix6;
  readonly propagate?: boolean;
}

// The uuid of an output entry, rebuilt from its four big-endian words
// (uuidToU32 in interop.ts reads the dashless hex the same way).
export function u32ToUuid(a: number, b: number, c: number, d: number): string {
  const hex = [a, b, c, d]
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// Propagate the transforms of `entries` through the renderer tree and answer
// the matrix of every affected shape, keyed by id in the order the renderer
// reports (one entry per shape; the caller dedupes by id if needed). An empty
// entry list asks nothing of the renderer and returns an empty list without
// touching the wasm heap.
export function propagateModifiers(
  app: RendererApp,
  entries: readonly PropagateEntry[],
  pixelPrecision = 0,
): Array<[string, Matrix6]> {
  if (entries.length === 0) return [];

  const internal = internalModule(app);
  const size = INPUT_ENTRY_U8_SIZE * entries.length;
  const offset = internal._alloc_bytes(size) as number;

  // Re-read after the allocation: growth detaches the previous views.
  const heapU32 = internal.HEAPU32 as Uint32Array;
  const heapF32 = internal.HEAPF32 as Float32Array;
  let off32 = offset >> 2;

  for (const entry of entries) {
    heapU32.set(uuidToU32(entry.id), off32);
    off32 += 4;
    heapF32[off32 + 0] = entry.matrix[0];
    heapF32[off32 + 1] = entry.matrix[1];
    heapF32[off32 + 2] = entry.matrix[2];
    heapF32[off32 + 3] = entry.matrix[3];
    heapF32[off32 + 4] = entry.matrix[4];
    heapF32[off32 + 5] = entry.matrix[5];
    off32 += 6;
    heapU32[off32] = entry.propagate === false ? KIND_PARENT : KIND_CHILD;
    off32 += 1;
  }

  const resultOffset = internal._propagate_modifiers(pixelPrecision) as number;
  const result = resultOffset >> 2;
  const count = heapU32[result];

  const out: Array<[string, Matrix6]> = [];
  let cursor = result + 1;
  for (let index = 0; index < count; index += 1) {
    const id = u32ToUuid(
      heapU32[cursor + 0],
      heapU32[cursor + 1],
      heapU32[cursor + 2],
      heapU32[cursor + 3],
    );
    const matrix: Matrix6 = [
      heapF32[cursor + 4],
      heapF32[cursor + 5],
      heapF32[cursor + 6],
      heapF32[cursor + 7],
      heapF32[cursor + 8],
      heapF32[cursor + 9],
    ];
    out.push([id, matrix]);
    cursor += OUTPUT_ENTRY_U32_SIZE;
  }

  if (typeof internal._free_bytes === "function") internal._free_bytes();
  return out;
}
