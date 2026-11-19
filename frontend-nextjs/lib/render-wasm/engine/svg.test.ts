import { describe, expect, it } from "vitest";
import {
  BLACK,
  IDENTITY_MATRIX,
  extractIds,
  isColorString,
  multiplyMatrix,
  parseColor,
  parseNumbers,
  parseStyle,
  parseTransform,
  rgbToHex,
  scaleMatrix,
  transformPoint,
  translateMatrix,
} from "./svg";

describe("parseStyle", () => {
  it("splits on the first colon and keeps the first occurrence", () => {
    expect(parseStyle("fill: url(#g) red; stop-color:#f00;fill:blue")).toEqual({
      fill: " url(#g) red",
      "stop-color": "#f00",
    });
  });

  it("keeps a key without a value", () => {
    expect(parseStyle("orphan")).toEqual({ orphan: undefined });
    expect(parseStyle(";")).toEqual({});
  });
});

describe("parseNumbers and parseTransform", () => {
  it("reads every numeric token", () => {
    expect(parseNumbers("10, 20 -3.5e2 .5 nope")).toEqual([10, 20, -350, 0.5]);
    expect(parseNumbers("")).toEqual([]);
  });

  it("builds the five transform forms", () => {
    expect(parseTransform("translate(10 20)")).toEqual(translateMatrix(10, 20));
    expect(parseTransform("translate(10)")).toEqual(translateMatrix(10, 0));
    expect(parseTransform("scale(2)")).toEqual(scaleMatrix(2, 2));
    expect(parseTransform("scale(2 3)")).toEqual(scaleMatrix(2, 3));
    expect(parseTransform("matrix(1,2,3,4,5,6)")).toEqual([1, 2, 3, 4, 5, 6]);

    const skewX = parseTransform("skewX(45)");
    expect([skewX[0], skewX[1], skewX[3], skewX[4], skewX[5]]).toEqual([1, 0, 1, 0, 0]);
    expect(skewX[2]).toBeCloseTo(1);

    const skewY = parseTransform("skewY(45)");
    expect([skewY[0], skewY[2], skewY[3], skewY[4], skewY[5]]).toEqual([1, 0, 1, 0, 0]);
    expect(skewY[1]).toBeCloseTo(1);
  });

  it("rotates around the origin or a centre", () => {
    const [a, b, c, d, e, f] = parseTransform("rotate(90)");
    expect(a).toBeCloseTo(0);
    expect(b).toBeCloseTo(1);
    expect(c).toBeCloseTo(-1);
    expect(d).toBeCloseTo(0);
    expect(e).toBe(0);
    expect(f).toBe(0);

    // Rotating the centre about itself answers the same point.
    const centre = transformPoint({ x: 10, y: 10 }, parseTransform("rotate(90 10 10)"));
    expect(centre.x).toBeCloseTo(10);
    expect(centre.y).toBeCloseTo(10);
  });

  it("multiplies the transforms in order", () => {
    // The second transform is applied in the space of the first: the
    // translate moves by (e, f) of the matrix, not by (1, 1).
    expect(parseTransform("matrix(1,2,3,4,5,6) translate(1,1)")).toEqual([
      1, 2, 3, 4, 9, 12,
    ]);
    expect(parseTransform(undefined)).toBe(IDENTITY_MATRIX);
    expect(parseTransform("nonsense")).toBe(IDENTITY_MATRIX);
  });

  it("treats a nil matrix as the identity", () => {
    const move = translateMatrix(1, 2);
    expect(multiplyMatrix(undefined, move)).toBe(move);
    expect(multiplyMatrix(move, null)).toBe(move);
    expect(multiplyMatrix(undefined, undefined)).toBe(IDENTITY_MATRIX);
  });

  it("transforms a point", () => {
    expect(transformPoint({ x: 1, y: 2 }, translateMatrix(10, 20))).toEqual({
      x: 11,
      y: 22,
    });
    expect(transformPoint({ x: 1, y: 2 }, scaleMatrix(2, 3))).toEqual({ x: 2, y: 6 });
  });
});

describe("extractIds", () => {
  it("reads the ids out of url() references", () => {
    expect(extractIds("url(#grad)")).toEqual(["grad"]);
    expect(extractIds("url('#a') url(\"#b\")")).toEqual(["a", "b"]);
    expect(extractIds(["url(#a)", 42, "url(#b)"])).toEqual(["a", "b"]);
    expect(extractIds(null)).toEqual([]);
  });
});

describe("colours", () => {
  it("recognizes the three accepted forms", () => {
    expect(isColorString("#fff")).toBe(true);
    expect(isColorString("#a1b2c3")).toBe(true);
    expect(isColorString("#ffff")).toBe(false);
    expect(isColorString("rgb(1, 2, 3)")).toBe(true);
    expect(isColorString("(1, 2, 3)")).toBe(true);
    expect(isColorString("red")).toBe(true);
    // The names lookup is case sensitive, like `(contains? names color)`.
    expect(isColorString("Red")).toBe(false);
    expect(isColorString(1)).toBe(false);
  });

  it("parses to the canonical lower-case hex", () => {
    expect(parseColor("#ABC")).toBe("#aabbcc");
    expect(parseColor("rgb(255, 0, 16)")).toBe("#ff0010");
    expect(parseColor("Red")).toBe("#ff0000");
    expect(parseColor("black")).toBe(BLACK);
    expect(parseColor("nope")).toBeUndefined();
    // The compiled normalize-hex leaves the short form without "#" as is.
    expect(parseColor("abc")).toBe("abc");
    expect(parseColor("#12345")).toBeUndefined();
  });

  it("formats a rgb triple", () => {
    expect(rgbToHex([255, 0, 0])).toBe("#ff0000");
    expect(rgbToHex([0, 0, 1])).toBe("#000001");
    expect(() => rgbToHex([256, 0, 0])).toThrow();
  });
});