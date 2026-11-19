// app.wasm.memory: the heap helpers the driver and the serializers share.

import { describe, expect, it, vi } from "vitest";
import { AppError } from "../errors.js";
import { alloc, dataView, free, offset32, size, writeBuffer } from "./memory.js";

function heap(sizeBytes = 64): Uint8Array {
  return new Uint8Array(sizeBytes);
}

describe("offset32", () => {
  it("converts a byte offset to a u32 index", () => {
    expect([0, 4, 16, 1024].map(offset32)).toEqual([0, 1, 4, 256]);
  });
});

describe("dataView", () => {
  it("wraps the heap and reads little-endian words", () => {
    const bytes = heap();
    const view = dataView(bytes);
    view.setUint32(4, 0x11223344, true);

    expect(Array.from(bytes.slice(4, 8))).toEqual([0x44, 0x33, 0x22, 0x11]);
    expect(view.getUint32(4, true)).toBe(0x11223344);
  });
});

describe("writeBuffer", () => {
  it("copies a Uint8Array and returns the next offset", () => {
    const bytes = heap();
    const end = writeBuffer(bytes, Uint8Array.from([1, 2, 3]), 8);

    expect(end).toBe(11);
    expect(Array.from(bytes.slice(8, 11))).toEqual([1, 2, 3]);
  });

  it("accepts an ArrayBuffer", () => {
    const bytes = heap();
    const buffer = Uint8Array.from([9, 8]).buffer;
    const end = writeBuffer(bytes, buffer, 2);

    expect(end).toBe(4);
    expect(Array.from(bytes.slice(2, 4))).toEqual([9, 8]);
  });
});

describe("size", () => {
  it("reads byteLength from either source", () => {
    expect(size(Uint8Array.from([1, 2, 3]))).toBe(3);
    expect(size(new ArrayBuffer(5))).toBe(5);
  });
});

describe("alloc/free", () => {
  it("delegates to the module allocator and free", () => {
    const module = {
      HEAPU8: heap(),
      HEAPU32: new Uint32Array(16),
      _alloc_bytes: vi.fn((count: number) => count + 32),
      _free_bytes: vi.fn(),
    };

    expect(alloc(module, 8)).toBe(40);
    expect(module._alloc_bytes).toHaveBeenCalledWith(8);

    free(module);
    expect(module._free_bytes).toHaveBeenCalledTimes(1);
  });

  it("wraps a failing allocator as a wasm-error", () => {
    const module = {
      HEAPU8: heap(),
      HEAPU32: new Uint32Array(16),
      _alloc_bytes: () => {
        throw new Error("Bytes already allocated");
      },
      _read_error_code: () => 0x02,
    };

    try {
      alloc(module, 8);
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppError);
      expect((cause as AppError).data).toMatchObject({
        type: "wasm-error",
        code: "wasm-panic",
        fn: "_alloc_bytes",
      });
    }
  });
});
