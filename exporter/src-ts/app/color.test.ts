import { describe, expect, it } from "vitest";
import { colorString, parse, parseRgb, rgbToHex, validHexColor } from "./color.js";

describe("validHexColor", () => {
  it("accepts three and six digit hex only", () => {
    expect(validHexColor("#abc")).toBe(true);
    expect(validHexColor("#AABBCC")).toBe(true);
    expect(validHexColor("abc")).toBe(false);
    expect(validHexColor("#abcd")).toBe(false);
  });
});

describe("parseRgb", () => {
  it("reads rgb() and clamps the channels", () => {
    expect(parseRgb("rgb(255, 0, 128)")).toEqual([255, 0, 128]);
    expect(parseRgb("(1,2,3)")).toEqual([1, 2, 3]);
    expect(parseRgb("rgb(300, 0, 0)")).toBeUndefined();
    expect(parseRgb("red")).toBeUndefined();
  });
});

describe("colorString", () => {
  it("accepts hex, rgb and keywords", () => {
    expect(colorString("#fff")).toBe(true);
    expect(colorString("rgb(1,2,3)")).toBe(true);
    expect(colorString("red")).toBe(true);
    expect(colorString("#12")).toBe(false);
    expect(colorString(42)).toBe(false);
  });
});

describe("parse", () => {
  it("normalizes hex colors", () => {
    expect(parse("#ABC")).toBe("#aabbcc");
    expect(parse("#AABBCC")).toBe("#aabbcc");
  });

  it("converts rgb and keyword colors", () => {
    expect(parse("rgb(255, 0, 0)")).toBe("#ff0000");
    expect(parse("RED")).toBe("#ff0000");
  });

  it("returns nil for an unknown color", () => {
    expect(parse("not-a-color")).toBeUndefined();
    expect(parse(undefined)).toBeUndefined();
  });
});

describe("rgbToHex", () => {
  it("pads channels below sixteen", () => {
    expect(rgbToHex([1, 2, 3])).toBe("#010203");
    expect(rgbToHex([255, 0, 0])).toBe("#ff0000");
  });

  it("rejects out-of-range channels", () => {
    expect(() => rgbToHex([256, 0, 0])).toThrow();
  });
});