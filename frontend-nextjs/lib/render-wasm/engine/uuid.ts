// The uuid helpers the shape upload needs.
//
// app.common.uuid packs a uuid into the four big-endian words the wasm
// setters take (`_use_shape`, every record's id field); the zero sentinel is
// the parent of every top-level shape. The model keeps ids as the canonical
// lowercase text, so the words are derived from the hex digits rather than
// from a byte buffer.

export const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// uuid/get-u32: four 32-bit words read from the hex text.
export function uuidToU32(id: string): Uint32Array {
  const hex = id.replace(/-/g, "");
  const out = new Uint32Array(4);
  for (let index = 0; index < 4; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 8, index * 8 + 8), 16) >>> 0;
  }
  return out;
}

// uuid/next. `crypto.randomUUID` exists in every browser Next 15 targets and
// in the Node test runner; the fallback keeps the call total in older hosts
// (it is not a v4 uuid, only a value unique enough for a renderer id).
export function nextUuid(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  const hex = () => Math.floor(Math.random() * 0x10000).toString(16).padStart(4, "0");
  return `${hex()}${hex()}-${hex()}-4${hex().slice(1)}-a${hex().slice(1)}-${hex()}${hex()}${hex()}`;
}

// uuid/from-unsigned-parts: the inverse, for ids the wasm side returns.
export function u32ToUuid(a: number, b: number, c: number, d: number): string {
  const hex = [a, b, c, d]
    .map((word) => (word >>> 0).toString(16).padStart(8, "0"))
    .join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}