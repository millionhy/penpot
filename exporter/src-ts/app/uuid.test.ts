// app.uuid: fresh ids, validation and the wasm quartet.

import { describe, expect, it } from "vitest";
import { getU32, isUuid, next, parse, zero } from "./uuid.js";

const V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("next", () => {
  it("returns a fresh v4 id", () => {
    const first = next();
    const second = next();

    expect(first).toMatch(V4);
    expect(second).not.toBe(first);
  });
});

describe("isUuid", () => {
  it("checks the text shape", () => {
    expect(isUuid(zero)).toBe(true);
    expect(isUuid(zero.toUpperCase())).toBe(true);
    expect(isUuid("nope")).toBe(false);
    expect(isUuid(123)).toBe(false);
  });
});

describe("parse", () => {
  it("normalizes the case", () => {
    expect(parse(zero.toUpperCase())).toBe(zero);
  });

  it("rejects an invalid string", () => {
    expect(() => parse("nope")).toThrow("invalid string 'nope' for uuid");
  });
});

describe("getU32", () => {
  it("reads the four big-endian words", () => {
    expect(Array.from(getU32(zero))).toEqual([0, 0, 0, 0]);
    expect(Array.from(getU32("00000000-0000-0000-0000-000000000001"))).toEqual([0, 0, 0, 1]);
    expect(Array.from(getU32("ffffffff-ffff-ffff-ffff-ffffffffffff"))).toEqual([
      4294967295, 4294967295, 4294967295, 4294967295,
    ]);
  });
});