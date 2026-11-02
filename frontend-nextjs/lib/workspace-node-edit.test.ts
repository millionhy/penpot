import { describe, expect, it } from "vitest";

import { PathData } from "@/lib/transit";
import {
  buildNodeEditChange,
  contentFromNodes,
  deleteNode,
  hitHandle,
  hitNode,
  isEditablePath,
  moveHandle,
  moveNode,
  nodesToSegments,
  pathEditNodes,
} from "@/lib/workspace-node-edit";
import type { WorkspaceShape } from "@/lib/workspace";

const point = (x: number, y: number) => ({ x, y });

// A 10 x 10 square, the shape the pen tool commits.
function square(): PathData {
  return PathData.fromSegments([
    { command: "move-to", x: 0, y: 0 },
    { command: "line-to", x: 10, y: 0 },
    { command: "line-to", x: 10, y: 10 },
    { command: "line-to", x: 0, y: 10 },
  ]);
}

// The same square with an explicit closing segment, the closed draft.
function closedSquare(): PathData {
  return PathData.fromSegments([
    { command: "move-to", x: 0, y: 0 },
    { command: "line-to", x: 10, y: 0 },
    { command: "line-to", x: 10, y: 10 },
    { command: "line-to", x: 0, y: 10 },
    { command: "line-to", x: 0, y: 0 },
    { command: "close-path" },
  ]);
}

describe("pathEditNodes", () => {
  it("reads the anchors of an open path", () => {
    const nodes = pathEditNodes(square());
    expect(nodes.map((node) => node.point)).toEqual([
      point(0, 0),
      point(10, 0),
      point(10, 10),
      point(0, 10),
    ]);
    expect(nodes.every((node) => node.in === null && node.out === null)).toBe(true);
    expect(nodes[0].start).toBe(true);
    expect(nodes.some((node) => node.close)).toBe(false);
  });

  it("folds the explicit closing segment into the first anchor", () => {
    const nodes = pathEditNodes(closedSquare());
    expect(nodes).toHaveLength(4);
    expect(nodes[0].close).toBe(true);
  });

  it("keeps the handles of a curve on the anchors around it", () => {
    const content = PathData.fromSegments([
      { command: "move-to", x: 0, y: 0 },
      { command: "curve-to", c1x: 0, c1y: -10, c2x: 10, c2y: -10, x: 10, y: 0 },
      { command: "line-to", x: 10, y: 10 },
    ]);
    const nodes = pathEditNodes(content);
    expect(nodes).toHaveLength(3);
    expect(nodes[0].out).toEqual(point(0, -10));
    expect(nodes[1].in).toEqual(point(10, -10));
    expect(nodes[1].out).toBeNull();
  });

  it("starts a new subpath on every move-to", () => {
    const content = PathData.fromSegments([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "move-to", x: 20, y: 20 },
      { command: "line-to", x: 30, y: 20 },
    ]);
    const nodes = pathEditNodes(content);
    expect(nodes.map((node) => node.start)).toEqual([true, false, true, false]);
    expect(nodesToSegments(nodes).map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "move-to",
      "line-to",
    ]);
  });
});

describe("nodesToSegments", () => {
  it("round trips an open path", () => {
    const nodes = pathEditNodes(square());
    expect(nodesToSegments(nodes).map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "line-to",
      "line-to",
    ]);
  });

  it("round trips a closed path without duplicating the closing point", () => {
    const nodes = pathEditNodes(closedSquare());
    const segments = nodesToSegments(nodes);
    expect(segments.map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "line-to",
      "line-to",
      "close-path",
    ]);
    expect(pathEditNodes(contentFromNodes(nodes))).toHaveLength(4);
  });

  it("keeps the curved close of a closed draft", () => {
    const nodes = pathEditNodes(closedSquare());
    // A handle on the last anchor turns the closing edge into a curve.
    const curved = nodes.map((node, index) =>
      index === 3 ? { ...node, out: point(0, 20) } : node,
    );
    const segments = nodesToSegments(curved);
    const commands = segments.map((segment) => segment.command);
    expect(commands[commands.length - 2]).toBe("curve-to");
    expect(commands[commands.length - 1]).toBe("close-path");
    expect(pathEditNodes(contentFromNodes(curved))).toHaveLength(4);
  });

  it("uses a curve when only one side of the segment has a handle", () => {
    const nodes = pathEditNodes(square());
    nodes[0] = { ...nodes[0], out: point(0, -10) };
    const segments = nodesToSegments(nodes);
    expect(segments[1]).toMatchObject({
      command: "curve-to",
      c1x: 0,
      c1y: -10,
      c2x: 10,
      c2y: 0,
    });
  });
});

describe("moveNode", () => {
  it("moves the anchor and its handles together", () => {
    const nodes = pathEditNodes(square());
    nodes[1] = { ...nodes[1], in: point(10, -5), out: point(10, 5) };
    const moved = moveNode(nodes, 1, 5, 5);
    expect(moved[1].point).toEqual(point(15, 5));
    expect(moved[1].in).toEqual(point(15, 0));
    expect(moved[1].out).toEqual(point(15, 10));
    expect(moved[0]).toBe(nodes[0]);
  });
});

describe("moveHandle", () => {
  const nodes = pathEditNodes(square());

  it("mirrors the opposite handle around the anchor", () => {
    const moved = moveHandle(nodes, 1, "out", point(20, 0), true);
    expect(moved[1].out).toEqual(point(20, 0));
    expect(moved[1].in).toEqual(point(0, 0));
  });

  it("leaves the opposite handle alone without mirroring", () => {
    const withIn = moveHandle(nodes, 1, "in", point(10, -5), false);
    const moved = moveHandle(withIn, 1, "out", point(20, 0), false);
    expect(moved[1].in).toEqual(point(10, -5));
    expect(moved[1].out).toEqual(point(20, 0));
  });
});

describe("deleteNode", () => {
  it("drops one anchor of an open path", () => {
    const nodes = pathEditNodes(square());
    expect(deleteNode(nodes, 1)).toHaveLength(3);
  });

  it("drops a subpath that cannot form a segment anymore", () => {
    const nodes = pathEditNodes(square());
    expect(deleteNode(nodes, 0).map((node) => node.start)).toEqual([false, false, false]);
    const two = pathEditNodes(
      PathData.fromSegments([
        { command: "move-to", x: 0, y: 0 },
        { command: "line-to", x: 10, y: 0 },
      ]),
    );
    expect(deleteNode(two, 1)).toEqual([]);
  });
});

describe("hit tests", () => {
  const nodes = pathEditNodes(square());

  it("finds the anchor under the pointer within the screen radius", () => {
    expect(hitNode(nodes, point(10.5, 0.5), 1)).toBe(1);
    expect(hitNode(nodes, point(10.5, 0.5), 20)).toBe(-1);
    expect(hitNode(nodes, point(5, 5), 1)).toBe(-1);
  });

  it("finds the nearest handle", () => {
    nodes[1] = { ...nodes[1], out: point(10, 5) };
    expect(hitHandle(nodes, point(10, 5.5), 1)).toEqual({ index: 1, kind: "out" });
    expect(hitHandle(nodes, point(10, 20), 1)).toBeNull();
  });
});

describe("isEditablePath", () => {
  it("accepts a path with packed content only", () => {
    expect(isEditablePath({ id: "a", type: "path", content: square() })).toBe(true);
    expect(isEditablePath({ id: "a", type: "bool", content: square() })).toBe(false);
    expect(isEditablePath({ id: "a", type: "path", content: "M0,0" })).toBe(false);
  });
});

describe("buildNodeEditChange", () => {
  const shape: WorkspaceShape = { id: "shape", type: "path", "parent-id": "page" };

  it("carries the content and the new box", () => {
    const nodes = pathEditNodes(square());
    const change = buildNodeEditChange(shape, moveNode(nodes, 2, 5, 5), "page");
    expect(change).toMatchObject({ type: "mod-obj", "page-id": "page", id: "shape" });
    const operations = change && "operations" in change ? change.operations : [];
    const byAttr = new Map(operations.map((operation) => [operation.attr, operation.val]));
    expect(byAttr.get("x")).toBe(0);
    expect(byAttr.get("y")).toBe(0);
    expect(byAttr.get("width")).toBe(15);
    expect(byAttr.get("height")).toBe(15);
    expect(byAttr.get("content")).toBeInstanceOf(PathData);
    expect(byAttr.get("selrect")).toMatchObject({ x: 0, y: 0, width: 15, height: 15 });
    expect(Array.isArray(byAttr.get("points"))).toBe(true);
  });

  it("answers null below two anchors", () => {
    const nodes = pathEditNodes(square()).slice(0, 1);
    expect(buildNodeEditChange(shape, nodes, "page")).toBeNull();
    expect(buildNodeEditChange(shape, [], "page")).toBeNull();
  });
});
