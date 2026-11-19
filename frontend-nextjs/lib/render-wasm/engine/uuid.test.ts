import { describe, expect, it } from "vitest";
import { ZERO_UUID, isUuid, u32ToUuid, uuidToU32 } from "./uuid";

describe("uuidToU32", () => {
  it("packs the hex text into four big-endian words", () => {
    const words = uuidToU32("12345678-9abc-def0-1122-334455667788");
    expect(Array.from(words)).toEqual([
      0x12345678, 0x9abcdef0, 0x11223344, 0x55667788,
    ]);
  });

  it("keeps the high bit unsigned", () => {
    const words = uuidToU32("ffffffff-0000-0000-0000-000000000000");
    expect(words[0]).toBe(0xffffffff);
  });
});

describe("u32ToUuid", () => {
  it("round-trips a canonical id", () => {
    const id = "12345678-9abc-def0-1122-334455667788";
    const [a, b, c, d] = Array.from(uuidToU32(id));
    expect(u32ToUuid(a, b, c, d)).toBe(id);
  });

  it("pads each word and regroups the hex into 8-4-4-4-12", () => {
    expect(u32ToUuid(0x1, 0x2, 0x3, 0x4)).toBe(
      "00000001-0000-0002-0000-000300000004",
    );
  });
});

describe("isUuid", () => {
  it("accepts the canonical text in either case", () => {
    expect(isUuid(ZERO_UUID)).toBe(true);
    expect(isUuid("ABCDEF01-2345-6789-abcd-ef0123456789")).toBe(true);
  });

  it("rejects everything else", () => {
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("12345678-9abc-def0-1122-33445566778")).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
  });
});