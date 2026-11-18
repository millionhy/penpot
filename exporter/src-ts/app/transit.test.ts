// app.transit: the two writers and the readers that normalize the wire shape.

import { describe, expect, it } from "vitest";
import { decode, encode, encodeVerbose, keywordMap, uuid } from "./transit.js";

const ID = "00000000-0000-0000-0000-000000000001";

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

  it("reads a uuid and an instant", () => {
    const decoded = decode<{ id: string; at: Date }>(`{"id":"~u${ID}","at":"~m0"}`);

    expect(decoded.id).toBe(ID);
    expect(decoded.at.getTime()).toBe(0);
  });
});