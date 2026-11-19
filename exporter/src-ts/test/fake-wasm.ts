// A minimal render-wasm stand-in: a flat zeroed heap, a bump allocator that
// mirrors the Rust one (4-byte aligned, zeroed), and a call log the tests can
// assert on. Functions the code under test calls are installed with `record`.

import type { WasmModule } from "../app/wasm.js";

export interface RecordedCall {
  name: string;
  args: unknown[];
}

export interface FakeWasm extends WasmModule {
  allocs: number[];
  frees: number;
  calls: RecordedCall[];
}

export function fakeWasm(size = 1 << 20): FakeWasm {
  const buffer = new ArrayBuffer(size);
  const heapU8 = new Uint8Array(buffer);
  const heapU32 = new Uint32Array(buffer);
  let next = 256;

  const fake: FakeWasm = {
    HEAPU8: heapU8,
    HEAPU32: heapU32,
    allocs: [],
    frees: 0,
    calls: [],
    _alloc_bytes(count: number) {
      const ptr = next;
      next += Math.ceil(count / 4) * 4;
      fake.allocs.push(ptr);
      return ptr;
    },
    _free_bytes() {
      fake.frees += 1;
    },
  };

  return fake;
}

// Installs `<name>` and records every call. The optional implementation's
// return value is passed through.
export function record(
  target: FakeWasm,
  name: string,
  impl?: (...args: unknown[]) => unknown,
): void {
  target[name] = (...args: unknown[]) => {
    target.calls.push({ name, args });
    return impl?.(...args);
  };
}

export function viewOf(target: FakeWasm): DataView {
  return new DataView(target.HEAPU8.buffer);
}
