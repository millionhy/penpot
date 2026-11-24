import { describe, expect, it } from "vitest";
import {
  COLOR_NAMES,
  expandHex,
  formatHsla,
  formatPrecision,
  formatRgba,
  hasValidColorAttrs,
  hexColorString,
  hexToHsb,
  hexToHsl,
  hexToHsv,
  hexToLum,
  hexToRgb,
  hslToHex,
  hslToRgb,
  hsbToHex,
  hsvToHex,
  hsvToRgb,
  interpolateColor,
  interpolateGradient,
  isUniformSpread,
  nextRgb,
  normalizeHex,
  parseColor,
  parseHexColor,
  parseRgb,
  prependHash,
  reduceRange,
  removeHash,
  rgbToHex,
  rgbToHsb,
  rgbToHsl,
  rgbToHsv,
  rgbToStr,
  sortColors,
  uniformSpread,
  validHexColor,
  validRgbColor,
  type GradientStop,
} from "./color";

describe("color attributes", () => {
  it("accepts exactly one of image, gradient or color", () => {
    expect(hasValidColorAttrs({ color: "#fff" })).toBe(true);
    expect(hasValidColorAttrs({ gradient: {}, opacity: 1 })).toBe(true);
    expect(hasValidColorAttrs({ color: "#fff", gradient: {} })).toBe(false);
    expect(hasValidColorAttrs({ opacity: 1 })).toBe(false);
    expect(hasValidColorAttrs(null)).toBe(false);
  });

  it("distinguishes the schema hex predicate from the loose helper", () => {
    expect(hexColorString("#abc")).toBe(true);
    expect(hexColorString("#aabbcc")).toBe(true);
    expect(hexColorString("abc")).toBe(false);
    expect(hexColorString("#abcd")).toBe(false);
    expect(validHexColor("#abc")).toBe(true);
    expect(validHexColor("#abcd")).toBe(false);
  });

  it("parses rgb() and plain (r, g, b) strings in range", () => {
    expect(parseRgb("rgb(1, 2, 3)")).toEqual([1, 2, 3]);
    expect(parseRgb("(255,0,10)")).toEqual([255, 0, 10]);
    expect(parseRgb("rgb(256, 0, 0)")).toBeUndefined();
    expect(parseRgb("rgb(1 2 3)")).toBeUndefined();
    expect(validRgbColor("rgb(0, 0, 0)")).toBe(true);
    expect(validRgbColor("#000")).toBe(false);
  });
});

describe("hex helpers", () => {
  it("expands bare hex digits like expand-hex", () => {
    expect(expandHex("f")).toBe("ffffff");
    expect(expandHex("0f")).toBe("0f0f0f");
    expect(expandHex("abc")).toBe("aabbcc");
    expect(expandHex("abcd")).toBe("abcd");
  });

  it("normalizes #RGB and lowercases #RRGGBB", () => {
    expect(normalizeHex("#ABC")).toBe("#aabbcc");
    expect(normalizeHex("#AABBCC")).toBe("#aabbcc");
  });

  it("adds and removes the hash", () => {
    expect(prependHash("fff")).toBe("#fff");
    expect(prependHash("#fff")).toBe("#fff");
    expect(removeHash("#fff")).toBe("fff");
    expect(removeHash("fff")).toBe("fff");
  });

  it("reads six digits and keeps the CLJS shorthand quirk", () => {
    expect(hexToRgb("#ff0000")).toEqual([255, 0, 0]);
    expect(hexToRgb("#0a0b0c")).toEqual([10, 11, 12]);
    // hex->rgb does not expand shorthand; parseInt("fff", 16) is 4095.
    expect(hexToRgb("#fff")).toEqual([0, 15, 255]);
    expect(hexToRgb("not-a-color")).toEqual([0, 0, 0]);
  });

  it("parses hex for UI call sites", () => {
    expect(parseHexColor("#abcdef")).toEqual([171, 205, 239]);
    expect(parseHexColor("abcdef")).toEqual([171, 205, 239]);
    expect(parseHexColor("#fff")).toEqual([255, 255, 255]);
    expect(parseHexColor("#abcd")).toBeUndefined();
  });

  it("computes luminance", () => {
    expect(hexToLum("#ffffff")).toBeCloseTo(Math.sqrt(255), 6);
    expect(hexToLum("#000000")).toBe(0);
  });
});

describe("rgb conversions", () => {
  it("formats rgb strings", () => {
    expect(rgbToStr([1, 2, 3])).toBe("rgb(1,2,3)");
    expect(rgbToStr([1, 2, 3, 0.5])).toBe("rgba(1,2,3,0.5)");
  });

  it("converts rgb to hex and rejects out-of-range channels", () => {
    expect(rgbToHex([255, 0, 0])).toBe("#ff0000");
    expect(rgbToHex([0, 0, 0])).toBe("#000000");
    expect(rgbToHex([16, 32, 48])).toBe("#102030");
    expect(() => rgbToHex([256, 0, 0])).toThrow(/not valid rgb/);
  });

  it("converts rgb to hsv and back", () => {
    expect(rgbToHsv([255, 0, 0])).toEqual([0, 1, 255]);
    expect(rgbToHsv([0, 255, 0])).toEqual([120, 1, 255]);
    expect(rgbToHsv([128, 128, 128])).toEqual([0, 0, 128]);
    expect(hsvToRgb([0, 1, 255])).toEqual([255, 0, 0]);
    expect(hsvToRgb([0, 0, 200])).toEqual([200, 200, 200]);
  });

  it("converts rgb to hsl with hue in degrees", () => {
    expect(rgbToHsl([255, 0, 0])).toEqual([0, 1, 0.5]);
    expect(rgbToHsl([0, 255, 0])).toEqual([120, 1, 0.5]);
    expect(rgbToHsl([0, 0, 255])).toEqual([240, 1, 0.5]);
    expect(rgbToHsl([128, 128, 128])).toEqual([0, 0, 128 / 255]);
  });

  it("keeps the unrounded gray branch of hsl->rgb", () => {
    expect(hslToRgb([0, 0, 0.5])).toEqual([127.5, 127.5, 127.5]);
    expect(hslToRgb([0, 1, 0.5])).toEqual([255, 0, 0]);
    expect(hslToRgb([120, 1, 0.5])).toEqual([0, 255, 0]);
  });
});

describe("hex conversions", () => {
  it("converts through hsv, hsl and hsb", () => {
    expect(hexToHsv("#ff0000")).toEqual([0, 1, 255]);
    expect(hexToHsl("#ff0000")).toEqual([0, 1, 0.5]);
    expect(hexToHsb("#ff0000")).toEqual([0, 1, 100]);
    expect(rgbToHsb([255, 0, 0])).toEqual([0, 1, 100]);
    expect(hsvToHex([120, 1, 255])).toBe("#00ff00");
    expect(hslToHex([240, 1, 0.5])).toBe("#0000ff");
    expect(hsbToHex([120, 1, 100])).toBe("#00ff00");
  });
});

describe("parse and names", () => {
  it("parses hex, rgb() and CSS names", () => {
    expect(parseColor("#abc")).toBe("#aabbcc");
    expect(parseColor("#AABBCC")).toBe("#aabbcc");
    expect(parseColor("rgb(1, 2, 3)")).toBe("#010203");
    expect(parseColor("red")).toBe("#ff0000");
    expect(parseColor("Rebeccapurple")).toBeUndefined();
    expect(parseColor(42)).toBeUndefined();
  });

  it("keeps the CSS color name table", () => {
    expect(Object.keys(COLOR_NAMES).length).toBeGreaterThan(140);
    expect(COLOR_NAMES.rebeccapurple).toBeUndefined();
    expect(COLOR_NAMES.red).toBe("#ff0000");
    expect(COLOR_NAMES.grey).toBe("#808080");
  });
});

describe("formatting", () => {
  it("drops trailing zeros", () => {
    expect(formatPrecision(1.2)).toBe("1.2");
    expect(formatPrecision(1.234)).toBe("1.23");
    expect(formatPrecision(2)).toBe("2");
    expect(formatPrecision(0.001)).toBe("0");
  });

  it("formats rgba and hsla tuples", () => {
    expect(formatRgba([255, 0, 0, 0.5])).toBe("255, 0, 0, 0.5");
    expect(formatHsla([120.7, 1, 0.5, 0.25])).toBe("120, 100%, 50%, 0.25");
  });
});

describe("color sequences and gradients", () => {
  it("walks rgb channels and reduces ranges", () => {
    expect(nextRgb([0, 0, 0])).toEqual([0, 0, 1]);
    expect(nextRgb([0, 255, 255])).toEqual([1, 0, 0]);
    expect(nextRgb([1, 255, 255])).toEqual([2, 0, 0]);
    expect(() => nextRgb([255, 255, 255])).toThrow(/next color/);
    expect(reduceRange(0.9, 8)).toBe(0.875);
  });

  it("orders colors by hue bucket then brightness", () => {
    const colors = [{ color: "#0000ff" }, { color: "#ff0000" }, { color: "#000000" }];
    expect([...colors].sort(sortColors).map((entry) => entry.color)).toEqual([
      "#000000",
      "#ff0000",
      "#0000ff",
    ]);
  });

  const from: GradientStop = { color: "#000000", opacity: 0, offset: 0 };
  const to: GradientStop = { color: "#ffffff", opacity: 1, offset: 1 };

  it("interpolates between stops", () => {
    const mid = interpolateColor(from, to, 0.5);
    expect(mid.color).toBe("#7f7f7f");
    expect(mid.opacity).toBe(0.5);
    expect(interpolateColor(from, to, -1).color).toBe("#000000");
    expect(interpolateColor(from, to, 2).color).toBe("#ffffff");
  });

  it("spreads stops uniformly", () => {
    const spread = uniformSpread(from, to, 3);
    expect(spread.map((stop) => stop.offset)).toEqual([0, 0.5, 1]);
    expect(spread[0].color).toBe("#000000");
    expect(spread[2].color).toBe("#ffffff");
    expect(isUniformSpread(spread)).toBe(true);
    expect(isUniformSpread([from, { ...to, offset: 0.6 }, to])).toBe(false);
  });

  it("finds the segment for an offset", () => {
    const stops: GradientStop[] = [
      from,
      { color: "#ff0000", opacity: 1, offset: 0.5 },
      to,
    ];
    expect(interpolateGradient(stops, 0.25).color).toBe("#7f0000");
    expect(interpolateGradient(stops, 0.75).color).toBe("#ff7f7f");
    expect(() => interpolateGradient([], 0.5)).toThrow(/no gradient stops/);
  });
});
