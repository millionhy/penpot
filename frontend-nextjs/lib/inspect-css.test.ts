import { describe, expect, it } from "vitest";

import {
  colorToBackground,
  cssProperty,
  cssValue,
  fillColor,
  formatBlur,
  formatCssValue,
  formatHsla,
  formatMatrix,
  formatNumber,
  formatPercent,
  formatPixels,
  formatPrecision,
  formatRgba,
  gradientToCss,
  humanizeCssRule,
  inverseMatrix,
  isUnitMatrix,
  matrixOf,
  multiplyMatrix,
  opacityToHex,
  pointsToRect,
  rgbToHsl,
  shadowRule,
  shadowToCss,
  shapePropertiesCss,
  strokeColor,
  transformPoint,
  transformPoints,
  translateMatrix,
  type InspectMatrix,
} from "@/lib/inspect-css";
import type { ViewerObjects, ViewerShape } from "@/lib/viewer";

// The CSS engine behind the computed panel: numbers, colours, matrices and
// the "property: value;" rules the copy buttons write.

describe("number formatters", () => {
  it("rounds to two decimals and drops the trailing zeros", () => {
    expect(formatNumber(1.234)).toBe("1.23");
    expect(formatNumber(10)).toBe("10");
    expect(formatNumber("12.5")).toBe("12.5");
    expect(formatNumber(null)).toBe("");
    expect(formatNumber("not-a-number")).toBe("not-a-number");
  });

  it("adds the px unit and the percent sign", () => {
    expect(formatPixels(12.5)).toBe("12.5px");
    expect(formatPixels(12.345)).toBe("12.35px");
    expect(formatPixels(undefined)).toBe("");
    expect(formatPercent(0.256)).toBe("25.6%");
    expect(formatPercent(0.5)).toBe("50%");
  });

  it("keeps at most the requested precision", () => {
    expect(formatPrecision(1.2)).toBe("1.2");
    expect(formatPrecision(2)).toBe("2");
    expect(formatPrecision(0.333)).toBe("0.33");
  });

  it("prints a matrix with two decimals", () => {
    expect(formatMatrix({ a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 })).toBe(
      "matrix(1.00, 0.00, 0.00, 1.00, 10.00, 20.00)",
    );
  });
});

describe("colour formatters", () => {
  it("converts rgb to hsl", () => {
    expect(rgbToHsl(255, 0, 0)).toEqual([0, 1, 0.5]);
    expect(rgbToHsl(0, 255, 0)).toEqual([120, 1, 0.5]);
    expect(rgbToHsl(128, 128, 128)).toEqual([0, 0, 128 / 255]);
  });

  it("prints rgba and hsla", () => {
    expect(formatRgba(255, 0, 0, 0.5)).toBe("255, 0, 0, 0.5");
    expect(formatHsla(120, 1, 0.5, 0.25)).toBe("120, 100%, 50%, 0.25");
  });

  it("writes the opacity byte in uppercase hex", () => {
    expect(opacityToHex(1)).toBe("FF");
    expect(opacityToHex(0.5)).toBe("80");
    expect(opacityToHex(0)).toBe("00");
  });

  it("picks the background syntax from the colour format", () => {
    const color = { color: "#ff0000", opacity: 0.5 };

    expect(colorToBackground(color, "hex")).toBe("#ff000080");
    expect(colorToBackground(color, "rgba")).toBe("rgba(255, 0, 0, 0.5)");
    expect(colorToBackground(color, "hsla")).toBe("hsla(0, 100%, 50%, 0.5)");
  });

  it("serialises gradient stops with their offset", () => {
    const stops = [
      { color: "#ff0000", opacity: 1, offset: 0 },
      { color: "#00ff00", opacity: 0.5, offset: 100 },
    ];

    expect(gradientToCss({ type: "linear", stops })).toBe(
      "linear-gradient(to bottom, rgba(255, 0, 0, 1) 0%, rgba(0, 255, 0, 0.5) 100%)",
    );
    expect(gradientToCss({ type: "radial", stops })).toBe(
      "radial-gradient(circle, rgba(255, 0, 0, 1) 0%, rgba(0, 255, 0, 0.5) 100%)",
    );
  });

  it("reads the fill and stroke colours out of the maps", () => {
    expect(fillColor({ "fill-color": "#123456", "fill-opacity": 0.25 })).toMatchObject({
      color: "#123456",
      opacity: 0.25,
    });
    expect(strokeColor({ "stroke-color": "#abcdef", "stroke-opacity": 0.5 })).toMatchObject({
      color: "#abcdef",
      opacity: 0.5,
    });
  });
});

describe("matrix helpers", () => {
  const unit: InspectMatrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

  it("fills the missing parts of a matrix from the unit one", () => {
    expect(matrixOf({ a: 2, e: 5 })).toEqual({ a: 2, b: 0, c: 0, d: 1, e: 5, f: 0 });
    expect(matrixOf(null)).toEqual(unit);
  });

  it("composes two matrices with the SVG order", () => {
    const scale = { a: 2, b: 0, c: 0, d: 3, e: 0, f: 0 };

    expect(multiplyMatrix(translateMatrix(10, 20), scale)).toEqual({
      a: 2,
      b: 0,
      c: 0,
      d: 3,
      e: 10,
      f: 20,
    });
  });

  it("inverts and detects the unit matrix", () => {
    const inverse = inverseMatrix({ a: 2, b: 0, c: 0, d: 2, e: 4, f: 6 });

    expect(inverse.a).toBe(0.5);
    expect(inverse.d).toBe(0.5);
    expect(inverse.e).toBe(-2);
    expect(inverse.f).toBe(-3);
    expect(inverse.b === 0 && inverse.c === 0).toBe(true);
    expect(inverseMatrix({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 })).toEqual(unit);
    expect(isUnitMatrix(unit)).toBe(true);
    expect(isUnitMatrix(translateMatrix(1, 0))).toBe(false);
  });

  it("transforms points around a centre and boxes the result", () => {
    const rotate = { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 };

    expect(transformPoint({ x: 1, y: 1 }, translateMatrix(5, 7))).toEqual({ x: 6, y: 8 });
    const points = transformPoints(
      [
        { x: 1, y: 0 },
        { x: 0, y: 1 },
      ],
      { x: 0, y: 0 },
      rotate,
    );
    expect(points).toEqual([
      { x: 0, y: 1 },
      { x: -1, y: 0 },
    ]);
    expect(pointsToRect(points)).toEqual({ x: -1, y: 0, width: 1, height: 1 });
  });
});

describe("CSS rules", () => {
  it("humanizes a property name", () => {
    expect(humanizeCssRule("border-block-start-width")).toBe("Border block start width");
    expect(humanizeCssRule("width")).toBe("Width");
  });

  it("formats blur and shadow shorthands", () => {
    expect(formatBlur(4)).toBe("blur(4px)");
    expect(formatBlur(4.5)).toBe("blur(4.5px)");

    const shadow = {
      style: "inner-shadow",
      "offset-x": 1,
      "offset-y": 2,
      blur: 3,
      spread: 4,
      color: { color: "#000000", opacity: 1 },
    };
    expect(shadowToCss(shadow)).toBe("inset 1px 2px 3px 4px #000000FF");
    expect(shadowRule(shadow)).toBe("box-shadow: inset 1px 2px 3px 4px #000000FF;");
  });

  it("formats values by property kind", () => {
    expect(formatCssValue("width", 10.5)).toBe("10.5px");
    expect(formatCssValue("width", "fill")).toBe("100%");
    expect(formatCssValue("width", "auto")).toBe("auto");
    expect(formatCssValue("margin", [1, 2, 3, 4])).toBe("1px 2px 3px 4px");
    expect(formatCssValue("border-style", { style: "solid" })).toBe("solid");
    expect(formatCssValue("border-width", { width: 2 })).toBe("2px");
    expect(formatCssValue("opacity", null)).toBeNull();
  });

  it("reads one property of a shape", () => {
    const rect: ViewerShape = {
      id: "rect",
      type: "rect",
      selrect: { x: 0, y: 0, width: 100, height: 50 },
      "blend-mode": "multiply",
    };
    const objects: ViewerObjects = { rect };

    expect(cssValue("width", rect, objects)).toBe("100px");
    expect(cssValue("height", rect, objects)).toBe("50px");
    expect(cssProperty("width", rect, objects)).toBe("width: 100px;");
    expect(cssProperty("blend-mode", rect, objects)).toBe("mix-blend-mode: multiply;");
    expect(cssValue("left", rect, objects)).toBeNull();
  });

  it("joins the rules of one block with indentation", () => {
    const rect: ViewerShape = {
      id: "rect",
      type: "rect",
      selrect: { x: 0, y: 0, width: 100, height: 50 },
    };

    expect(shapePropertiesCss(rect, { rect }, ["width", "height", "opacity"])).toBe(
      "  width: 100px;\n  height: 50px;",
    );
  });
});
