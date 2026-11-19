import { describe, expect, it } from "vitest";
import { extractIds, parseNumbers, parseStyle, parseTransform } from "./svg.js";
import { point, transform } from "./geom.js";

describe("parseNumbers", () => {
  it("reads signed and exponent numbers, skipping empty matches", () => {
    expect(parseNumbers("1 -2.5 .5e1")).toEqual([1, -2.5, 5]);
    expect(parseNumbers("")).toEqual([]);
  });
});

describe("parseStyle", () => {
  it("splits declarations and keeps the first value", () => {
    // Like the CLJS original, only the whole declaration is trimmed.
    expect(parseStyle("fill: red; stroke:#000; fill: blue")).toEqual({
      fill: " red",
      stroke: "#000",
    });
  });

  it("tolerates empty declarations", () => {
    expect(parseStyle(";fill:red;")).toEqual({ fill: "red" });
  });
});

describe("parseTransform", () => {
  it("returns the identity for a missing value", () => {
    expect(parseTransform(undefined)).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });

  it("composes several transforms", () => {
    const m = parseTransform("translate(10, 20) scale(2)");
    expect(transform(point(1, 1), m)).toEqual({ x: 12, y: 22 });
  });

  it("handles every SVG transform type", () => {
    expect(transform(point(1, 2), parseTransform("matrix(1 0 0 1 5 6)"))).toEqual({ x: 6, y: 8 });
    expect(transform(point(1, 2), parseTransform("translate(3)"))).toEqual({ x: 4, y: 2 });
    expect(transform(point(1, 2), parseTransform("scale(3)"))).toEqual({ x: 3, y: 6 });
    const skewedX = transform(point(0, 1), parseTransform("skewX(45)"));
    expect(skewedX.x).toBeCloseTo(1);
    expect(skewedX.y).toBeCloseTo(1);

    const skewedY = transform(point(1, 0), parseTransform("skewY(45)"));
    expect(skewedY.x).toBeCloseTo(1);
    expect(skewedY.y).toBeCloseTo(1);
  });

  it("rotates around an explicit center", () => {
    const m = parseTransform("rotate(90 10 10)");
    const p = transform(point(20, 10), m);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(20);
  });
});

describe("extractIds", () => {
  it("reads every url reference", () => {
    expect(extractIds("url(#a) url('#b')")).toEqual(["a", "b"]);
  });

  it("flattens lists and ignores other values", () => {
    expect(extractIds(["url(#a)", "#b"])).toEqual(["a", "b"]);
    expect(extractIds(42)).toEqual([]);
  });
});