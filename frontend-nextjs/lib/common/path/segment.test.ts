import { describe, expect, it } from "vitest";
import { PathData } from "@/lib/transit";
import {
  commandToBezier,
  commandToLine,
  commandToSelrect,
  contentCenter,
  contentToSelrect,
  curveExtremities,
  curveValues,
  isPointInGeomData,
  lineLineIntersect,
  makeCurveTo,
  makeLineTo,
  makeMoveTo,
  pathSegments,
  pointsToSegments,
  segmentToPoint,
  type GeomData,
  type PathSegment,
} from "./segment";

const p = (x: number, y: number) => ({ x, y });

describe("segment conversion", () => {
  it("makes a move-to followed by line-to commands", () => {
    expect(pointsToSegments([p(1, 2), p(3, 4)], { close: true })).toEqual([
      { command: "move-to", params: { x: 1, y: 2 } },
      { command: "line-to", params: { x: 3, y: 4 } },
      { command: "close-path", params: {} },
    ]);
    expect(pointsToSegments([])).toEqual([]);
  });

  it("reads endpoints and handles from params", () => {
    const curve = makeCurveTo(p(10, 20), p(2, 3), p(8, 9));
    expect(segmentToPoint(curve)).toEqual(p(10, 20));
    expect(segmentToPoint(curve, "c1")).toEqual(p(2, 3));
    expect(segmentToPoint(curve, "c2")).toEqual(p(8, 9));
    expect(segmentToPoint({ command: "close-path", params: {} })).toBeNull();
  });

  it("turns commands into line and bezier tuples", () => {
    const line = makeLineTo(p(10, 20));
    expect(commandToLine(line, p(0, 0))).toEqual([p(0, 0), p(10, 20)]);
    expect(commandToLine(line)).toBeNull();
    const curve = makeCurveTo(p(10, 0), p(2, 4), p(8, 4));
    expect(commandToBezier(curve, p(0, 0))).toEqual([
      p(0, 0),
      p(10, 0),
      p(2, 4),
      p(8, 4),
    ]);
  });

  it("reads decoded, plain and packed content", () => {
    const data = PathData.fromSegments([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "close-path" },
    ]);
    expect(pathSegments(data).map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "close-path",
    ]);
    expect(pathSegments(data.bytes)).toHaveLength(3);
    expect(pathSegments(undefined)).toEqual([]);
  });
});

describe("segment bounds", () => {
  it("measures line and move-to commands", () => {
    expect(commandToSelrect(makeMoveTo(p(5, 6)))).toMatchObject({
      x: 5,
      y: 6,
      width: 0.01,
      height: 0.01,
    });
    expect(commandToSelrect(makeLineTo(p(10, 20)), p(2, 4))).toMatchObject({
      x: 2,
      y: 4,
      width: 8,
      height: 16,
    });
  });

  it("includes cubic extrema but not the handles themselves", () => {
    const curve = makeCurveTo(p(10, 0), p(0, 20), p(10, 20));
    expect(curveExtremities([p(0, 0), p(10, 0), p(0, 20), p(10, 20)])).toContain(0.5);
    expect(curveValues([p(0, 0), p(10, 0), p(0, 20), p(10, 20)], 0.5)).toEqual(p(5, 15));
    expect(commandToSelrect(curve, p(0, 0))).toMatchObject({
      x: 0,
      y: 0,
      width: 10,
      height: 15,
    });
  });

  it("bounds the whole content and returns its center", () => {
    const content: PathSegment[] = [
      makeMoveTo(p(0, 0)),
      makeCurveTo(p(10, 0), p(0, 20), p(10, 20)),
    ];
    expect(contentToSelrect(content)).toMatchObject({
      x: 0,
      y: 0,
      width: 10,
      height: 15,
    });
    expect(contentCenter(content)).toEqual(p(5, 7.5));
    expect(contentToSelrect([])).toMatchObject({ x: 0, y: 0, width: 0.01, height: 0.01 });
  });
});

describe("path intersections", () => {
  it("finds a segment crossing", () => {
    expect(
      lineLineIntersect([p(0, 0), p(10, 10)], [p(0, 10), p(10, 0)]),
    ).toEqual([[0.5], [0.5]]);
    expect(
      lineLineIntersect([p(0, 0), p(2, 0)], [p(3, 0), p(5, 0)]),
    ).toBeNull();
  });

  it("tests a point inside a closed polyline", () => {
    const square: GeomData[] = [
      { command: "line-to", geom: [p(0, 0), p(10, 0)], selrect: commandToSelrect(makeLineTo(p(10, 0)), p(0, 0)) },
      { command: "line-to", geom: [p(10, 0), p(10, 10)], selrect: commandToSelrect(makeLineTo(p(10, 10)), p(10, 0)) },
      { command: "line-to", geom: [p(10, 10), p(0, 10)], selrect: commandToSelrect(makeLineTo(p(0, 10)), p(10, 10)) },
      { command: "line-to", geom: [p(0, 10), p(0, 0)], selrect: commandToSelrect(makeLineTo(p(0, 0)), p(0, 10)) },
    ];
    expect(isPointInGeomData(p(5, 5), square)).toBe(true);
    expect(isPointInGeomData(p(15, 5), square)).toBe(false);
  });
});
