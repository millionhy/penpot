// Unit tests for the F9.3 render-wasm bottom layer (lib/render-wasm/
// modifiers.ts): the set-modifiers preview protocol and the post-commit
// geometry push, both replicated over the internal module. The fake module
// records every call and swaps in FRESH typed-array heap views on every
// _alloc_bytes, so the tests enforce the "re-read the heap views after each
// allocation" discipline, and the byte layouts (40-byte modifier entries,
// chunked path content) are asserted for real. The live wasm pass runs in
// the browser (F9.3 checkpoint), not here.

import { describe, expect, it, vi } from "vitest";

import { KEY } from "@/lib/render-wasm/interop";
import {
  cleanModifiers,
  commitShapeGeometry,
  configureModifiers,
  DRAG_PREVIEW_INTERNALS,
  endModifiers,
  hasInternal,
  missingInternals,
  pushPathContent,
  pushShapeGeometry,
  resetModifierPreview,
  startModifiers,
} from "@/lib/render-wasm/modifiers";

const SHAPE_ID = "d8cf69c1-e3c8-8159-8008-6f934d0e82aa";
const SHAPE_ID_U32 = [0xd8cf69c1, 0xe3c88159, 0x80086f93, 0x4d0e82aa];
const OTHER_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";

// The heap every allocation swaps in; large enough for one 256 KiB path
// chunk plus slack.
const HEAP_BYTES = 512 * 1024;

function leWord(bytes: Uint8Array, index: number): number {
  return (
    bytes[index] |
    (bytes[index + 1] << 8) |
    (bytes[index + 2] << 16) |
    (bytes[index + 3] << 24)
  ) >>> 0;
}

function patternedBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) out[i] = (i * 7 + 3) % 251;
  return out;
}

// --- fake $APP --------------------------------------------------------------

function makeFakeApp() {
  const calls: string[] = [];
  const allocSizes: number[] = [];
  const allocOffsets: number[] = [];
  const useShapeArgs: number[][] = [];
  const selrectArgs: number[][] = [];
  const chunkSnapshots: Uint32Array[] = [];

  function newHeap() {
    const buffer = new ArrayBuffer(HEAP_BYTES);
    return { u32: new Uint32Array(buffer), f32: new Float32Array(buffer) };
  }
  let heap = newHeap();
  let nextByteOffset = 64;

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
      const offset = nextByteOffset;
      nextByteOffset += 64;
      allocOffsets.push(offset);
      return offset;
    }),
    _set_modifiers_start: vi.fn(() => calls.push("_set_modifiers_start")),
    _set_modifiers_end: vi.fn(() => calls.push("_set_modifiers_end")),
    _set_modifiers: vi.fn(() => calls.push("_set_modifiers")),
    _clean_modifiers: vi.fn(() => calls.push("_clean_modifiers")),
    _use_shape: vi.fn((...args: number[]) => {
      calls.push("_use_shape");
      useShapeArgs.push(args);
    }),
    _set_shape_selrect: vi.fn((...args: number[]) => {
      calls.push("_set_shape_selrect");
      selrectArgs.push(args);
    }),
    _start_shape_path_buffer: vi.fn(() => calls.push("_start_shape_path_buffer")),
    _set_shape_path_chunk_buffer: vi.fn(() => {
      calls.push("_set_shape_path_chunk_buffer");
      chunkSnapshots.push(new Uint32Array(heap.u32));
    }),
    _set_shape_path_buffer: vi.fn(() => calls.push("_set_shape_path_buffer")),
  };

  const app = {
    [KEY.internalModule]: internal,
    [KEY.requestRender]: vi.fn((cause: string) => {
      calls.push(`request_render:${cause}`);
    }),
  };

  return { app, calls, allocSizes, allocOffsets, useShapeArgs, selrectArgs, chunkSnapshots };
}

// --- guards -----------------------------------------------------------------

describe("hasInternal / missingInternals", () => {
  it("reports a present internal function", () => {
    const { app } = makeFakeApp();
    expect(hasInternal(app, "_alloc_bytes")).toBe(true);
  });

  it("reports a missing name", () => {
    const { app } = makeFakeApp();
    expect(hasInternal(app, "_nonexistent")).toBe(false);
  });

  it("lists the missing subset", () => {
    const { app } = makeFakeApp();
    expect(missingInternals(app, ["_alloc_bytes", "_nonexistent"])).toEqual(["_nonexistent"]);
    expect(missingInternals(app, DRAG_PREVIEW_INTERNALS)).toEqual([]);
  });
});

// --- lifecycle --------------------------------------------------------------

describe("modifier lifecycle", () => {
  it("startModifiers calls _set_modifiers_start alone", () => {
    const { app, calls } = makeFakeApp();
    startModifiers(app);
    expect(calls).toEqual(["_set_modifiers_start"]);
  });

  it("endModifiers calls _set_modifiers_end alone", () => {
    const { app, calls } = makeFakeApp();
    endModifiers(app);
    expect(calls).toEqual(["_set_modifiers_end"]);
  });

  it("cleanModifiers calls _clean_modifiers and requests no render", () => {
    const { app, calls } = makeFakeApp();
    cleanModifiers(app);
    expect(calls).toEqual(["_clean_modifiers"]);
  });

  it("resetModifierPreview runs end, clean and the restore render", () => {
    const { app, calls } = makeFakeApp();
    resetModifierPreview(app);
    expect(calls).toEqual([
      "_set_modifiers_end",
      "_clean_modifiers",
      "request_render:clean-modifiers",
    ]);
  });
});

// --- configureModifiers -----------------------------------------------------

describe("configureModifiers", () => {
  it("does nothing for an empty set", () => {
    const { app, calls } = makeFakeApp();
    configureModifiers(app, []);
    expect(calls).toEqual([]);
  });

  it("packs one uuid + matrix entry in 40 bytes and requests a render", () => {
    const { app, calls, allocSizes } = makeFakeApp();
    configureModifiers(app, [[SHAPE_ID, [1, 0, 0, 1, 5, 7]]]);

    expect(allocSizes).toEqual([40]);
    expect(calls).toEqual([
      "_alloc_bytes:40",
      "_set_modifiers",
      "request_render:set-modifiers",
    ]);

    // offset 64 -> off32 = 16: uuid in words 16..19, matrix in floats 20..25.
    const internal = app[KEY.internalModule] as {
      HEAPU32: Uint32Array;
      HEAPF32: Float32Array;
    };
    expect(Array.from(internal.HEAPU32.slice(16, 20))).toEqual(SHAPE_ID_U32);
    expect(Array.from(internal.HEAPF32.slice(20, 26))).toEqual([1, 0, 0, 1, 5, 7]);
  });

  it("steps 40 bytes per entry", () => {
    const { app, allocSizes } = makeFakeApp();
    configureModifiers(app, [
      [SHAPE_ID, [1, 0, 0, 1, 5, 7]],
      [OTHER_ID, [2, 0, 0, 2, -3, 4]],
    ]);
    expect(allocSizes).toEqual([80]);

    const internal = app[KEY.internalModule] as {
      HEAPU32: Uint32Array;
      HEAPF32: Float32Array;
    };
    // Second entry at off32 = 16 + 10 = 26.
    expect(Array.from(internal.HEAPU32.slice(26, 30))).toEqual([0xffffffff, 0xffffffff, 0xffffffff, 0xffffffff]);
    expect(Array.from(internal.HEAPF32.slice(30, 36))).toEqual([2, 0, 0, 2, -3, 4]);
  });

  it("writes into the heap view read after the allocation", () => {
    // The fake swaps the views on every _alloc_bytes; had the module kept a
    // view captured before the allocation, the write would land on a
    // detached array and the current-view assertions above would fail.
    const { app } = makeFakeApp();
    const internal = app[KEY.internalModule] as { HEAPU32: Uint32Array };
    const before = internal.HEAPU32;
    configureModifiers(app, [[SHAPE_ID, [1, 0, 0, 1, 5, 7]]]);
    const after = internal.HEAPU32;
    expect(after).not.toBe(before);
    expect(Array.from(after.slice(16, 20))).toEqual(SHAPE_ID_U32);
  });
});

// --- pushShapeGeometry ------------------------------------------------------

describe("pushShapeGeometry", () => {
  it("pushes use-shape + selrect for a plain shape", () => {
    const { app, calls, useShapeArgs, selrectArgs, allocSizes } = makeFakeApp();
    pushShapeGeometry(
      app,
      { id: SHAPE_ID, type: "rect" },
      { selrect: { x1: 1, y1: 2, x2: 31, y2: 22 } },
    );
    expect(calls).toEqual(["_use_shape", "_set_shape_selrect"]);
    expect(useShapeArgs).toEqual([SHAPE_ID_U32]);
    expect(selrectArgs).toEqual([[1, 2, 31, 22]]);
    expect(allocSizes).toEqual([]);
  });

  it("skips the path protocol for path shapes without new content", () => {
    const { app, calls } = makeFakeApp();
    pushShapeGeometry(
      app,
      { id: SHAPE_ID, type: "path" },
      { selrect: { x1: 0, y1: 0, x2: 10, y2: 10 } },
    );
    expect(calls).toEqual(["_use_shape", "_set_shape_selrect"]);
  });

  it("ignores provided path content on non-path shapes", () => {
    const { app, calls } = makeFakeApp();
    pushShapeGeometry(
      app,
      { id: SHAPE_ID, type: "rect" },
      { selrect: { x1: 0, y1: 0, x2: 10, y2: 10 }, pathContent: new Uint8Array(28) },
    );
    expect(calls).toEqual(["_use_shape", "_set_shape_selrect"]);
  });

  it("pushes the chunked path content for path/bool shapes", () => {
    const { app, calls, allocSizes, allocOffsets, chunkSnapshots } = makeFakeApp();
    const content = patternedBytes(28);
    pushShapeGeometry(
      app,
      { id: SHAPE_ID, type: "path" },
      { selrect: { x1: 0, y1: 0, x2: 10, y2: 10 }, pathContent: content },
    );
    expect(calls).toEqual([
      "_use_shape",
      "_set_shape_selrect",
      "_start_shape_path_buffer",
      "_alloc_bytes:28",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
    expect(allocSizes).toEqual([28]);
    const base = allocOffsets[0] >> 2;
    expect(chunkSnapshots[0][base]).toBe(leWord(content, 0));
    expect(chunkSnapshots[0][base + 6]).toBe(leWord(content, 24));
  });

  it("treats bool shapes like paths", () => {
    const { app, calls } = makeFakeApp();
    pushShapeGeometry(
      app,
      { id: SHAPE_ID, type: "bool" },
      { selrect: { x1: 0, y1: 0, x2: 10, y2: 10 }, pathContent: new Uint8Array(28) },
    );
    expect(calls).toContain("_start_shape_path_buffer");
  });
});

// --- pushPathContent --------------------------------------------------------

describe("pushPathContent", () => {
  it("uploads a 28-byte segment with one allocation", () => {
    const { app, calls, allocSizes, allocOffsets, chunkSnapshots } = makeFakeApp();
    const content = patternedBytes(28);
    pushPathContent(app, content);
    expect(calls).toEqual([
      "_start_shape_path_buffer",
      "_alloc_bytes:28",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
    expect(allocSizes).toEqual([28]);
    expect(chunkSnapshots[0][allocOffsets[0] >> 2]).toBe(leWord(content, 0));
  });

  it("zero-pads content to the u32 alignment", () => {
    const { app, allocSizes, allocOffsets, chunkSnapshots } = makeFakeApp();
    pushPathContent(app, patternedBytes(30));
    expect(allocSizes).toEqual([32]);
    // The last word holds the final two bytes plus the two padding zeros.
    const padded = new Uint8Array(32);
    padded.set(patternedBytes(30));
    expect(chunkSnapshots[0][(allocOffsets[0] >> 2) + 7]).toBe(leWord(padded, 28));
  });

  it("splits content over 256 KiB and uploads one chunk per allocation", () => {
    const { app, calls, allocSizes, allocOffsets, chunkSnapshots } = makeFakeApp();
    const length = 256 * 1024 + 28;
    const content = patternedBytes(length);
    pushPathContent(app, content);

    expect(allocSizes).toEqual([256 * 1024, 28]);
    expect(calls).toEqual([
      "_start_shape_path_buffer",
      `_alloc_bytes:${256 * 1024}`,
      "_set_shape_path_chunk_buffer",
      "_alloc_bytes:28",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
    expect(chunkSnapshots).toHaveLength(2);
    const base0 = allocOffsets[0] >> 2;
    const base1 = allocOffsets[1] >> 2;
    expect(chunkSnapshots[0][base0]).toBe(leWord(content, 0));
    expect(chunkSnapshots[0][base0 + 65535]).toBe(leWord(content, 256 * 1024 - 4));
    expect(chunkSnapshots[1][base1]).toBe(leWord(content, 256 * 1024));
    expect(chunkSnapshots[1][base1 + 6]).toBe(leWord(content, length - 4));
  });

  it("uploads an empty path without allocating", () => {
    const { app, calls, allocSizes } = makeFakeApp();
    pushPathContent(app, new Uint8Array(0));
    expect(calls).toEqual(["_start_shape_path_buffer", "_set_shape_path_buffer"]);
    expect(allocSizes).toEqual([]);
  });
});

// --- commitShapeGeometry ----------------------------------------------------

describe("commitShapeGeometry", () => {
  it("runs the committed sequence in one task", () => {
    const { app, calls } = makeFakeApp();
    commitShapeGeometry(app, [
      [{ id: SHAPE_ID, type: "rect" }, { selrect: { x1: 1, y1: 1, x2: 11, y2: 11 } }],
      [
        { id: OTHER_ID, type: "path" },
        { selrect: { x1: 2, y1: 2, x2: 12, y2: 12 }, pathContent: patternedBytes(28) },
      ],
    ]);
    expect(calls).toEqual([
      "_set_modifiers_end",
      "_clean_modifiers",
      "_use_shape",
      "_set_shape_selrect",
      "_use_shape",
      "_set_shape_selrect",
      "_start_shape_path_buffer",
      "_alloc_bytes:28",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
      "request_render:set-wasm-attrs",
    ]);
  });
});
