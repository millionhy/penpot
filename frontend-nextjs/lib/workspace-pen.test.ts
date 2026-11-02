import { describe, expect, it } from "vitest";

import { PathData } from "@/lib/transit";
import {
  PEN_CLOSE_THRESHOLD,
  PEN_INSERT_THRESHOLD,
  cleanPenNodes,
  createPenShape,
  penFixedAngle,
  penNode,
  penPreviewPath,
  penPreviewSegments,
  penSegments,
  withDragHandle,
} from "@/lib/workspace-pen";

const point = (x: number, y: number) => ({ x, y });

describe("penNode and withDragHandle", () => {
  it("starts as a corner with no handles", () => {
    expect(penNode(point(1, 2))).toEqual({ point: point(1, 2), in: null, out: null });
  });

  it("mirrors the drag point into the incoming handle", () => {
    const node = withDragHandle(penNode(point(10, 10)), point(20, 10));
    expect(node.out).toEqual(point(20, 10));
    expect(node.in).toEqual(point(0, 10));
  });
});

describe("penFixedAngle", () => {
  it("keeps the radius and snaps to the nearest 15 degrees", () => {
    const snapped = penFixedAngle(point(0, 0), point(10, 1));
    expect(snapped.y).toBeCloseTo(0, 6);
    expect(snapped.x).toBeCloseTo(Math.hypot(10, 1), 6);
  });

  it("leaves a zero-length drag alone", () => {
    expect(penFixedAngle(point(3, 4), point(3, 4))).toEqual(point(3, 4));
  });
});

describe("cleanPenNodes", () => {
  it("drops a node that repeats its predecessor", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(0, 0)), penNode(point(10, 0))];
    expect(cleanPenNodes(nodes, false).map((node) => node.point)).toEqual([
      point(0, 0),
      point(10, 0),
    ]);
  });

  it("drops the trailing repeat of the first node of a closed draft", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0)), penNode(point(0, 0))];
    expect(cleanPenNodes(nodes, true)).toHaveLength(2);
  });

  it("keeps a closed draft of two distinct nodes", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 10))];
    expect(cleanPenNodes(nodes, true)).toHaveLength(2);
  });
});

describe("penSegments", () => {
  it("emits a move-to and one line-to per corner", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0)), penNode(point(10, 10))];
    expect(penSegments(nodes, false)).toEqual([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "line-to", x: 10, y: 10 },
    ]);
  });

  it("emits a curve-to when the previous node carries an outgoing handle", () => {
    const first = withDragHandle(penNode(point(0, 0)), point(5, 5));
    const nodes = [first, penNode(point(10, 0))];
    expect(penSegments(nodes, false)).toEqual([
      { command: "move-to", x: 0, y: 0 },
      {
        command: "curve-to",
        x: 10,
        y: 0,
        c1x: 5,
        c1y: 5,
        c2x: 10,
        c2y: 0,
      },
    ]);
  });

  it("uses the incoming handle of the target node as the second control point", () => {
    const second = withDragHandle(penNode(point(10, 0)), point(15, 5));
    const nodes = [penNode(point(0, 0)), second];
    const segments = penSegments(nodes, false);
    expect(segments[1]).toMatchObject({ command: "curve-to", c2x: 5, c2y: -5 });
  });

  it("closes the draft back to the first node then emits close-path", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0)), penNode(point(10, 10))];
    expect(penSegments(nodes, true)).toEqual([
      { command: "move-to", x: 0, y: 0 },
      { command: "line-to", x: 10, y: 0 },
      { command: "line-to", x: 10, y: 10 },
      { command: "line-to", x: 0, y: 0 },
      { command: "close-path" },
    ]);
  });

  it("answers an empty list for an empty draft", () => {
    expect(penSegments([], false)).toEqual([]);
  });
});

describe("penPreviewSegments", () => {
  it("adds the rubber band from the last node to the cursor", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0))];
    const segments = penPreviewSegments(nodes, point(20, 5));
    expect(segments[segments.length - 1]).toEqual({ command: "line-to", x: 20, y: 5 });
  });

  it("keeps the committed segments and skips a cursor on the node", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0))];
    expect(penPreviewSegments(nodes, null)).toHaveLength(2);
    expect(penPreviewSegments(nodes, point(10, 0))).toHaveLength(2);
  });

  it("draws the SVG path of the preview", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0))];
    expect(penPreviewPath(nodes, point(10, 10))).toBe("M0,0L10,0L10,10");
  });
});

describe("createPenShape", () => {
  it("builds a path with a centered stroke and no fill", () => {
    const shape = createPenShape(
      { nodes: [penNode(point(0, 0)), penNode(point(10, 0)), penNode(point(10, 10))], closed: false },
      "parent",
      "shape",
    );
    expect(shape).not.toBeNull();
    expect(shape?.type).toBe("path");
    expect(shape?.strokes).toEqual([
      {
        "stroke-style": "solid",
        "stroke-alignment": "center",
        "stroke-width": 1,
        "stroke-color": "#000000",
        "stroke-opacity": 1,
      },
    ]);
    expect(shape?.fills).toEqual([]);
    expect(shape?.selrect).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(shape?.content).toBeInstanceOf(PathData);
    expect((shape?.content as PathData).toSegments().map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "line-to",
    ]);
  });

  it("widens the selrect to the curve extrema", () => {
    const first = withDragHandle(penNode(point(0, 0)), point(0, -20));
    const shape = createPenShape(
      { nodes: [first, penNode(point(10, 0))], closed: false },
      "parent",
      "shape",
    );
    expect(shape?.selrect).toMatchObject({ y: expect.any(Number), height: expect.any(Number) });
    const selrect = shape?.selrect as { y: number; height: number };
    // The handle sits at -20, the curve turns at t = 1/3 and reaches
    // -80/9 (segment/content->selrect samples the curve, not the handle).
    expect(selrect.y).toBeCloseTo(-80 / 9, 5);
    expect(selrect.height).toBeCloseTo(80 / 9, 5);
  });

  it("merges the repeated node of a double-click finish", () => {
    const nodes = [penNode(point(0, 0)), penNode(point(10, 0)), penNode(point(10, 0))];
    const shape = createPenShape({ nodes, closed: false }, "parent", "shape");
    expect((shape?.content as PathData).toSegments()).toHaveLength(2);
  });

  it("answers null below two nodes", () => {
    expect(createPenShape({ nodes: [penNode(point(0, 0))], closed: false }, "p", "s")).toBeNull();
    expect(createPenShape({ nodes: [], closed: false }, "p", "s")).toBeNull();
  });

  it("packs a closed draft with the closing segment and close-path", () => {
    const shape = createPenShape(
      {
        nodes: [penNode(point(0, 0)), penNode(point(10, 0)), penNode(point(10, 10))],
        closed: true,
      },
      "parent",
      "shape",
    );
    expect((shape?.content as PathData).toSegments().map((segment) => segment.command)).toEqual([
      "move-to",
      "line-to",
      "line-to",
      "line-to",
      "close-path",
    ]);
  });

  it("exposes the screen thresholds of drawing.cljs", () => {
    expect(PEN_INSERT_THRESHOLD).toBe(16);
    expect(PEN_CLOSE_THRESHOLD).toBe(12);
  });
});
