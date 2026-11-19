import { describe, expect, it } from "vitest";
import { hexToArgbU32 } from "./colors";

describe("hexToArgbU32", () => {
  it("packs an opaque six-digit color into ARGB", () => {
    expect(hexToArgbU32("#ff0000")).toBe(0xffff0000);
    expect(hexToArgbU32("#8c33eb")).toBe(0xff8c33eb);
  });

  it("applies the opacity as the alpha byte", () => {
    // floor(0.5 * 0xff), like the compiled helper: 0x7f, not 0x80.
    expect(hexToArgbU32("#ff0000", 0.5)).toBe(0x7fff0000);
    expect(hexToArgbU32("#ff0000", 0)).toBe(0x00ff0000);
  });

  it("expands three and four digit shorthand", () => {
    expect(hexToArgbU32("#fff")).toBe(0xffffffff);
    expect(hexToArgbU32("#f00", 1)).toBe(0xffff0000);
    expect(hexToArgbU32("#f008")).toBe(0x88ff0000);
  });

  it("accepts a six-digit value with the alpha suffix", () => {
    expect(hexToArgbU32("#ff000080")).toBe(0x80ff0000);
  });

  it("keeps the result unsigned", () => {
    expect(hexToArgbU32("#ffffff")).toBe(0xffffffff);
    expect(hexToArgbU32("#ffffff") > 0).toBe(true);
  });

  it("rejects values it cannot read instead of painting a wrong color", () => {
    expect(() => hexToArgbU32("#xyz")).toThrowError(/cannot read the color/);
    expect(() => hexToArgbU32("#ffff0")).toThrowError(/cannot read the color/);
  });
});