// Unit tests for the thumbnail geometry (lib/thumbnail), the pure part of the
// F9.14 thumbnail worker. The values come from the CLJS originals:
// common geom/rect.cljc fix-aspect-ratio and update-rect :position, and
// app.main.render/calculate-dimensions.

import { describe, expect, it } from "vitest";

import {
  calculateDimensions,
  fixAspectRatio,
  joinRects,
  normalizeRect,
  THUMBNAIL_ASPECT_RATIO,
  THUMBNAIL_WIDTH,
  thumbnailHeight,
} from "@/lib/thumbnail";

describe("thumbnail box", () => {
  it("is 252 wide with a 2:3 height, like the reference worker", () => {
    expect(THUMBNAIL_WIDTH).toBe(252);
    expect(THUMBNAIL_ASPECT_RATIO).toBeCloseTo(2 / 3);
    expect(thumbnailHeight()).toBe(168);
    expect(thumbnailHeight(300)).toBe(200);
  });
});

describe("normalizeRect", () => {
  it("rebuilds a rect that grew left/up as a positive size at the corner", () => {
    expect(normalizeRect({ x: 100, y: 100, width: -40, height: -20 })).toEqual({
      x: 60,
      y: 80,
      width: 40,
      height: 20,
    });
  });

  it("keeps a normal rect unchanged", () => {
    expect(normalizeRect({ x: 10, y: 20, width: 30, height: 40 })).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
    });
  });
});

describe("fixAspectRatio", () => {
  it("grows the height and re-centers when the rect is too wide", () => {
    expect(fixAspectRatio({ x: 0, y: 0, width: 300, height: 100 })).toEqual({
      x: 0,
      y: -50,
      width: 300,
      height: 200,
    });
  });

  it("grows the width and re-centers when the rect is too tall", () => {
    const rect = fixAspectRatio({ x: 0, y: 0, width: 100, height: 300 });
    expect(rect.x).toBe(-175);
    expect(rect.y).toBe(0);
    expect(rect.width).toBeCloseTo(450);
    expect(rect.height).toBe(300);
  });

  it("leaves an exact-ratio rect untouched", () => {
    const source = { x: 5, y: 6, width: 300, height: 200 };
    expect(fixAspectRatio(source)).toBe(source);
  });
});

describe("joinRects", () => {
  it("covers every rect", () => {
    expect(
      joinRects([
        { x: 10, y: 20, width: 100, height: 100 },
        { x: 200, y: 50, width: 100, height: 100 },
      ]),
    ).toEqual({ x: 10, y: 20, width: 290, height: 130 });
  });

  it("answers null without rects", () => {
    expect(joinRects([])).toBeNull();
  });

  it("answers null when a corner is not finite", () => {
    expect(joinRects([{ x: Number.NaN, y: 0, width: 10, height: 10 }])).toBeNull();
  });
});

describe("calculateDimensions", () => {
  it("falls back to the 100x100 rect of an empty page", () => {
    expect(calculateDimensions([])).toEqual({ x: -25, y: 0, width: 150, height: 100 });
  });

  it("joins the root bounds, then fixes the ratio", () => {
    const rect = calculateDimensions([{ x: 10, y: 20, width: 290, height: 130 }]);
    expect(rect.width).toBe(290);
    expect(rect.height).toBeCloseTo(193.333, 2);
    expect(rect.y).toBeCloseTo(-11.667, 2);
  });

  it("rejects an export area beyond the maximum dimension", () => {
    expect(() =>
      calculateDimensions([{ x: 0, y: 0, width: 100001, height: 100 }]),
    ).toThrow(/too large/);
  });
});