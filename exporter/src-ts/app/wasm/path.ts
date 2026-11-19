// app.common.render-wasm.api.props/set-shape-path-content, Node side.
//
// Path geometry is uploaded in fixed-size chunks so a large path never needs a
// single multi-megabyte allocation: `_start_shape_path_buffer`, one
// `_set_shape_path_chunk_buffer` per chunk, then `_set_shape_path_buffer`. The
// bytes are the shared `penpot/path-data` blob; the 4-byte padding keeps the
// chunk copy word-aligned, which is why the last chunk may carry zeros.
//
// Mirrors the browser setter in `common/.../api/props.cljs`.

import { call } from "./call.js";
import { alloc, heapU32, offset32 } from "./memory.js";
import { module, type WasmModule } from "../wasm.js";

export const MAX_BUFFER_CHUNK_SIZE = 256 * 1024;

export type PathContent = Uint8Array | ArrayBuffer;

function bytesOf(content: PathContent): Uint8Array {
  return content instanceof Uint8Array ? content : new Uint8Array(content);
}

export function setShapePathContent(
  content: PathContent,
  target: WasmModule = module(),
): void {
  const bytes = bytesOf(content);
  const paddedSize = Math.ceil(bytes.byteLength / 4) * 4;
  const buffer = new Uint8Array(paddedSize);
  buffer.set(bytes);

  call(target, "_start_shape_path_buffer");

  for (let offset = 0; offset < paddedSize; offset += MAX_BUFFER_CHUNK_SIZE) {
    const end = Math.min(paddedSize, offset + MAX_BUFFER_CHUNK_SIZE);
    const chunk = buffer.subarray(offset, end);
    // `paddedSize` is a multiple of four, so every chunk but a short last one
    // is too; the last one is padded, never truncated.
    const words = new Uint32Array(chunk.buffer, chunk.byteOffset, chunk.byteLength / 4);
    const ptr = alloc(target, words.byteLength);
    // Read the view after the allocation: growing the heap moves it.
    heapU32(target).set(words, offset32(ptr));
    call(target, "_set_shape_path_chunk_buffer");
  }

  call(target, "_set_shape_path_buffer");
}
