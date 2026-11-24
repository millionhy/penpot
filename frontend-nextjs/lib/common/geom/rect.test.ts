import { describe, expect, it } from "vitest";
import {
  boundsToRect,
  centerToRect,
  clipRect,
  containsPoint,
  containsRect,
  cornersToRect,
  fixAspectRatio,
  joinRects,
  makeRect,
  overlapsRects,
  pointsToRect,
  rectClose,
  rectToCenter,
  rectToLines,
  rectToPoint,
  rectToPoints,
  squaredPoints,
  updateRect,
} from "./rect";

describe("rect construction", () => {
  it("keeps the 0.01 minimum size", () => {
    expect(makeRect()).toEqual({
      x: 0,
      y: 0,
      width: 0.01,
      height: 0.01,
      x1: 0,
      y1: 0,
      x2: 0.01,
      y2: 0.01,
    });
    expect(makeRect(2, 3, 0, -4)).toMatchObject({
      x: 2,
      y: 3,
      width: 0.01,
      height: 0.01,
      x2: 2.01,
      y2: 3.01,
    });
  });

  it("builds from data or two opposite points", () => {
    expect(makeRect({ x: 4, y: 5, width: 6, height: 7 })).toMatchObject({
      x: 4,
      y: 5,
      width: 6,
      height: 7,
      x1: 4,
      y1: 5,
      x2: 10,
      y2: 12,
    });
    expect(makeRect({ x: 4, y: 5 })).toMatchObject({
      width: 0.01,
      height: 0.01,
    });
    expect(makeRect({ x: 10, y: 20 }, { x: 2, y: 5 })).toMatchObject({
      x: 2,
      y: 5,
      width: 8,
      height: 15,
      x2: 10,
      y2: 20,
    });
  });

  it("refreshes corners from the position or the position from corners", () => {
    const rect = makeRect(10, 20, 30, 40);
    expect(updateRect(rect, "size")).toMatchObject({ x1: 10, y1: 20, x2: 40, y2: 60 });
    const reversed = { ...rect, x1: 40, y1: 60, x2: 10, y2: 20 };
    expect(updateRect(reversed, "corners")).toMatchObject({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });
});

describe("rect conversions", () => {
  it("converts to corners, center and lines", () => {
    const rect = makeRect(10, 20, 30, 40);
    expect(rectToPoint(rect)).toEqual({ x: 10, y: 20 });
    expect(rectToCenter(rect)).toEqual({ x: 25, y: 40 });
    expect(rectToPoints(rect)).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
    expect(rectToLines(rect)).toEqual([
      [{ x: 10, y: 20 }, { x: 40, y: 20 }],
      [{ x: 40, y: 20 }, { x: 40, y: 60 }],
      [{ x: 40, y: 60 }, { x: 10, y: 60 }],
      [{ x: 10, y: 60 }, { x: 10, y: 20 }],
    ]);
  });

  it("bounds point lists and rejects empty or non-finite input", () => {
    expect(pointsToRect([{ x: 4, y: 40 }, { x: 0, y: 5 }, { x: 10, y: 20 }])).toMatchObject({
      x: 0,
      y: 5,
      width: 10,
      height: 35,
    });
    expect(pointsToRect([])).toBeUndefined();
    expect(pointsToRect([{ x: Number.NaN, y: 1 }])).toBeUndefined();
    expect(boundsToRect([{ x: 1, y: 2 }, { x: 3, y: 2 }, { x: 3, y: 4 }, { x: 9, y: 8 }])).toMatchObject({
      x: 1,
      y: 2,
      width: 8,
      height: 6,
    });
  });

  it("uses x2/y2 when squaring or joining rects", () => {
    expect(
      squaredPoints([
        { x: 10, y: 20, x2: 30, y2: 40 },
        { x: 0, y: 25, x2: 50, y2: 60 },
      ]),
    ).toEqual([
      { x: 0, y: 20 },
      { x: 50, y: 20 },
      { x: 50, y: 60 },
      { x: 0, y: 60 },
    ]);
    expect(squaredPoints([])).toBeUndefined();

    // x2/y2 are the stored corners. The stale width must not win.
    const first = { ...makeRect(1, 2, 3, 4), x2: 20, y2: 30 };
    const second = makeRect(5, 6, 2, 2);
    expect(joinRects([first, second])).toMatchObject({
      x: 1,
      y: 2,
      width: 19,
      height: 28,
    });
    expect(joinRects([])).toBeUndefined();
  });

  it("centers a size and compares with tolerance", () => {
    expect(centerToRect({ x: 10, y: 20 }, 4)).toMatchObject({
      x: 8,
      y: 18,
      width: 4,
      height: 4,
    });
    expect(centerToRect({ x: 10, y: 20 }, 6, 2)).toMatchObject({
      x: 7,
      y: 19,
      width: 6,
      height: 2,
    });
    expect(rectClose(makeRect(1, 2, 3, 4), makeRect(1.0005, 2, 3, 4))).toBe(true);
    expect(rectClose(makeRect(1, 2, 3, 4), makeRect(1.002, 2, 3, 4))).toBe(false);
  });
});

describe("rect predicates and clipping", () => {
  const base = makeRect(0, 0, 10, 10);

  it("detects overlap including the shared edge", () => {
    expect(overlapsRects(base, makeRect(10, 2, 4, 4))).toBe(true);
    expect(overlapsRects(base, makeRect(11, 2, 4, 4))).toBe(false);
    expect(overlapsRects(base, makeRect(2, 10, 4, 4))).toBe(true);
  });

  it("contains points and rects against their stored corners", () => {
    expect(containsPoint(base, { x: 0, y: 10 })).toBe(true);
    expect(containsPoint(base, { x: 10.1, y: 5 })).toBe(false);
    expect(containsRect(base, makeRect(2, 2, 4, 4))).toBe(true);
    expect(containsRect(base, makeRect(2, 2, 9, 4))).toBe(false);
  });

  it("normalizes corners, clips and fixes the aspect ratio", () => {
    expect(cornersToRect(10, 20, 2, 5)).toMatchObject({
      x: 2,
      y: 5,
      width: 8,
      height: 15,
    });
    expect(cornersToRect({ x: 10, y: 20 }, { x: 2, y: 5 })).toMatchObject({
      x: 2,
      y: 5,
      width: 8,
      height: 15,
    });
    expect(clipRect(makeRect(-5, -5, 30, 30), makeRect(0, 0, 10, 10))).toMatchObject({
      x: 0,
      y: 0,
      width: 10,
      height: 10,
    });
    expect(
      fixAspectRatio(makeRect(0, 0, 20, 10), 1),
    ).toMatchObject({ x: 0, y: -5, width: 20, height: 20 });
    expect(
      fixAspectRatio(makeRect(0, 0, 10, 20), 1),
    ).toMatchObject({ x: -5, y: 0, width: 20, height: 20 });
    const unchanged = makeRect(0, 0, 10, 10);
    expect(fixAspectRatio(unchanged, null)).toBe(unchanged);
  });
});
