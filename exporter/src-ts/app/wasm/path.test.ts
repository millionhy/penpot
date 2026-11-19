import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSerializers } from "./enums.js";
import { MAX_BUFFER_CHUNK_SIZE, setShapePathContent } from "./path.js";
import { testSerializers } from "../../test/enums.js";
import { fakeWasm, record, viewOf } from "../../test/fake-wasm.js";

beforeEach(() => {
  setSerializers(testSerializers);
});

afterEach(() => {
  setSerializers(undefined);
});

function harness() {
  const target = fakeWasm(2 << 20);
  record(target, "_start_shape_path_buffer");
  record(target, "_set_shape_path_chunk_buffer");
  record(target, "_set_shape_path_buffer");
  return target;
}

describe("path content", () => {
  it("uploads a single chunk between the start and finish calls", () => {
    const target = harness();
    setShapePathContent(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]), target);

    expect(target.calls.map((call) => call.name)).toEqual([
      "_start_shape_path_buffer",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
    expect(target.allocs).toEqual([256]);

    const view = viewOf(target);
    expect(view.getUint32(256, true)).toBe(0x04030201);
    expect(view.getUint32(260, true)).toBe(0x08070605);
    expect(target.frees).toBe(0);
  });

  it("pads the last word with zeros instead of truncating", () => {
    const target = harness();
    setShapePathContent(new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd, 0x01]), target);

    const view = viewOf(target);
    expect(view.getUint32(256, true)).toBe(0xddccbbaa);
    expect(view.getUint32(260, true)).toBe(0x00000001);
  });

  it("splits a payload larger than the chunk budget", () => {
    const target = harness();
    const size = MAX_BUFFER_CHUNK_SIZE + 4;
    const bytes = new Uint8Array(size);
    bytes[0] = 0x11;
    bytes[size - 4] = 0x22;

    setShapePathContent(bytes, target);

    expect(target.allocs).toEqual([256, 256 + MAX_BUFFER_CHUNK_SIZE]);
    const view = viewOf(target);
    expect(view.getUint32(256, true)).toBe(0x00000011);
    expect(view.getUint32(256 + MAX_BUFFER_CHUNK_SIZE, true)).toBe(0x00000022);

    expect(target.calls.map((call) => call.name)).toEqual([
      "_start_shape_path_buffer",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
  });

  it("accepts an ArrayBuffer", () => {
    const target = harness();
    const buffer = new Uint8Array([9, 8, 7, 6]).buffer;
    setShapePathContent(buffer, target);

    expect(viewOf(target).getUint32(256, true)).toBe(0x06070809);
  });
});
