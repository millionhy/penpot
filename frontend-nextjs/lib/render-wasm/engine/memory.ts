// Heap helpers shared by every serializer and render call.
//
// Ported from app.common.render-wasm.mem (and mem/heap32), minus the CLJS
// buffer namespace: the artifact exposes HEAPU8/HEAPU32/HEAP32/HEAPF32 and
// a single allocator pair (`_alloc_bytes` / `_free_bytes`).
//
// The heap can move when the allocator grows the memory, so a view must be
// read after the allocation, never kept across calls. That is why every
// helper takes the module (or the heap it currently exposes) instead of
// caching the typed array.

import { call } from "./call";
import type { RenderWasmModule } from "./module";

// An 8-bit offset to a 32-bit (4 byte) index.
export function offset32(value: number): number {
  return value >>> 2;
}

export function heapU8(target: RenderWasmModule): Uint8Array {
  return target.HEAPU8;
}

export function heapU32(target: RenderWasmModule): Uint32Array {
  return target.HEAPU32;
}

export function heapI32(target: RenderWasmModule): Int32Array {
  return target.HEAP32;
}

export function heapF32(target: RenderWasmModule): Float32Array {
  return target.HEAPF32;
}

// A DataView over the current heap, for surgical multi-width writes.
export function dataView(heap: Uint8Array): DataView {
  return new DataView(heap.buffer, heap.byteOffset, heap.byteLength);
}

// Allocates bytes (aligned to 4) and returns the byte offset. A zero-size
// allocation is a caller bug upstream; the CLJS version traced it and
// allocated anyway, which is what keeps the failure visible without
// changing the ABI.
export function alloc(target: RenderWasmModule, size: number): number {
  if (size === 0) console.warn("render-wasm: tried to allocate 0 bytes");
  return call<number>(target, "_alloc_bytes", size);
}

// Releases the buffer handed out by the last `alloc` (the artifact keeps one
// pending allocation, not a table).
export function free(target: RenderWasmModule): void {
  call(target, "_free_bytes");
}

// Copies a string or binary payload into the heap and returns the offset
// after the last written byte, the cursor style the serializers chain on.
export function writeBuffer(
  heap: Uint8Array,
  value: Uint8Array | ArrayBuffer,
  offset: number,
): number {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  heap.set(bytes, offset);
  return offset + bytes.byteLength;
}

// Copies `size` bytes out of the heap. The copy is required before `free`:
// the returned array must not alias memory the next allocation reuses.
export function slice(heap: Uint8Array, offset: number, size: number): Uint8Array {
  return heap.slice(offset, offset + size);
}

// Emscripten's UTF8ToString, used for text content and font data.
export function readString(
  target: RenderWasmModule,
  ptr: number,
  maxBytes?: number,
  ignoreNull?: boolean,
): string {
  if (maxBytes === undefined) return target.UTF8ToString(ptr);
  if (ignoreNull === undefined) return target.UTF8ToString(ptr, maxBytes);
  return target.UTF8ToString(ptr, maxBytes, ignoreNull);
}

export function sizeOf(value: Uint8Array | ArrayBuffer): number {
  return value.byteLength;
}
