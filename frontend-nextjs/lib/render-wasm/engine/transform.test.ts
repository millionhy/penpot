import { describe, expect, it } from "vitest";
import { makeRect, rectToPoints } from "./bounds";
import {
  shapeCenter,
  transformMatrix,
  transformMatrixString,
  translateShape,
} from "./transform";

function selrect() {
  return makeRect(10, 20, 100, 50);
}

function shape(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "shape-1",
    type: "rect",
    x: 10,
    y: 20,
    width: 100,
    height: 50,
    selrect: selrect(),
    points: rectToPoints(selrect()),
    ...overrides,
  };
}

describe("shapeCenter", () => {
  it("is the center of the selrect", () => {
    expect(shapeCenter(shape())).toEqual({ x: 60, y: 45 });
  });

  it("falls back to the origin without a selrect", () => {
    expect(shapeCenter({})).toEqual({ x: 0, y: 0 });
  });
});

describe("transformMatrixString", () => {
  it("is empty without a transform or a flip", () => {
    expect(transformMatrixString(shape())).toBe("");
  });

  it("prints six decimals and the full matrix() form", () => {
    expect(
      transformMatrixString(shape({ transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } })),
    ).toBe("matrix(1.000000, 0.000000, 0.000000, 1.000000, 0.000000, 0.000000)");
  });

  it("keeps a translation unchanged by the center conjugation", () => {
    expect(
      transformMatrixString(shape({ transform: { a: 1, b: 0, c: 0, d: 1, e: 10, f: 20 } })),
    ).toBe("matrix(1.000000, 0.000000, 0.000000, 1.000000, 10.000000, 20.000000)");
  });

  it("moves a rotation to the center of the shape", () => {
    // (60, 45) has to stay put: x' = -45 + 105, y' = 60 - 15.
    expect(
      transformMatrixString(shape({ transform: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 } })),
    ).toBe("matrix(0.000000, 1.000000, -1.000000, 0.000000, 105.000000, -15.000000)");
  });

  it("applies the flips only with no-flip", () => {
    const flipped = shape({ "flip-x": true });
    expect(transformMatrixString(flipped, { noFlip: true })).toBe(
      "matrix(-1.000000, 0.000000, 0.000000, 1.000000, 120.000000, 0.000000)",
    );
    expect(transformMatrixString(flipped)).toBe("");
  });
});

describe("transformMatrix", () => {
  it("is the identity for a unit transform at the center", () => {
    expect(
      transformMatrix(shape({ transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 } })),
    ).toEqual([1, 0, 0, 1, 0, 0]);
  });
});

describe("translateShape", () => {
  it("shifts x, y, the selrect and the points of a rect", () => {
    const moved = translateShape(shape(), 5, -7);
    expect(moved.x).toBe(15);
    expect(moved.y).toBe(13);
    expect(moved.selrect).toEqual(makeRect(15, 13, 100, 50));
    expect((moved.points as Array<{ x: number; y: number }>)[0]).toEqual({ x: 15, y: 13 });
  });

  it("keeps the content coordinates of a path and moves only its box", () => {
    const moved = translateShape(shape({ type: "path" }), 5, 5);
    expect(moved.x).toBe(10);
    expect(moved.y).toBe(20);
    expect(moved.selrect).toEqual(makeRect(15, 25, 100, 50));
  });

  it("shifts the position-data of a text shape", () => {
    const moved = translateShape(
      shape({
        type: "text",
        "position-data": [
          { x: 1, y: 2, text: "a" },
          { x: 3, y: 4, text: "b" },
        ],
      }),
      10,
      20,
    );
    expect(moved["position-data"]).toEqual([
      { x: 11, y: 22, text: "a" },
      { x: 13, y: 24, text: "b" },
    ]);
  });

  it("answers the same value for a zero delta", () => {
    const value = shape();
    expect(translateShape(value, 0, 0)).toBe(value);
  });
});
