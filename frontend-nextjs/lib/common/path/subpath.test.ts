import { describe, expect, it } from "vitest";
import { PathData } from "@/lib/transit";
import {
  closeLoops,
  closeSubpaths,
  clockwise,
  getSubpaths,
  isClosed,
  mergeTouchingSubpaths,
  reverseContent,
  shapeWithOpenPath,
  type PathSegment,
} from "./index";

function segment(
  command: PathSegment["command"],
  x?: number,
  y?: number,
): PathSegment {
  return {
    command,
    params: command === "close-path" ? {} : { x: x ?? 0, y: y ?? 0 },
  };
}

const triangle: PathSegment[] = [
  segment("move-to", 0, 0),
  segment("line-to", 10, 0),
  segment("line-to", 10, 10),
  segment("close-path"),
];

describe("subpath extraction", () => {
  it("opens a subpath on move-to and extends the current one", () => {
    const subpaths = getSubpaths(triangle);
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0].from).toEqual({ x: 0, y: 0 });
    expect(subpaths[0].to).toEqual({ x: 0, y: 0 });
    expect(subpaths[0].data).toHaveLength(4);
    expect(isClosed(subpaths[0])).toBe(true);
  });

  it("joins a loop split across adjacent subpaths", () => {
    const split: PathSegment[] = [
      segment("move-to", 0, 0),
      segment("line-to", 10, 0),
      segment("move-to", 10, 0),
      segment("line-to", 10, 10),
      segment("move-to", 10, 10),
      segment("line-to", 0, 0),
    ];
    const closed = getSubpaths(closeSubpaths(split));
    expect(closed).toHaveLength(1);
    expect(isClosed(closed[0])).toBe(true);
  });

  it("keeps draw order when only adjacent touching subpaths merge", () => {
    const content: PathSegment[] = [
      segment("move-to", 0, 0),
      segment("line-to", 10, 0),
      segment("move-to", 10, 0),
      segment("line-to", 20, 0),
      segment("move-to", 50, 50),
      segment("line-to", 60, 50),
    ];
    const merged = getSubpaths(mergeTouchingSubpaths(content));
    expect(merged).toHaveLength(2);
    expect(merged[0].data).toHaveLength(3);
    expect(merged[1].from).toEqual({ x: 50, y: 50 });
  });
});

describe("subpath transforms", () => {
  it("reverses the command order and keeps the endpoints", () => {
    const open: PathSegment[] = [
      segment("move-to", 0, 0),
      segment("line-to", 10, 0),
      segment("line-to", 20, 10),
    ];
    const reversed = getSubpaths(reverseContent(open))[0];
    expect(reversed.from).toEqual({ x: 20, y: 10 });
    expect(reversed.to).toEqual({ x: 0, y: 0 });
    expect(reversed.data[1]).toEqual({ command: "line-to", params: { x: 10, y: 0 } });
  });

  it("adds close-path when a subpath returns to its start", () => {
    const loop = closeLoops([
      segment("move-to", 0, 0),
      segment("line-to", 10, 0),
      segment("line-to", 0, 0),
    ]);
    expect(loop[loop.length - 1].command).toBe("close-path");
  });

  it("reads the sign of the polygon area", () => {
    expect(clockwise(triangle)).toBe(true);
    expect(clockwise(reverseContent(triangle))).toBe(false);
  });
});

describe("shapeWithOpenPath", () => {
  const content = PathData.fromSegments([
    { command: "move-to", x: 0, y: 0 },
    { command: "line-to", x: 10, y: 0 },
    { command: "line-to", x: 10, y: 10 },
    { command: "close-path" },
  ]);

  it("reports closed paths as closed", () => {
    expect(shapeWithOpenPath({ type: "path", content })).toBe(false);
  });

  it("reports an unclosed polyline as open", () => {
    const open = PathData.fromSegments([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "line-to", x: 10, y: 10 },
    ]);
    expect(shapeWithOpenPath({ type: "path", content: open })).toBe(true);
  });

  it("leaves imported svg subpaths apart", () => {
    const split = PathData.fromSegments([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "move-to", x: 10, y: 0 },
      { command: "line-to", x: 0, y: 0 },
    ]);
    expect(shapeWithOpenPath({ type: "path", content: split })).toBe(false);
    expect(shapeWithOpenPath({ type: "path", content: split, "svg-attrs": null })).toBe(true);
  });
});
