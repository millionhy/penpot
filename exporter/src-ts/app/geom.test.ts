import { describe, expect, it } from "vitest";
import {
  distance,
  makeRect,
  matrix,
  multiply,
  point,
  rotateMatrix,
  scaleMatrix,
  skewMatrix,
  transform,
  translateMatrix,
} from "./geom.js";

describe("point", () => {
  it("defaults both coordinates to the first argument", () => {
    expect(point()).toEqual({ x: 0, y: 0 });
    expect(point(4)).toEqual({ x: 4, y: 4 });
    expect(point(1, 2)).toEqual({ x: 1, y: 2 });
  });

  it("returns the point untouched without a matrix", () => {
    const p = point(3, 4);
    expect(transform(p)).toBe(p);
    expect(transform(p, null)).toBe(p);
  });

  it("measures the euclidean distance", () => {
    expect(distance(point(0, 0), point(3, 4))).toBe(5);
  });
});

describe("matrix", () => {
  it("composes left to right", () => {
    const m = multiply(translateMatrix(10, 20), scaleMatrix(2));
    expect(transform(point(1, 1), m)).toEqual({ x: 12, y: 22 });
  });

  it("rotates around a center", () => {
    const m = rotateMatrix(90, point(10, 10));
    const p = transform(point(10, 10), m);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(10);

    const rotated = transform(point(20, 10), m);
    expect(rotated.x).toBeCloseTo(10);
    expect(rotated.y).toBeCloseTo(20);
  });

  it("skews one axis", () => {
    const m = skewMatrix(45, 0);
    const p = transform(point(0, 10), m);
    expect(p.x).toBeCloseTo(10);
    expect(p.y).toBeCloseTo(10);
  });

  it("starts from the identity", () => {
    expect(matrix()).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  });
});

describe("rect", () => {
  it("gives every rect positive extents", () => {
    expect(makeRect({ x: 5, y: 6, width: 0, height: -3 })).toEqual({
      x: 5,
      y: 6,
      width: 0.01,
      height: 0.01,
      x1: 5,
      y1: 6,
      x2: 5.01,
      y2: 6.01,
    });
  });

  it("fills the defaults", () => {
    expect(makeRect()).toEqual({ x: 0, y: 0, width: 0.01, height: 0.01, x1: 0, y1: 0, x2: 0.01, y2: 0.01 });
  });
});