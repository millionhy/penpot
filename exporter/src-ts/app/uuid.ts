// app.common.uuid, reduced to what the exporter uses: fresh v4 ids, the zero
// sentinel and the u32 quartet the wasm bridge reads.
//
// The quartet is the hexadecimal text packed big-endian, the same layout the
// CLJS helper writes into wasm calls (getUint32 over the raw bytes).

import { randomUUID } from "node:crypto";

export const zero = "00000000-0000-0000-0000-000000000000";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function next(): string {
  return randomUUID();
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

// parse: validates and normalizes, raising the same message as the CLJS
// helper. parse* is the nil-returning variant there; nothing in the exporter
// calls it, so it stays out of the port.
export function parse(value: string): string {
  if (!isUuid(value)) throw new Error(`invalid string '${value}' for uuid`);
  return value.toLowerCase();
}

// uuid/from-unsigned-parts: the inverse of getU32, used when a uuid arrives as
// the four words the wasm store keys fonts by.
export function fromUnsignedParts(a: number, b: number, c: number, d: number): string {
  const hex = [a, b, c, d].map((word) => (word >>> 0).toString(16).padStart(8, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// uuid/get-u32: four 32-bit words read from the hex text.
export function getU32(id: string): Uint32Array {
  const hex = id.replace(/-/g, "");
  const out = new Uint32Array(4);
  for (let index = 0; index < 4; index += 1) {
    out[index] = Number.parseInt(hex.slice(index * 8, index * 8 + 8), 16) >>> 0;
  }
  return out;
}