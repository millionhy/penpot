import { describe, expect, it } from "vitest";

import { PathData } from "@/lib/transit";
import { createLineShape, lineEndPoint, snapToAngle } from "@/lib/workspace-line";

const point = (x: number, y: number) => ({ x, y });

describe("snapToAngle", () => {
  it("keeps an end point that already sits on a 15-degree step", () => {
    const snapped = snapToAngle(point(0, 0), point(10, 0));
    expect(snapped.x).toBeCloseTo(10, 10);
    expect(snapped.y).toBeCloseTo(0, 10);
  });

  it("rounds a 40-degree drag to 45 degrees", () => {
    const origin = point(0, 0);
    const target = point(10 * Math.cos(Math.PI / 4.5), 10 * Math.sin(Math.PI / 4.5));
    const snapped = snapToAngle(origin, target);
    const angle = Math.atan2(snapped.y, snapped.x);
    expect((angle * 180) / Math.PI).toBeCloseTo(45, 6);
  });

  it("keeps the radius of the raw point", () => {
    const origin = point(100, 100);
    const snapped = snapToAngle(origin, point(130, 104));
    const radius = Math.hypot(snapped.x - origin.x, snapped.y - origin.y);
    expect(radius).toBeCloseTo(Math.hypot(30, 4), 10);
  });

  it("takes the step as a parameter, like snap-step-deg", () => {
    const snapped = snapToAngle(point(0, 0), point(10, 3), 90);
    expect(snapped.x).toBeCloseTo(Math.hypot(10, 3), 10);
    expect(snapped.y).toBeCloseTo(0, 10);
  });

  it("keeps a zero radius at the origin", () => {
    expect(snapToAngle(point(5, 5), point(5, 5))).toEqual({ x: 5, y: 5 });
  });
});

describe("lineEndPoint", () => {
  it("answers null under the 10-screen-pixel threshold", () => {
    expect(lineEndPoint(point(0, 0), point(9, 0), 1, false)).toBeNull();
    expect(lineEndPoint(point(0, 0), point(0, 10), 1, false)).toBeNull();
  });

  it("answers the raw point past the threshold", () => {
    expect(lineEndPoint(point(0, 0), point(11, 6), 1, false)).toEqual({ x: 11, y: 6 });
  });

  it("scales the threshold with the zoom", () => {
    // 6 world units at zoom 0.5 are 3 screen pixels: still under.
    expect(lineEndPoint(point(0, 0), point(6, 0), 0.5, false)).toBeNull();
    // and at zoom 2 they are 12: past.
    expect(lineEndPoint(point(0, 0), point(6, 0), 2, false)).toEqual({ x: 6, y: 0 });
  });

  it("snaps the end point when Shift is held", () => {
    const end = lineEndPoint(point(0, 0), point(20, 1), 1, true);
    expect(end).not.toBeNull();
    expect(end?.x).toBeCloseTo(Math.hypot(20, 1), 10);
    expect(end?.y).toBeCloseTo(0, 10);
  });

  it("does not snap when Shift is not held", () => {
    expect(lineEndPoint(point(0, 0), point(20, 1), 1, false)).toEqual({ x: 20, y: 1 });
  });
});

describe("createLineShape", () => {
  it("answers null for a zero-length drag, like finalize", () => {
    expect(createLineShape(point(5, 5), point(5, 5), "parent", "shape")).toBeNull();
  });

  it("answers null when a coordinate is not finite", () => {
    expect(
      createLineShape(point(0, 0), point(Number.NaN, 3), "parent", "shape"),
    ).toBeNull();
  });

  it("builds the two-node path of setup-path and minimal-path-attrs", () => {
    const shape = createLineShape(point(10, 20), point(40, 60), "parent", "shape");
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

  it("packs the two points as a move-to and one line-to", () => {
    const shape = createLineShape(point(0, 0), point(30, 40), "parent", "shape");
    const content = shape?.content as PathData;
    expect(content).toBeInstanceOf(PathData);
    expect(content.count).toBe(2);
    expect(content.toSegments()).toEqual([
      { command: "move-to", params: { x: 0, y: 0 } },
      { command: "line-to", params: { x: 30, y: 40 } },
    ]);
  });

  it("keeps a horizontal line inside the grc/make-rect floor", () => {
    const shape = createLineShape(point(0, 5), point(100, 5), "parent", "shape");
    expect(shape).toMatchObject({ x: 0, y: 5, width: 100, height: 0.01 });
  });

  it("adds the triangular cap only to the arrow variant", () => {
    const line = createLineShape(point(0, 0), point(10, 10), "parent", "shape");
    const arrow = createLineShape(point(0, 0), point(10, 10), "parent", "shape", true);
    expect(line?.strokes).toEqual([
      {
        "stroke-style": "solid",
        "stroke-alignment": "center",
        "stroke-width": 1,
        "stroke-color": "#000000",
        "stroke-opacity": 1,
      },
    ]);
    expect(arrow?.strokes).toEqual([
      {
        "stroke-style": "solid",
        "stroke-alignment": "center",
        "stroke-width": 1,
        "stroke-color": "#000000",
        "stroke-opacity": 1,
        "stroke-cap-end": "triangle-arrow",
      },
    ]);
  });
});
