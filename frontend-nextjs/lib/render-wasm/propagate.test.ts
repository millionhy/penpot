// Unit tests for the F9.11 render-wasm propagation layer
// (lib/render-wasm/propagate.ts): the 44-byte input layout, the identity
// reflow mark, the 40-byte output parse and the single-slot buffer
// discipline. The live pass runs in the browser; the Rust algorithm has its
// own tests in render-wasm/src/shapes/modifiers.rs.

import { describe, expect, it, vi } from "vitest";

import { KEY } from "@/lib/render-wasm/interop";
import {
  PROPAGATE_INTERNALS,
  propagateModifiers,
  u32ToUuid,
} from "@/lib/render-wasm/propagate";
import { missingInternals } from "@/lib/render-wasm/modifiers";

const SHAPE_ID = "d8cf69c1-e3c8-8159-8008-6f934d0e82aa";
const SHAPE_ID_U32 = [0xd8cf69c1, 0xe3c88159, 0x80086f93, 0x4d0e82aa];
const OTHER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const OTHER_ID_U32 = [0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff];

const HEAP_BYTES = 64 * 1024;
const INPUT_OFFSET = 64;
const RESULT_OFFSET = 4096;

const IDENTITY = [1, 0, 0, 1, 0, 0] as const;
const RESIZE = [2, 0, 0, 3, 5, 7] as const;

// --- fake $APP --------------------------------------------------------------

type RawEntry = readonly [number[], readonly number[]];

function makeFakeApp(result: readonly RawEntry[] = []) {
  const calls: string[] = [];
  const allocSizes: number[] = [];
  const precisions: number[] = [];
  const inputSnapshots: Uint32Array[] = [];

  function newHeap() {
    const buffer = new ArrayBuffer(HEAP_BYTES);
    return { u32: new Uint32Array(buffer), f32: new Float32Array(buffer) };
  }
  let heap = newHeap();

  const internal: Record<string, unknown> = {
    // Getters: every read answers the current views, simulating the
    // growth-driven view swap the real module performs.
    get HEAPU32() {
      return heap.u32;
    },
    get HEAPF32() {
      return heap.f32;
    },
    _alloc_bytes: vi.fn((size: number) => {
      calls.push(`_alloc_bytes:${size}`);
      allocSizes.push(size);
      heap = newHeap();
      return INPUT_OFFSET;
    }),
    _propagate_modifiers: vi.fn((precision: number) => {
      calls.push("_propagate_modifiers");
      precisions.push(precision);
      inputSnapshots.push(new Uint32Array(heap.u32));
      const base = RESULT_OFFSET >> 2;
      heap.u32[base] = result.length;
      let cursor = base + 1;
      for (const [id, matrix] of result) {
        heap.u32.set(id, cursor);
        cursor += 4;
        heap.f32.set(matrix, cursor);
        cursor += 6;
      }
      return RESULT_OFFSET;
    }),
    _free_bytes: vi.fn(() => calls.push("_free_bytes")),
  };

  const app = { [KEY.internalModule]: internal };
  return { app, calls, allocSizes, precisions, inputSnapshots };
}

// --- guards -----------------------------------------------------------------

describe("PROPAGATE_INTERNALS", () => {
  it("names the two entry points a reflow needs", () => {
    expect(PROPAGATE_INTERNALS).toEqual(["_propagate_modifiers", "_alloc_bytes"]);
  });

  it("reports a module missing the propagation entry point", () => {
    const app = { [KEY.internalModule]: { _alloc_bytes: () => 0 } };
    expect(missingInternals(app, PROPAGATE_INTERNALS)).toEqual(["_propagate_modifiers"]);
  });
});

describe("u32ToUuid", () => {
  it("rebuilds the dashed uuid from its four words", () => {
    expect(u32ToUuid(...(SHAPE_ID_U32 as [number, number, number, number]))).toBe(SHAPE_ID);
  });

  it("keeps leading zeros of each word", () => {
    expect(u32ToUuid(0x00000001, 0x00000000, 0x0000000f, 0x00000010)).toBe(
      "00000001-0000-0000-0000-000f00000010",
    );
  });
});

// --- the input layout -------------------------------------------------------

describe("propagateModifiers input", () => {
  it("writes one 44-byte entry per shape: uuid, matrix, kind", () => {
    const { app, allocSizes, inputSnapshots } = makeFakeApp();
    propagateModifiers(app, [{ id: SHAPE_ID, matrix: RESIZE }]);

    expect(allocSizes).toEqual([44]);
    const words = inputSnapshots[0];
    const base = INPUT_OFFSET >> 2;
    expect([words[base], words[base + 1], words[base + 2], words[base + 3]]).toEqual(SHAPE_ID_U32);
    // The float view shares the buffer: the matrix starts after the uuid.
    expect(Array.from(new Float32Array(words.buffer, INPUT_OFFSET + 16, 6))).toEqual([...RESIZE]);
    // kind 1 = child: the renderer spreads this matrix to the children.
    expect(words[base + 10]).toBe(1);
  });

  it("marks propagate:false as kind 0", () => {
    const { app, inputSnapshots } = makeFakeApp();
    propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY, propagate: false }]);
    expect(inputSnapshots[0][(INPUT_OFFSET >> 2) + 10]).toBe(0);
  });

  it("packs several entries back to back", () => {
    const { app, allocSizes, inputSnapshots } = makeFakeApp();
    propagateModifiers(app, [
      { id: SHAPE_ID, matrix: IDENTITY },
      { id: OTHER_ID, matrix: RESIZE },
    ]);

    expect(allocSizes).toEqual([88]);
    const base = INPUT_OFFSET >> 2;
    const words = inputSnapshots[0];
    expect(words[base + 10]).toBe(1);
    expect([words[base + 11], words[base + 12], words[base + 13], words[base + 14]]).toEqual(
      OTHER_ID_U32,
    );
    // Second entry: uuid at 11..14, matrix at 15..20, kind at 21.
    expect(Array.from(new Float32Array(words.buffer, (base + 15) * 4, 6))).toEqual([...RESIZE]);
    expect(words[base + 21]).toBe(1);
  });

  it("does not touch the heap for an empty list", () => {
    const { app, calls } = makeFakeApp();
    expect(propagateModifiers(app, [])).toEqual([]);
    expect(calls).toEqual([]);
  });
});

// --- the output parse -------------------------------------------------------

describe("propagateModifiers output", () => {
  it("reads the count and every 40-byte result entry", () => {
    const { app, calls } = makeFakeApp([
      [SHAPE_ID_U32, RESIZE],
      [OTHER_ID_U32, IDENTITY],
    ]);
    expect(propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY }])).toEqual([
      [SHAPE_ID, [2, 0, 0, 3, 5, 7]],
      [OTHER_ID, [1, 0, 0, 1, 0, 0]],
    ]);
    expect(calls).toEqual(["_alloc_bytes:44", "_propagate_modifiers", "_free_bytes"]);
  });

  it("answers an empty list when the renderer reports no shapes", () => {
    const { app } = makeFakeApp([]);
    expect(propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY }])).toEqual([]);
  });

  it("passes the pixel precision through and defaults to disabled", () => {
    const first = makeFakeApp();
    propagateModifiers(first.app, [{ id: SHAPE_ID, matrix: IDENTITY }]);
    expect(first.precisions).toEqual([0]);

    const second = makeFakeApp();
    propagateModifiers(second.app, [{ id: SHAPE_ID, matrix: IDENTITY }], 1);
    expect(second.precisions).toEqual([1]);
  });

  it("frees the result even when the renderer answers nothing", () => {
    const { app, calls } = makeFakeApp([]);
    propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY }]);
    expect(calls.at(-1)).toBe("_free_bytes");
  });

  it("survives a module without _free_bytes", () => {
    const { app } = makeFakeApp([[SHAPE_ID_U32, RESIZE]]);
    const internal = app[KEY.internalModule] as Record<string, unknown>;
    delete internal._free_bytes;
    expect(propagateModifiers(app, [{ id: SHAPE_ID, matrix: IDENTITY }])).toEqual([
      [SHAPE_ID, [2, 0, 0, 3, 5, 7]],
    ]);
  });
});
