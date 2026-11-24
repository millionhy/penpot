import { describe, expect, it } from "vitest";
import {
  UNIT_MATRIX,
  addTranslate,
  applyMatrix,
  determinant,
  formatMatrix,
  inverse,
  isMoveMatrix,
  isUnitMatrix,
  mEqual,
  matrix,
  matrixClose,
  matrixOf,
  multiply,
  multiplyAll,
  parseMatrix,
  rotateMatrix,
  roundMatrix,
  scaleMatrix,
  skewMatrix,
  subtract,
  transformIn,
  transformPointCenter,
  translateMatrix,
  translateMatrixNeg,
} from "./matrix";

describe("matrix construction", () => {
  it("fills a unit matrix from partial data", () => {
    expect(matrixOf(null)).toEqual(UNIT_MATRIX);
    expect(matrixOf("matrix(1, 2, 3, 4, 5, 6)")).toEqual(matrix(1, 2, 3, 4, 5, 6));
    expect(matrixOf({ a: 2, e: 5 })).toEqual({ a: 2, b: 0, c: 0, d: 1, e: 5, f: 0 });
    expect(matrixOf({ a: 2, b: 3, c: 4, d: 5, e: 6, f: 7 })).toEqual({
      a: 2,
      b: 3,
      c: 4,
      d: 5,
      e: 6,
      f: 7,
    });
  });

  it("formats and parses the CSS form", () => {
    expect(formatMatrix(UNIT_MATRIX, 2)).toBe("matrix(1.00, 0.00, 0.00, 1.00, 0.00, 0.00)");
    expect(formatMatrix(matrix(1, 2, 3, 4, 5, 6))).toBe("matrix(1.000000, 2.000000, 3.000000, 4.000000, 5.000000, 6.000000)");
    expect(parseMatrix("matrix(1, 2, 3, 4, 5, 6)")).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
    expect(parseMatrix("matrix(1e2 -3.5 0 1 4 5)")).toEqual({ a: 100, b: -3.5, c: 0, d: 1, e: 4, f: 5 });
  });

  it("compares against the unit matrix with tolerance", () => {
    expect(isUnitMatrix(UNIT_MATRIX)).toBe(true);
    expect(isUnitMatrix({ ...UNIT_MATRIX, a: 1.0005 })).toBe(true);
    expect(isUnitMatrix(translateMatrix(1, 0))).toBe(false);
    expect(matrixClose(UNIT_MATRIX, { ...UNIT_MATRIX, f: 0.0005 })).toBe(true);
  });
});

describe("matrix arithmetic", () => {
  it("composes in SVG order", () => {
    expect(multiply(translateMatrix(10, 20), scaleMatrix({ x: 2, y: 2 }))).toEqual({
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: 10,
      f: 20,
    });
    expect(multiplyAll(translateMatrix(1, 2), scaleMatrix({ x: 2, y: 2 }), translateMatrix(3, 4))).toEqual({
      a: 2,
      b: 0,
      c: 0,
      d: 2,
      e: 7,
      f: 10,
    });
  });

  it("adds translations without multiplying", () => {
    expect(addTranslate(translateMatrix(1, 2), translateMatrix(3, 4))).toEqual(matrix(1, 0, 0, 1, 4, 6));
    expect(translateMatrixNeg(3, 4)).toEqual(matrix(1, 0, 0, 1, -3, -4));
    expect(subtract(matrix(2, 2, 2, 2, 2, 2), matrix(1, 1, 1, 1, 1, 1))).toEqual(
      matrix(1, 1, 1, 1, 1, 1),
    );
  });

  it("inverts and rejects singular matrices", () => {
    expect(inverse(matrix(2, 0, 0, 2, 4, 6))).toEqual({ a: 0.5, b: -0, c: -0, d: 0.5, e: -2, f: -3 });
    expect(inverse(matrix(1, 2, 2, 4, 0, 0))).toBeUndefined();
    expect(determinant(matrix(2, 0, 0, 2, 4, 6))).toBe(4);
  });

  it("compares with an explicit threshold and rounds", () => {
    expect(mEqual(matrix(1, 0, 0, 1, 0, 0), matrix(1, 0, 0, 1, 0, 0.0004), 0.001)).toBe(true);
    expect(mEqual(matrix(1, 0, 0, 1, 0, 0), matrix(1, 0, 0, 1, 0, 0.002), 0.001)).toBe(false);
    expect(roundMatrix(matrix(1.23456, 0, 0, 1, 0, 0))).toEqual(matrix(1.2346, 0, 0, 1, 0, 0));
  });
});

describe("matrix transforms", () => {
  it("builds rotation, scale and skew", () => {
    const rotation = rotateMatrix(90);
    expect(rotation.a).toBeCloseTo(0, 10);
    expect(rotation.b).toBeCloseTo(1, 10);
    expect(rotation.c).toBeCloseTo(-1, 10);
    expect(rotation.d).toBeCloseTo(0, 10);
    expect(scaleMatrix({ x: 2, y: 3 })).toEqual(matrix(2, 0, 0, 3, 0, 0));
    expect(scaleMatrix({ x: 2, y: 2 }, { x: 5, y: 5 })).toEqual(matrix(2, 0, 0, 2, -5, -5));
    expect(skewMatrix(45, 0).a).toBeCloseTo(1, 10);
    expect(skewMatrix(45, 0).c).toBeCloseTo(1, 10);
  });

  it("applies points and centers", () => {
    expect(applyMatrix({ x: 1, y: 1 }, translateMatrix(5, 7))).toEqual({ x: 6, y: 8 });
    expect(transformPointCenter({ x: 2, y: 0 }, { x: 1, y: 0 }, rotateMatrix(90))).toEqual({
      x: 1,
      y: 1,
    });
    expect(transformIn({ x: 2, y: 3 }, translateMatrix(5, 5))).toEqual(matrix(1, 0, 0, 1, 5, 5));
    expect(transformIn(undefined, translateMatrix(5, 5))).toEqual(translateMatrix(5, 5));
  });

  it("detects pure translations", () => {
    expect(isMoveMatrix(translateMatrix(5, 5))).toBe(true);
    expect(isMoveMatrix(scaleMatrix({ x: 2, y: 2 }))).toBe(false);
  });
});
