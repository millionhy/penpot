import { describe, expect, it } from "vitest";

import { PathData } from "@/lib/transit";
import {
  CURVE_SIMPLIFY_TOLERANCE,
  createCurveShape,
  pathSegmentsFromPoints,
  pointsRect,
  simplifyPoints,
} from "@/lib/workspace-path";

const point = (x: number, y: number) => ({ x, y });

describe("simplifyPoints", () => {
  it("passes two points through untouched", () => {
    const points = [point(0, 0), point(10, 10)];
    expect(simplifyPoints(points)).toEqual(points);
  });

  it("copies the input, so the caller's array stays mutable data", () => {
    const points = [point(0, 0), point(1, 1)];
    const simplified = simplifyPoints(points);
    expect(simplified).not.toBe(points);
  });

  it("collapses collinear points to the two ends", () => {
    const points = [point(0, 0), point(5, 0), point(10, 0), point(20, 0)];
    expect(simplifyPoints(points)).toEqual([point(0, 0), point(20, 0)]);
  });

  it("keeps a point that sits far off the segment", () => {
    const points = [point(0, 0), point(10, 20), point(20, 0)];
    expect(simplifyPoints(points)).toEqual(points);
  });

  it("drops a point that sits inside the tolerance", () => {
    const points = [point(0, 0), point(10, 0.01), point(20, 0)];
    expect(simplifyPoints(points)).toEqual([point(0, 0), point(20, 0)]);
  });

  it("scales the tolerance: a wider one drops the same point", () => {
    const points = [point(0, 0), point(10, 5), point(20, 0)];
    expect(simplifyPoints(points).length).toBe(3);
    expect(simplifyPoints(points, 10)).toEqual([point(0, 0), point(20, 0)]);
  });

  it("uses the curve tolerance of drawing/curve.cljs by default", () => {
    expect(CURVE_SIMPLIFY_TOLERANCE).toBe(0.3);
  });
});

describe("pathSegmentsFromPoints", () => {
  it("starts with a move-to and continues with line-to", () => {
    expect(pathSegmentsFromPoints([point(1, 2), point(3, 4), point(5, 6)])).toEqual([
      { command: "move-to", x: 1, y: 2 },
      { command: "line-to", x: 3, y: 4 },
      { command: "line-to", x: 5, y: 6 },
    ]);
  });

  it("answers an empty list for no points", () => {
    expect(pathSegmentsFromPoints([])).toEqual([]);
  });
});

describe("pointsRect", () => {
  it("wraps the points in their bounding box", () => {
    expect(pointsRect([point(10, 20), point(0, 5), point(4, 40)])).toEqual({
      x: 0,
      y: 5,
      width: 10,
      height: 35,
    });
  });

  it("clamps a zero side to the grc/make-rect floor", () => {
    expect(pointsRect([point(3, 4), point(3, 9)])).toEqual({
      x: 3,
      y: 4,
      width: 0.01,
      height: 5,
    });
  });

  it("answers null for no points", () => {
    expect(pointsRect([])).toBeNull();
  });

  it("answers null when a coordinate is not finite", () => {
    expect(pointsRect([point(0, 0), point(Number.NaN, 1)])).toBeNull();
    expect(pointsRect([point(0, 0), point(1, Number.POSITIVE_INFINITY)])).toBeNull();
  });
});

describe("createCurveShape", () => {
  it("answers null for a single point", () => {
    expect(createCurveShape([point(1, 2)], "parent", "shape")).toBeNull();
  });

  it("answers null when the points are not finite", () => {
    expect(
      createCurveShape([point(0, 0), point(Number.NaN, 3)], "parent", "shape"),
    ).toBeNull();
  });

  it("builds the path shape of setup-path and minimal-path-attrs", () => {
    const shape = createCurveShape([point(10, 20), point(40, 60)], "parent", "shape");
    expect(shape).not.toBeNull();
    expect(shape).toMatchObject({
      id: "shape",
      type: "path",
      name: "Path",
      "parent-id": "parent",
      "frame-id": "parent",
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      selrect: { x: 10, y: 20, width: 30, height: 40, x1: 10, y1: 20, x2: 40, y2: 60 },
      points: [
        { x: 10, y: 20 },
        { x: 40, y: 20 },
        { x: 40, y: 60 },
        { x: 10, y: 60 },
      ],
      transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      "transform-inverse": { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
      rotation: 0,
      proportion: 1,
      "proportion-lock": false,
      fills: [],
      strokes: [
        {
          "stroke-style": "solid",
          "stroke-alignment": "center",
          "stroke-width": 1,
          "stroke-color": "#000000",
          "stroke-opacity": 1,
        },
      ],
      "grow-type": "fixed",
    });
  });

  it("packs the simplified points as path content", () => {
    const shape = createCurveShape(
      [point(0, 0), point(10, 0), point(20, 10)],
      "parent",
      "shape",
    );
    expect(shape).not.toBeNull();
    const content = shape?.content as PathData;
    expect(content).toBeInstanceOf(PathData);
    expect(content.count).toBe(3);
    expect(content.toSegments()).toEqual([
      { command: "move-to", params: { x: 0, y: 0 } },
      { command: "line-to", params: { x: 10, y: 0 } },
      { command: "line-to", params: { x: 20, y: 10 } },
    ]);
  });

  it("drops the inner points before packing the content", () => {
    const shape = createCurveShape(
      [point(0, 0), point(10, 0), point(20, 0)],
      "parent",
      "shape",
    );
    expect(shape).not.toBeNull();
    expect((shape?.content as PathData).count).toBe(2);
  });
});
