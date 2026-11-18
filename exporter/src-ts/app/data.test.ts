// app.data: the small helpers the ported call sites rely on.

import { describe, expect, it } from "vitest";
import {
  distinctBy,
  groupBy,
  indexBy,
  mergeAttrs,
  obfuscateString,
  parseDouble,
  parseInteger,
  withoutNils,
} from "./data.js";

describe("withoutNils", () => {
  it("drops null and undefined only", () => {
    expect(withoutNils({ a: 1, b: null, c: undefined, d: 0, e: "" })).toEqual({ a: 1, d: 0, e: "" });
  });
});

describe("groupBy", () => {
  it("keeps the insertion order and every item", () => {
    const groups = groupBy((n: number) => n % 2, [1, 2, 3, 4, 5]);

    expect(Array.from(groups.keys())).toEqual([1, 0]);
    expect(groups.get(1)).toEqual([1, 3, 5]);
    expect(groups.get(0)).toEqual([2, 4]);
  });
});

describe("indexBy", () => {
  it("keys the items by an attribute", () => {
    expect(indexBy((item: { id: string }) => item.id, [{ id: "a" }, { id: "b" }])).toEqual({
      a: { id: "a" },
      b: { id: "b" },
    });
  });
});

describe("distinctBy", () => {
  it("keeps the first item of each key", () => {
    expect(distinctBy((n: { id: number }) => n.id, [{ id: 1 }, { id: 1 }, { id: 2 }])).toEqual([
      { id: 1 },
      { id: 2 },
    ]);
  });
});

describe("obfuscateString", () => {
  it("keeps the first five characters when long enough", () => {
    expect(obfuscateString("0123456789")).toBe("01234*****");
  });

  it("stars short values and the full mode", () => {
    expect(obfuscateString("short")).toBe("*****");
    expect(obfuscateString("abcdefghij", true)).toBe("**********");
    expect(obfuscateString("")).toBe("");
  });
});

describe("parseDouble and parseInteger", () => {
  it("falls back on a non-finite value", () => {
    expect(parseDouble("1.5")).toBe(1.5);
    expect(parseDouble("nope", 3)).toBe(3);
    expect(parseDouble(Infinity, 2)).toBe(2);
    expect(parseInteger("12px", 7)).toBe(12);
    expect(parseInteger("nope", 7)).toBe(7);
  });
});

describe("mergeAttrs", () => {
  it("lets the second map win", () => {
    expect(mergeAttrs({ a: 1, b: 2 }, { b: 3, c: 4 })).toEqual({ a: 1, b: 3, c: 4 });
    expect(mergeAttrs(undefined, undefined)).toEqual({});
  });
});