// The constraint spread of lib/workspace-constraints.ts: the axis map of
// each constraint kind, the default constraints of a frame and a group
// child, the forced left/top of a layout parent and the matrix each
// descendant of a gesture root takes. The expectations mirror
// constraint-modifier and calc-child-modifiers of
// common/src/app/common/geom/shapes/constraints.cljc, evaluated on the
// axis-aligned case.

import { describe, expect, it } from "vitest";

import {
  acceptedSubtreeEntries,
  constraintAxisMap,
  constraintChildMatrix,
  gestureEntries,
  isConstraintContainer,
  type AxisMap,
} from "@/lib/workspace-constraints";
import { selrectOf } from "@/lib/workspace-geometry";
import { applyTransformToShape, type GeometryRect } from "@/lib/workspace-transform";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

const PAGE_RECT = (x: number, y: number, width: number, height: number): GeometryRect => ({
  x,
  y,
  width,
  height,
  x1: x,
  y1: y,
  x2: x + width,
  y2: y + height,
});

function shape(
  id: string,
  type: string,
  rect: GeometryRect,
  extra: Record<string, unknown> = {},
): WorkspaceShape {
  return {
    id,
    type,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    selrect: { ...rect },
    points: [
      { x: rect.x, y: rect.y },
      { x: rect.x2, y: rect.y },
      { x: rect.x2, y: rect.y2 },
      { x: rect.x, y: rect.y2 },
    ],
    rotation: 0,
    transform: { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    "transform-inverse": { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 },
    ...extra,
  };
}

function objectsOf(...shapes: WorkspaceShape[]): WorkspaceObjects {
  const objects: WorkspaceObjects = {};
  for (const item of shapes) objects[item.id] = item;
  return objects;
}

// The new rect of a shape under an axis map, applied like a commit does.
function mapRect(rect: GeometryRect, map: AxisMap): GeometryRect {
  return PAGE_RECT(
    rect.x * map.scale + map.offset,
    rect.y,
    rect.width * map.scale,
    rect.height,
  );
}

describe("constraintAxisMap", () => {
  // A frame growing from 100 wide to 200, its left edge fixed.
  const before = PAGE_RECT(0, 0, 100, 100);
  const after = PAGE_RECT(0, 0, 200, 100);

  it("left keeps the start offset of a child", () => {
    const map = constraintAxisMap("left", "x", before, after, 20, 30);
    expect(map).toEqual({ scale: 1, offset: 0 });
    expect(mapRect(PAGE_RECT(20, 0, 30, 10), map!).x).toBe(20);
  });

  it("right keeps the end offset, so the child follows the grown edge", () => {
    const map = constraintAxisMap("right", "x", before, after, 20, 30);
    expect(map).toEqual({ scale: 1, offset: 100 });
    expect(mapRect(PAGE_RECT(20, 0, 30, 10), map!).x).toBe(120);
  });

  it("leftright keeps both offsets and stretches the child", () => {
    const map = constraintAxisMap("leftright", "x", before, after, 20, 30);
    expect(map).toEqual({ scale: 130 / 30, offset: 20 * (1 - 130 / 30) });
    const grown = mapRect(PAGE_RECT(20, 0, 30, 10), map!);
    expect(grown.x).toBe(20);
    expect(grown.width).toBe(130);
  });

  it("center keeps the child centered on the parent's center", () => {
    const map = constraintAxisMap("center", "x", before, after, 20, 30);
    expect(map).toEqual({ scale: 1, offset: 50 });
    expect(mapRect(PAGE_RECT(20, 0, 30, 10), map!).x).toBe(70);
  });

  it("scale scales the offset and the size from the parent's start", () => {
    const map = constraintAxisMap("scale", "x", before, after, 20, 30);
    expect(map).toEqual({ scale: 2, offset: 0 });
    const scaled = mapRect(PAGE_RECT(20, 0, 30, 10), map!);
    expect(scaled.x).toBe(40);
    expect(scaled.width).toBe(60);
  });

  it("scale anchors on the moved parent start, not on the parent's old one", () => {
    // The parent itself was scaled about the world origin: its start moved
    // 50 to 100. A scale child must follow that map, not stay anchored on
    // the old start.
    const moved = PAGE_RECT(100, 0, 40, 100);
    const map = constraintAxisMap("scale", "x", PAGE_RECT(50, 0, 20, 100), moved, 50, 20);
    expect(map).toEqual({ scale: 2, offset: 0 });
    expect(mapRect(PAGE_RECT(50, 0, 20, 10), map!).x).toBe(100);
  });

  it("reads the axis it is asked for", () => {
    const taller = PAGE_RECT(0, 0, 100, 300);
    const map = constraintAxisMap("top", "y", before, taller, 40, 50);
    expect(map).toEqual({ scale: 1, offset: 0 });
    expect(constraintAxisMap("top", "y", before, taller, 40, 50)!.scale).toBe(1);
  });

  it("keeps the start offset when the parent's start edge moves", () => {
    // Resizing from the left: the left edge moves 40 to the right.
    const moved = PAGE_RECT(40, 0, 60, 100);
    const map = constraintAxisMap("left", "x", before, moved, 80, 10);
    expect(map).toEqual({ scale: 1, offset: 40 });
    expect(mapRect(PAGE_RECT(80, 0, 10, 10), map!).x).toBe(120);
  });

  it("answers null for an unknown constraint", () => {
    expect(constraintAxisMap("nowhere", "x", before, after, 0, 10)).toBeNull();
  });

  it("does not scale a collapsed size", () => {
    expect(constraintAxisMap("scale", "x", PAGE_RECT(0, 0, 0, 0), after, 0, 10)).toEqual({
      scale: 1,
      offset: 0,
    });
  });
});

describe("constraintChildMatrix", () => {
  it("combines the two axes and leaves a child that does not move at the identity", () => {
    const before = PAGE_RECT(0, 0, 100, 100);
    const after = PAGE_RECT(0, 0, 200, 100);
    const child = PAGE_RECT(20, 30, 30, 40);
    expect(constraintChildMatrix(before, after, child, "left", "top")).toEqual([1, 0, 0, 1, 0, 0]);
    const matrix = constraintChildMatrix(before, after, child, "leftright", "top");
    expect(matrix).not.toBeNull();
    expect(matrix![0]).toBeCloseTo(130 / 30);
    expect(matrix![3]).toBe(1);
  });

  it("answers null for an unknown constraint value", () => {
    const before = PAGE_RECT(0, 0, 100, 100);
    const after = PAGE_RECT(0, 0, 200, 100);
    expect(constraintChildMatrix(before, after, PAGE_RECT(0, 0, 10, 10), "nope", "top")).toBeNull();
  });
});

describe("isConstraintContainer", () => {
  it("accepts axis-aligned frames, groups and bools", () => {
    expect(isConstraintContainer(shape("f", "frame", PAGE_RECT(0, 0, 10, 10)))).toBe(true);
    expect(isConstraintContainer(shape("g", "group", PAGE_RECT(0, 0, 10, 10)))).toBe(true);
    expect(isConstraintContainer(shape("b", "bool", PAGE_RECT(0, 0, 10, 10)))).toBe(true);
  });

  it("rejects leaves, blocked shapes and turned frames", () => {
    expect(isConstraintContainer(shape("r", "rect", PAGE_RECT(0, 0, 10, 10)))).toBe(false);
    expect(isConstraintContainer(shape("f", "frame", PAGE_RECT(0, 0, 10, 10), { blocked: true })))
      .toBe(false);
    expect(isConstraintContainer(shape("f", "frame", PAGE_RECT(0, 0, 10, 10), { rotation: 30 })))
      .toBe(false);
    expect(isConstraintContainer(shape("f", "frame", PAGE_RECT(0, 0, 10, 10), { "flip-x": true })))
      .toBe(false);
    expect(isConstraintContainer(null)).toBe(false);
  });
});

describe("gestureEntries", () => {
  // A 100 x 100 frame at the origin with a rect, a group with a rect inside
  // and a second frame elsewhere.
  function scene(): WorkspaceObjects {
    const frame = shape("frame", "frame", PAGE_RECT(0, 0, 100, 100), {
      shapes: ["rect", "group", "other"],
    });
    const rect = shape("rect", "rect", PAGE_RECT(10, 10, 20, 20));
    const group = shape("group", "group", PAGE_RECT(50, 50, 20, 20), { shapes: ["inner"] });
    const inner = shape("inner", "rect", PAGE_RECT(50, 50, 20, 20));
    const other = shape("other", "rect", PAGE_RECT(80, 80, 10, 10));
    return objectsOf(frame, rect, group, inner, other);
  }

  // The world matrix of a resize that doubles the frame width from its
  // left edge (the frame keeps its origin).
  const DOUBLE_WIDTH = [2, 0, 0, 1, 0, 0] as const;

  it("gives the root the gesture matrix and each child its constraint", () => {
    const objects = scene();
    const entries = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect([...byId.keys()]).toEqual(["frame", "rect", "group", "inner", "other"]);
    expect(byId.get("frame")!.matrix).toEqual([...DOUBLE_WIDTH]);
    // The default constraint of a first-level frame child is left/top: the
    // rect and the group keep their offsets.
    expect(byId.get("rect")!.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(byId.get("group")!.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    // The deeper rect takes the matrix of its group, not the frame gesture.
    expect(byId.get("inner")!.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    expect(byId.get("other")!.matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("honors the stored constraints of a child", () => {
    const objects = scene();
    objects.rect = { ...objects.rect, "constraints-h": "right" };
    const entries = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0);
    const rect = entries.find((entry) => entry.id === "rect")!;
    expect(rect.matrix).toEqual([1, 0, 0, 1, 100, 0]);
  });

  it("stretches a leftright child on the resized axis only", () => {
    const objects = scene();
    objects.rect = { ...objects.rect, "constraints-h": "leftright" };
    const entries = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0);
    const rect = entries.find((entry) => entry.id === "rect")!;
    const moved = applyTransformToShape(objects.rect, rect.matrix, rect.rotation);
    const grown = selrectOf(moved)!;
    // The parent grew 100, so both margins stay and the child grows 100 too.
    expect(grown.x).toBe(10);
    expect(grown.width).toBe(120);
    expect(grown.height).toBe(20);
  });

  it("scales the children of a group with its own default constraint", () => {
    const objects = objectsOf(
      shape("group", "group", PAGE_RECT(0, 0, 100, 100), { shapes: ["rect"] }),
      shape("rect", "rect", PAGE_RECT(20, 20, 10, 10)),
    );
    const entries = gestureEntries(objects, ["group"], DOUBLE_WIDTH, 0);
    const rect = entries.find((entry) => entry.id === "rect")!;
    expect(rect.matrix).toEqual([2, 0, 0, 1, 0, 0]);
  });

  it("gives a rotated root's direct children the gesture matrix", () => {
    const objects = scene();
    objects.frame = { ...objects.frame, rotation: 45 };
    const entries = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0);
    for (const id of ["rect", "group", "other"]) {
      const entry = entries.find((item) => item.id === id)!;
      expect(entry.matrix).toEqual([...DOUBLE_WIDTH]);
    }
  });

  it("keeps the constraint of an axis-aligned level below a rotated root", () => {
    const objects = scene();
    objects.frame = { ...objects.frame, rotation: 45 };
    objects.inner = { ...objects.inner, "constraints-h": "left" };
    const entries = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0);
    const inner = entries.find((entry) => entry.id === "inner")!;
    // The group took the gesture matrix, so it moved 50 to the right; a
    // left child of an axis-aligned group keeps that offset.
    expect(inner.matrix).toEqual([1, 0, 0, 1, 50, 0]);
  });

  it("moves a rotated selection rigidly and carries the rotation delta", () => {
    const objects = scene();
    const rotate = [0, 1, -1, 0, 0, 0] as const;
    const entries = gestureEntries(objects, ["frame"], rotate, 90);
    const byId = new Map(entries.map((entry) => [entry.id, entry]));
    expect(byId.get("frame")!.rotation).toBe(90);
    expect(byId.get("rect")!.rotation).toBe(90);
    expect(byId.get("inner")!.matrix).toEqual([...rotate]);
  });

  it("keeps the forced left/top of a flow child inside a layout frame", () => {
    const objects = scene();
    objects.frame = { ...objects.frame, layout: "flex" };
    objects.rect = { ...objects.rect, "constraints-h": "scale", "constraints-v": "scale" };
    const entries = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0);
    const rect = entries.find((entry) => entry.id === "rect")!;
    expect(rect.matrix).toEqual([1, 0, 0, 1, 0, 0]);
    // An absolutely positioned child keeps its own constraints.
    objects.rect = { ...objects.rect, "layout-item-absolute": true };
    const absolute = gestureEntries(objects, ["frame"], DOUBLE_WIDTH, 0).find(
      (entry) => entry.id === "rect",
    )!;
    expect(absolute.matrix).toEqual([2, 0, 0, 1, 0, 0]);
  });

  it("filters the set like the gesture does", () => {
    const objects = scene();
    const entries = gestureEntries(
      objects,
      ["frame"],
      DOUBLE_WIDTH,
      0,
      (item) => item.type !== "group",
    );
    const ids = entries.map((entry) => entry.id);
    expect(ids).toEqual(["frame", "rect", "other"]);
  });

  it("keeps the first entry of an id selected twice", () => {
    const objects = scene();
    const entries = gestureEntries(objects, ["frame", "rect"], DOUBLE_WIDTH, 0);
    const rects = entries.filter((entry) => entry.id === "rect");
    expect(rects).toHaveLength(1);
    expect(rects[0].matrix).toEqual([1, 0, 0, 1, 0, 0]);
  });

  it("survives a cycle in the shape tree", () => {
    const objects = objectsOf(
      shape("a", "group", PAGE_RECT(0, 0, 10, 10), { shapes: ["b"] }),
      shape("b", "group", PAGE_RECT(0, 0, 10, 10), { shapes: ["a"] }),
    );
    const entries = gestureEntries(objects, ["a"], DOUBLE_WIDTH, 0);
    expect(entries.map((entry) => entry.id)).toEqual(["a", "b"]);
  });

  it("answers an empty list for an unknown root", () => {
    expect(gestureEntries(scene(), ["missing"], DOUBLE_WIDTH, 0)).toEqual([]);
  });
});

// F9.11: the renderer spreads a gesture over every descendant, text and
// blocked shapes included. The shell takes only the shapes it may transform,
// and a dropped container takes its subtree with it (the renderer reports
// ids in hash order, so the walk goes down from the dropped id).
describe("acceptedSubtreeEntries", () => {
  const MOVE = [1, 0, 0, 1, 5, 0] as const;
  const GROW = [2, 0, 0, 1, 0, 0] as const;

  function scene(): WorkspaceObjects {
    return objectsOf(
      shape("frame", "frame", PAGE_RECT(0, 0, 100, 100), { shapes: ["rect", "label"] }),
      shape("rect", "rect", PAGE_RECT(10, 10, 20, 20)),
      shape("label", "text", PAGE_RECT(10, 40, 20, 10), { shapes: ["inner"] }),
      shape("inner", "rect", PAGE_RECT(10, 40, 5, 5)),
    );
  }

  it("keeps the renderer order and sets the rotation column", () => {
    const entries = acceptedSubtreeEntries(scene(), [
      ["rect", MOVE],
      ["frame", GROW],
    ]);

    expect(entries).toEqual([
      { id: "rect", matrix: MOVE, rotation: 0 },
      { id: "frame", matrix: GROW, rotation: 0 },
    ]);
  });

  it("drops a text shape and its subtree", () => {
    const ids = acceptedSubtreeEntries(scene(), [
      ["rect", MOVE],
      ["label", MOVE],
      ["inner", MOVE],
    ]).map((entry) => entry.id);

    expect(ids).toEqual(["rect"]);
  });

  it("drops a blocked container and its subtree", () => {
    const objects = scene();
    objects.frame = { ...objects.frame, blocked: true };

    const ids = acceptedSubtreeEntries(objects, [
      ["frame", GROW],
      ["rect", MOVE],
    ]).map((entry) => entry.id);

    expect(ids).toEqual([]);
  });

  it("drops an id the model no longer has and repeats of an id", () => {
    const entries = acceptedSubtreeEntries(scene(), [
      ["gone", MOVE],
      ["rect", MOVE],
      ["rect", GROW],
    ]);

    expect(entries.map((entry) => entry.id)).toEqual(["rect"]);
    expect(entries[0].matrix).toEqual(MOVE);
  });

  it("honors a caller gate", () => {
    // Only the frame passes the gate: the rect is a rejected leaf and the
    // label is rejected with the inner rect below it.
    const ids = acceptedSubtreeEntries(
      scene(),
      [
        ["rect", MOVE],
        ["label", MOVE],
        ["frame", GROW],
      ],
      (item) => item.type === "frame",
    ).map((entry) => entry.id);

    expect(ids).toEqual(["frame"]);
  });
});