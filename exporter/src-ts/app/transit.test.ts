// app.transit: the two writers and the readers that normalize the wire shape.

import { describe, expect, it } from "vitest";
import { decode, encode, encodeVerbose, keywordMap, pathDataBytes, uuid } from "./transit.js";

const ID = "00000000-0000-0000-0000-000000000001";

// The transit body of the sample path in common-tests.types.path-data-test/
// path-data-transit-roundtrip: four 28 byte segments (move, line, curve,
// close).
const PATH_DATA =
  '["~#penpot/path-data","~bAQAAAAAAAAAAAAAAAAAAAAAAAAAAAPBDA' +
  'MBRRAIAAAAAAAAAAAAAAAAAAAAAAAAAAIDbQwCASEQDAAAAAAC4QwBAOEQ' +
  'AAJtDAEAqRAAAhEMAgB5EBAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' +
  'A=="]';

describe("keywordMap", () => {
  it("round-trips keyword keys through the compact writer", () => {
    const value = { state: "ended", progress: 100, "profile-id": "abc" };

    expect(decode(encode(keywordMap(value)))).toEqual(value);
  });

  it("drops undefined entries", () => {
    expect(decode(encode(keywordMap({ a: 1, b: undefined })))).toEqual({ a: 1 });
  });

  it("keeps a uuid as text", () => {
    expect(decode(encode(keywordMap({ id: uuid(ID) })))).toEqual({ id: ID });
  });

  it("revives an instant as a date", () => {
    const at = new Date("2026-01-02T03:04:05.678Z");
    const decoded = decode<{ at: Date }>(encode(keywordMap({ at })));

    expect(decoded.at).toBeInstanceOf(Date);
    expect(decoded.at.getTime()).toBe(at.getTime());
  });
});

describe("verbose writer", () => {
  it("writes the body as a json object", () => {
    const text = encodeVerbose(keywordMap({ state: "ended", progress: 0 }));

    expect(JSON.parse(text)).toEqual({ "~:state": "ended", "~:progress": 0 });
  });

  it("reads back a verbose body", () => {
    const text = encodeVerbose(keywordMap({ type: "not-found", code: "route-not-found" }));

    expect(decode(text)).toEqual({ type: "not-found", code: "route-not-found" });
  });
});

describe("reader handlers", () => {
  it("normalizes a transit map to a plain object", () => {
    expect(decode('["^ ","~:state","ended","~:n",2]')).toEqual({ state: "ended", n: 2 });
  });

  it("reads the penpot/path-data binary as bytes", () => {
    const bytes = decode<Uint8Array>(PATH_DATA);

    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.byteLength).toBe(4 * 28);

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getInt16(0, true)).toBe(1); // move-to
    expect(view.getFloat32(20, true)).toBe(480);
    expect(view.getFloat32(24, true)).toBe(839);
    expect(view.getInt16(28, true)).toBe(2); // line-to
    expect(view.getInt16(56, true)).toBe(3); // curve-to
    expect(view.getInt16(84, true)).toBe(4); // close-path
  });

  it("copies a binary string one char per byte", () => {
    expect(Array.from(pathDataBytes("\u0001\u0002\u0003"))).toEqual([1, 2, 3]);
  });

  it("rejects non binary values", () => {
    expect(() => pathDataBytes(42)).toThrow(/invalid path data/);
  });

  it("reads a uuid and an instant", () => {
    const decoded = decode<{ id: string; at: Date }>(`{"id":"~u${ID}","at":"~m0"}`);

    expect(decoded.id).toBe(ID);
    expect(decoded.at.getTime()).toBe(0);
  });
});