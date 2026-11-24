import { describe, expect, it } from "vitest";
import {
  absPoint,
  add,
  angle,
  angleSign,
  angleToPoint,
  angleWithOther,
  centerPoints,
  decodePoint,
  distance,
  divide,
  dot,
  length,
  lerpPoint,
  multiply,
  negate,
  noZeros,
  normalLeft,
  normalRight,
  perpendicular,
  point,
  pointLineDistance,
  pointToString,
  project,
  quadrant,
  resizeVector,
  rotatePoint,
  roundStep,
  scaleFrom,
  scalePoint,
  signedAngleWithOther,
  subtract,
  toVec,
  transformPoint,
  unit,
} from "./point";

describe("point construction", () => {
  it("accepts scalar, pair and map forms", () => {
    expect(point()).toEqual({ x: 0, y: 0 });
    expect(point(3)).toEqual({ x: 3, y: 3 });
    expect(point(1, 2)).toEqual({ x: 1, y: 2 });
    expect(point({ x: 4, y: 5 })).toEqual({ x: 4, y: 5 });
  });

  it("decodes the transit string form", () => {
    expect(decodePoint("1,2")).toEqual({ x: 1, y: 2 });
    expect(decodePoint("1,2,3")).toEqual({ x: 1, y: 2 });
    expect(decodePoint("nope")).toBeUndefined();
    expect(pointToString({ x: 1.5, y: -2 })).toBe("1.5,-2");
  });
});

describe("point arithmetic", () => {
  it("adds, subtracts, multiplies and divides", () => {
    expect(add({ x: 1, y: 2 }, { x: 3, y: 4 })).toEqual({ x: 4, y: 6 });
    expect(subtract({ x: 3, y: 4 }, { x: 1, y: 2 })).toEqual({ x: 2, y: 2 });
    expect(multiply({ x: 2, y: 3 }, { x: 4, y: 5 })).toEqual({ x: 8, y: 15 });
    expect(divide({ x: 8, y: 15 }, { x: 4, y: 5 })).toEqual({ x: 2, y: 3 });
    expect(negate({ x: 2, y: -3 })).toEqual({ x: -2, y: 3 });
    expect(toVec({ x: 1, y: 1 }, { x: 3, y: 4 })).toEqual({ x: 2, y: 3 });
  });

  it("measures length and distance", () => {
    expect(distance({ x: 0, y: 0 }, { x: 3, y: 4 })).toBe(5);
    expect(length({ x: 3, y: 4 })).toBe(5);
    expect(dot({ x: 1, y: 2 }, { x: 3, y: 4 })).toBe(11);
  });

  it("scales and rounds", () => {
    expect(scalePoint({ x: 2, y: -3 }, 2)).toEqual({ x: 4, y: -6 });
    expect(roundStep({ x: 1.3, y: 2.6 }, 0.5)).toEqual({ x: 1.5, y: 2.5 });
    expect(lerpPoint({ x: 0, y: 0 }, { x: 10, y: 20 }, 0.5)).toEqual({ x: 5, y: 10 });
    expect(absPoint({ x: -2, y: 3 })).toEqual({ x: 2, y: 3 });
  });
});

describe("point angles", () => {
  it("measures from the x axis or from a center", () => {
    expect(angle({ x: 0, y: 1 })).toBe(90);
    expect(angle({ x: 1, y: 1 }, { x: 0, y: 0 })).toBeCloseTo(45, 10);
    expect(angle({ x: -1, y: 0 })).toBe(180);
  });

  it("measures the angle between vectors with its sign", () => {
    expect(angleWithOther({ x: 1, y: 0 }, { x: 0, y: 1 })).toBeCloseTo(90, 10);
    expect(angleWithOther({ x: 0, y: 0 }, { x: 0, y: 1 })).toBe(0);
    expect(angleSign({ x: 0, y: 1 }, { x: 1, y: 0 })).toBe(-1);
    expect(angleSign({ x: 1, y: 0 }, { x: 0, y: 1 })).toBe(1);
    expect(signedAngleWithOther({ x: 0, y: 1 }, { x: 1, y: 0 })).toBeCloseTo(-90, 10);
  });

  it("reports quadrants and follows an angle", () => {
    expect(quadrant({ x: 1, y: 1 })).toBe(1);
    expect(quadrant({ x: -1, y: 1 })).toBe(2);
    expect(quadrant({ x: -1, y: -1 })).toBe(3);
    expect(quadrant({ x: 1, y: -1 })).toBe(4);
    const followed = angleToPoint({ x: 0, y: 0 }, Math.PI / 2, 10);
    expect(followed.x).toBeCloseTo(0, 10);
    expect(followed.y).toBeCloseTo(-10, 10);
  });
});

describe("point vectors", () => {
  it("normalizes and projects", () => {
    expect(unit({ x: 3, y: 4 })).toEqual({ x: 0.6, y: 0.8 });
    expect(unit({ x: 0, y: 0 })).toEqual({ x: 0, y: 0 });
    expect(perpendicular({ x: 2, y: 3 })).toEqual({ x: -3, y: 2 });
    expect(project({ x: 2, y: 2 }, { x: 1, y: 0 })).toEqual({ x: 2, y: 0 });
    expect(normalLeft({ x: 1, y: 0 }).x).toBeCloseTo(0, 10);
    expect(normalLeft({ x: 1, y: 0 }).y).toBe(1);
    expect(normalRight({ x: 1, y: 0 }).x).toBeCloseTo(0, 10);
    expect(normalRight({ x: 1, y: 0 }).y).toBe(-1);
  });

  it("centers and resizes", () => {
    expect(centerPoints([{ x: 0, y: 0 }, { x: 2, y: 2 }])).toEqual({ x: 1, y: 1 });
    expect(centerPoints([])).toEqual({ x: 0, y: 0 });
    expect(resizeVector({ x: 3, y: 4 }, 10)).toEqual({ x: 6, y: 8 });
    expect(scaleFrom({ x: 2, y: 0 }, { x: 0, y: 0 }, 1)).toEqual({ x: 3, y: 0 });
    expect(noZeros({ x: 0, y: 5 })).toEqual({ x: 0.001, y: 5 });
  });

  it("computes point-line distance", () => {
    expect(pointLineDistance({ x: 0, y: 1 }, { x: 0, y: 0 }, { x: 1, y: 0 })).toBe(1);
    expect(pointLineDistance({ x: 2, y: 2 }, { x: 0, y: 0 }, { x: 4, y: 0 })).toBe(2);
  });
});

describe("point transforms", () => {
  it("applies a matrix", () => {
    const matrix = { a: 1, b: 0, c: 0, d: 1, e: 5, f: 7 };
    expect(transformPoint({ x: 1, y: 1 }, matrix)).toEqual({ x: 6, y: 8 });
    expect(transformPoint({ x: 1, y: 1 }, undefined)).toEqual({ x: 1, y: 1 });
  });

  it("rotates around a center", () => {
    const rotated = rotatePoint({ x: 1, y: 0 }, { x: 0, y: 0 }, 90);
    expect(rotated.x).toBeCloseTo(0, 10);
    expect(rotated.y).toBeCloseTo(1, 10);
  });
});
