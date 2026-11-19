// app.wasm.memory: the heap helpers shared by the driver and the serializers.
//
// Mirrors app.common.render-wasm.mem without the CLJS buffer namespace. The
// module exposes its heap views as HEAPU8/HEAPU32 and a single allocator, and
// the typed arrays bounds check every access.

import { call } from "./call.js";

export interface WasmHeap {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
}

type HeapModule = WasmHeap & Record<string, unknown>;

// Converts an 8-bit (1 byte) offset to a 32-bit (4 bytes) index.
export function offset32(value: number): number {
  return value >>> 2;
}

export function heapU8(module: WasmHeap): Uint8Array {
  return module.HEAPU8;
}

export function heapU32(module: WasmHeap): Uint32Array {
  return module.HEAPU32;
}

// The heap can move when the allocator grows the memory, so the view must be
// read after the allocation, never kept across calls.
export function dataView(heap: Uint8Array): DataView {
  return new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
}

export function alloc(module: HeapModule, size: number): number {
  return call<number>(module, "_alloc_bytes", size);
}

export function free(module: HeapModule): void {
  call(module, "_free_bytes");
}

export function size(value: Uint8Array | ArrayBuffer): number {
  return value instanceof Uint8Array ? value.byteLength : value.byteLength;
}

export function writeBuffer(
  target: Uint8Array,
  value: Uint8Array | ArrayBuffer,
  offset: number,
): number {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  target.set(bytes, offset);
  return offset + bytes.byteLength;
}
