import { describe, expect, it } from "vitest";
import { PathData, type PathSegmentSpec } from "@/lib/transit";
import { pathSegments, shapeWithOpenPath } from "./path";

function content(segments: PathSegmentSpec[]): PathData {
  return PathData.fromSegments(segments);
}

const triangle: PathSegmentSpec[] = [
  { command: "move-to", x: 0, y: 0 },
  { command: "line-to", x: 10, y: 0 },
  { command: "line-to", x: 10, y: 10 },
  { command: "close-path" },
];

describe("pathSegments", () => {
  it("reads a decoded PathData stream", () => {
    expect(pathSegments(content(triangle)).map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "line-to",
      "close-path",
    ]);
  });

  it("reads the packed bytes and an already unpacked list", () => {
    const packed = content(triangle);
    expect(pathSegments(packed.bytes)).toHaveLength(4);
    expect(pathSegments(packed.toSegments())).toHaveLength(4);
  });

  it("answers an empty list for missing content", () => {
    expect(pathSegments(undefined)).toEqual([]);
    expect(pathSegments(null)).toEqual([]);
    expect(pathSegments({})).toEqual([]);
  });
});

describe("shapeWithOpenPath", () => {
  it("treats a closed subpath as closed", () => {
    expect(shapeWithOpenPath({ type: "path", content: content(triangle) })).toBe(false);
  });

  it("accepts a subpath that returns to its start without close-path", () => {
    const shape = content([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "line-to", x: 0, y: 0 },
    ]);
    expect(shapeWithOpenPath({ type: "path", content: shape })).toBe(false);
  });

  it("reports a polyline as open", () => {
    const shape = content([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "line-to", x: 10, y: 10 },
    ]);
    expect(shapeWithOpenPath({ type: "path", content: shape })).toBe(true);
  });

  it("closes a loop split across subpaths unless the shape has svg-attrs", () => {
    const loop: PathSegmentSpec[] = [
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "move-to", x: 10, y: 0 },
      { command: "line-to", x: 10, y: 10 },
      { command: "move-to", x: 10, y: 10 },
      { command: "line-to", x: 0, y: 0 },
    ];
    // close-subpaths joins the three touching subpaths into one loop.
    expect(shapeWithOpenPath({ type: "path", content: content(loop) })).toBe(false);
    // An imported svg keeps its subpaths untouched (contains? :svg-attrs).
    expect(shapeWithOpenPath({ type: "path", content: content(loop), "svg-attrs": null })).toBe(
      true,
    );
  });

  it("is false for every other shape type", () => {
    expect(shapeWithOpenPath({ type: "rect", content: content(triangle) })).toBe(false);
    expect(shapeWithOpenPath({ type: "bool", content: content(triangle) })).toBe(false);
  });

  it("counts empty content as closed", () => {
    expect(shapeWithOpenPath({ type: "path", content: null })).toBe(false);
  });
});
