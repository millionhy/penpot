import { describe, expect, it, vi } from "vitest";
import type { RenderWasmModule } from "./module";
import {
  alloc,
  dataView,
  free,
  heapF32,
  heapI32,
  heapU8,
  heapU32,
  offset32,
  readString,
  sizeOf,
  slice,
  writeBuffer,
} from "./memory";

function makeModule(overrides: Record<string, unknown> = {}): RenderWasmModule {
  // One buffer behind every view, like the emscripten module: the serializers
  // write bytes and read the same memory back as u32/f32.
  const memory = new ArrayBuffer(64);
  return {
    HEAPU8: new Uint8Array(memory),
    HEAPU32: new Uint32Array(memory),
    HEAP32: new Int32Array(memory),
    HEAPF32: new Float32Array(memory),
    UTF8ToString: (ptr: number, maxBytes?: number) => `#${ptr}/${maxBytes ?? "-"}`,
    ...overrides,
  };
}

describe("memory", () => {
  it("converts byte offsets to 32-bit indexes with an unsigned shift", () => {
    expect(offset32(8)).toBe(2);
    // A misaligned pointer must floor, not round.
    expect(offset32(6)).toBe(1);
  });

  it("returns the heap views the module currently exposes", () => {
    const target = makeModule();

    expect(heapU8(target)).toBe(target.HEAPU8);
    expect(heapU32(target)).toBe(target.HEAPU32);
    expect(heapI32(target)).toBe(target.HEAP32);
    expect(heapF32(target)).toBe(target.HEAPF32);
  });

  it("wraps the heap in a little-endian readable DataView", () => {
    const target = makeModule();
    const view = dataView(target.HEAPU8);

    view.setUint32(4, 0x01020304, true);

    expect(target.HEAPU8[4]).toBe(0x04);
    expect(target.HEAPU32[1]).toBe(0x01020304);
  });

  it("allocates and frees through the artifact exports", () => {
    const calls: Array<[string, unknown[]]> = [];
    const target = makeModule({
      _alloc_bytes: (size: number) => {
        calls.push(["_alloc_bytes", [size]]);
        return 1024;
      },
      _free_bytes: () => {
        calls.push(["_free_bytes", []]);
      },
    });

    expect(alloc(target, 48)).toBe(1024);
    free(target);

    expect(calls).toEqual([
      ["_alloc_bytes", [48]],
      ["_free_bytes", []],
    ]);
  });

  it("warns but still allocates zero bytes", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const target = makeModule({ _alloc_bytes: () => 8 });

    try {
      expect(alloc(target, 0)).toBe(8);
      expect(warn).toHaveBeenCalledWith("render-wasm: tried to allocate 0 bytes");
    } finally {
      warn.mockRestore();
    }
  });

  it("copies a payload into the heap and returns the cursor", () => {
    const target = makeModule();
    const heap = target.HEAPU8;

    expect(writeBuffer(heap, new Uint8Array([1, 2, 3]), 8)).toBe(11);
    expect(Array.from(heap.slice(8, 11))).toEqual([1, 2, 3]);

    const buffer = new Uint8Array([9, 8]).buffer;
    expect(writeBuffer(heap, buffer, 16)).toBe(18);
    expect(Array.from(heap.slice(16, 18))).toEqual([9, 8]);
  });

  it("slices out a copy, not a view over the live heap", () => {
    const target = makeModule();
    target.HEAPU8.set([7, 7, 7], 4);

    const copy = slice(target.HEAPU8, 4, 3);
    target.HEAPU8.fill(0, 4, 7);

    expect(Array.from(copy)).toEqual([7, 7, 7]);
  });

  it("reads strings with the arity the caller asks for", () => {
    const target = makeModule();

    expect(readString(target, 32)).toBe("#32/-");
    expect(readString(target, 32, 10)).toBe("#32/10");
    expect(readString(target, 32, 10, true)).toBe("#32/10");
  });

  it("measures both binary payload shapes", () => {
    expect(sizeOf(new Uint8Array(5))).toBe(5);
    expect(sizeOf(new ArrayBuffer(7))).toBe(7);
  });
});
