// Unit tests for the workspace move geometry (lib/workspace-move): the
// move-set expansion, the per-type translation patches and the model
// application. The path expectations mirror the packed-segment protocol of
// app.common.types.path.impl: 28-byte segments with little-endian floats,
// the type short at offset 0 (1 move / 2 line / 3 curve / 4 close), the
// curve handles at 4/8 and 12/16, the endpoint at 20/24.

import { describe, expect, it } from "vitest";

import { PathData } from "@/lib/transit";
import { ZERO_UUID } from "@/lib/file-data";
import {
  applyMove,
  applyReparent,
  buildMoveChanges,
  buildReparentChange,
  moveShapePatch,
  movedGeometry,
  reparentRoots,
  resolveMoveSet,
  topNestedFrameAt,
  translateShape,
} from "@/lib/workspace-move";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

// --- Packed path helpers -----------------------------------------------------

const SEGMENT = 28;

interface Floats {
  [offset: number]: number;
}

function packedSegment(type: number, floats: Floats = {}): Uint8Array {
  const bytes = new Uint8Array(SEGMENT);
  const view = new DataView(bytes.buffer);
  view.setUint16(0, type, true);
  for (const [offset, value] of Object.entries(floats)) {
    view.setFloat32(Number(offset), value, true);
  }
  return bytes;
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function readFloat(bytes: Uint8Array, offset: number): number {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getFloat32(offset, true);
}

// --- Shape fixtures ----------------------------------------------------------

function shape(id: string, type: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type, ...extra };
}

const RECT_SELRECT = { x: 10, y: 20, width: 30, height: 40, x1: 10, y1: 20, x2: 40, y2: 60 };
const RECT_POINTS = [
  { x: 10, y: 20 },
  { x: 40, y: 20 },
  { x: 40, y: 60 },
  { x: 10, y: 60 },
];

function rectShape(extra: Record<string, unknown> = {}): WorkspaceShape {
  return shape("rect-1", "rect", {
    selrect: { ...RECT_SELRECT },
    points: RECT_POINTS.map((point) => ({ ...point })),
    rotation: 0,
    ...extra,
  });
}

describe("resolveMoveSet", () => {
  it("returns the selection for leaf shapes, deduplicated in order", () => {
    const objects: WorkspaceObjects = {
      a: shape("a", "rect"),
      b: shape("b", "text"),
    };
    expect(resolveMoveSet(["a", "b", "a"], objects)).toEqual(["a", "b"]);
  });

  it("expands the subtree of a container depth-first", () => {
    const objects: WorkspaceObjects = {
      f: shape("f", "frame", { shapes: ["g", "leaf"] }),
      g: shape("g", "group", { shapes: ["inner"] }),
      inner: shape("inner", "rect"),
      leaf: shape("leaf", "rect"),
    };
    expect(resolveMoveSet(["f"], objects)).toEqual(["f", "g", "inner", "leaf"]);
  });

  it("merges overlapping selections without duplicates", () => {
    const objects: WorkspaceObjects = {
      f: shape("f", "frame", { shapes: ["g", "leaf"] }),
      g: shape("g", "group", { shapes: ["inner"] }),
      inner: shape("inner", "rect"),
      leaf: shape("leaf", "rect"),
    };
    expect(resolveMoveSet(["g", "f"], objects)).toEqual(["g", "inner", "f", "leaf"]);
  });

  it("skips ids missing from the objects", () => {
    expect(resolveMoveSet(["missing"], {})).toEqual([]);
  });

  it("is cycle-safe on a malformed self-reference loop", () => {
    const objects: WorkspaceObjects = {
      a: shape("a", "group", { shapes: ["b"] }),
      b: shape("b", "group", { shapes: ["a"] }),
    };
    expect(resolveMoveSet(["a"], objects)).toEqual(["a", "b"]);
  });
});

describe("moveShapePatch", () => {
  it("shifts x/y, selrect (x/y/x1/y1/x2/y2) and points, never width/height", () => {
    const patch = moveShapePatch(rectShape(), 3, -7);
    expect(patch["x"]).toBe(13);
    expect(patch["y"]).toBe(13);
    expect(patch["selrect"]).toEqual({
      x: 13,
      y: 13,
      width: 30,
      height: 40,
      x1: 13,
      y1: 13,
      x2: 43,
      y2: 53,
    });
    expect(patch["points"]).toEqual([
      { x: 13, y: 13 },
      { x: 43, y: 13 },
      { x: 43, y: 53 },
      { x: 13, y: 53 },
    ]);
    expect("width" in patch).toBe(false);
    expect("height" in patch).toBe(false);
  });

  it("keeps the original selrect keys it cannot shift", () => {
    const shapeWithPartial = shape("r", "rect", {
      selrect: { x: 1, y: 2, width: 3, height: 4, custom: "keep" },
    });
    const patch = moveShapePatch(shapeWithPartial, 10, 10);
    expect(patch["selrect"]).toEqual({ x: 11, y: 12, width: 3, height: 4, custom: "keep" });
  });

  it("returns an empty patch for a shape without geometry", () => {
    expect(moveShapePatch(shape("s", "rect"), 5, 5)).toEqual({});
  });

  it("shifts the position-data items of a text keeping their other keys", () => {
    const text = rectShape({
      id: "text-1",
      type: "text",
      "position-data": [
        { x: 10, y: 20, width: 5, height: 8, "font-size": 14 },
        { x: 30, y: 40, width: 6, height: 8, "font-size": 14 },
      ],
    });
    const patch = moveShapePatch(text, 2, 4);
    expect(patch["position-data"]).toEqual([
      { x: 12, y: 24, width: 5, height: 8, "font-size": 14 },
      { x: 32, y: 44, width: 6, height: 8, "font-size": 14 },
    ]);
    // Text also takes the generic x/y branch (not path/bool).
    expect(patch["x"]).toBe(12);
    expect(patch["y"]).toBe(24);
  });

  it("leaves a text without position-data to the generic branch", () => {
    const patch = moveShapePatch(rectShape({ type: "text" }), 1, 1);
    expect("position-data" in patch).toBe(false);
    expect(patch["x"]).toBe(11);
  });

  it("translates the packed content of a path and keeps x/y out", () => {
    const content = concatBytes(
      packedSegment(1, { 20: 10, 24: 20 }),
      packedSegment(2, { 20: 30, 24: 40 }),
      packedSegment(3, { 4: 1, 8: 2, 12: 3, 16: 4, 20: 5, 24: 6 }),
      packedSegment(4),
    );
    const path = shape("path-1", "path", {
      content: new PathData(content),
      selrect: { ...RECT_SELRECT },
      points: RECT_POINTS.map((point) => ({ ...point })),
    });

    const patch = moveShapePatch(path, 3, -7);
    expect(patch["content"]).toBeInstanceOf(PathData);
    const moved = (patch["content"] as PathData).bytes;
    expect(moved).not.toBe(content);
    expect(readFloat(moved, 20)).toBe(13);
    expect(readFloat(moved, 24)).toBe(13);
    expect(readFloat(moved, SEGMENT + 20)).toBe(33);
    expect(readFloat(moved, SEGMENT + 24)).toBe(33);
    expect(readFloat(moved, 2 * SEGMENT + 4)).toBe(4); // 1 + 3
    expect(readFloat(moved, 2 * SEGMENT + 8)).toBe(-5); // 2 - 7
    expect(readFloat(moved, 2 * SEGMENT + 12)).toBe(6); // 3 + 3
    expect(readFloat(moved, 2 * SEGMENT + 16)).toBe(-3); // 4 - 7
    expect(readFloat(moved, 2 * SEGMENT + 20)).toBe(8); // 5 + 3
    expect(readFloat(moved, 2 * SEGMENT + 24)).toBe(-1); // 6 - 7
    // The originals stay untouched.
    expect(readFloat(content, 20)).toBe(10);
    expect(readFloat(content, 2 * SEGMENT + 4)).toBe(1);
    // Path shapes never take the generic x/y branch but keep selrect/points.
    expect("x" in patch).toBe(false);
    expect(patch["selrect"]).toEqual({
      x: 13,
      y: 13,
      width: 30,
      height: 40,
      x1: 13,
      y1: 13,
      x2: 43,
      y2: 53,
    });
    expect(patch["points"]).toEqual([
      { x: 13, y: 13 },
      { x: 43, y: 13 },
      { x: 43, y: 53 },
      { x: 13, y: 53 },
    ]);
  });

  it("treats bool shapes like paths", () => {
    const content = packedSegment(1, { 20: 1, 24: 2 });
    const bool = shape("bool-1", "bool", {
      content: new PathData(content),
      selrect: { ...RECT_SELRECT },
    });
    const patch = moveShapePatch(bool, 1, 1);
    expect(patch["content"]).toBeInstanceOf(PathData);
    expect(readFloat((patch["content"] as PathData).bytes, 20)).toBe(2);
    expect(readFloat((patch["content"] as PathData).bytes, 24)).toBe(3);
    expect("x" in patch).toBe(false);
  });

  it("leaves the trailing bytes past the last full segment untouched", () => {
    const bytes = new Uint8Array(SEGMENT + 2);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 1, true);
    view.setFloat32(20, 10, true);
    view.setFloat32(24, 20, true);
    view.setUint8(SEGMENT, 0xab);
    view.setUint8(SEGMENT + 1, 0xcd);
    const path = shape("path-1", "path", { content: new PathData(bytes) });
    const patch = moveShapePatch(path, 3, 3);
    const moved = (patch["content"] as PathData).bytes;
    expect(moved.byteLength).toBe(SEGMENT + 2);
    expect(moved[SEGMENT]).toBe(0xab);
    expect(moved[SEGMENT + 1]).toBe(0xcd);
    expect(readFloat(moved, 20)).toBe(13);
  });

  it("skips non-packed content without failing", () => {
    const path = shape("path-1", "path", {
      content: "M0 0 L10 10",
      selrect: { ...RECT_SELRECT },
    });
    const patch = moveShapePatch(path, 1, 1);
    expect("content" in patch).toBe(false);
    expect(patch["x"]).toBeUndefined();
    expect(patch["selrect"]).toBeDefined();
  });
});

describe("translateShape", () => {
  it("applies the patch over a copy and keeps unrelated attributes", () => {
    const original = rectShape({ rotation: 45, name: "Box" });
    const moved = translateShape(original, 3, -7);
    expect(moved).not.toBe(original);
    expect(moved.rotation).toBe(45);
    expect(moved.name).toBe("Box");
    expect(moved["selrect"]).toEqual({
      x: 13,
      y: 13,
      width: 30,
      height: 40,
      x1: 13,
      y1: 13,
      x2: 43,
      y2: 53,
    });
    expect((moved.points ?? [])[0]).toEqual({ x: 13, y: 13 });
    // The original keeps its geometry.
    expect(original["selrect"]).toEqual(RECT_SELRECT);
    expect((original.points ?? [])[0]).toEqual({ x: 10, y: 20 });
  });
});

describe("applyMove", () => {
  const objects: WorkspaceObjects = {
    a: rectShape({ id: "a" }),
    b: rectShape({ id: "b" }),
    c: rectShape({ id: "c" }),
  };

  it("returns the same map for a zero delta", () => {
    expect(applyMove(objects, ["a"], 0, 0)).toBe(objects);
  });

  it("replaces only the move set, sharing the untouched entries", () => {
    const moved = applyMove(objects, ["a", "b"], 3, -7);
    expect(moved).not.toBe(objects);
    expect(moved["a"]).not.toBe(objects["a"]);
    expect(moved["b"]).not.toBe(objects["b"]);
    expect(moved["c"]).toBe(objects["c"]);
    expect((moved["a"].points ?? [])[0]).toEqual({ x: 13, y: 13 });
    expect((moved["c"].points ?? [])[0]).toEqual({ x: 10, y: 20 });
    // The original map and its shapes stay untouched.
    expect((objects["a"].points ?? [])[0]).toEqual({ x: 10, y: 20 });
  });

  it("deduplicates the move set and skips missing ids", () => {
    const moved = applyMove(objects, ["a", "a", "missing"], 1, 1);
    expect((moved["a"].points ?? [])[0]).toEqual({ x: 11, y: 21 });
    expect((moved["b"].points ?? [])[0]).toEqual({ x: 10, y: 20 });
  });
});

describe("buildMoveChanges", () => {
  const PAGE = "00000000-0000-0000-0000-0000000000ff";

  function moveFixture(): WorkspaceObjects {
    return { a: rectShape({ id: "a", x: 10, y: 20, width: 30, height: 40 }) };
  }

  it("emits one mod-obj carrying only the differing attributes", () => {
    const changes = buildMoveChanges(moveFixture(), ["a"], 3, -7, PAGE);
    expect(changes).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "a",
        operations: [
          { type: "set", attr: "x", val: 13 },
          { type: "set", attr: "y", val: 13 },
          {
            type: "set",
            attr: "selrect",
            val: { x: 13, y: 13, width: 30, height: 40, x1: 13, y1: 13, x2: 43, y2: 53 },
          },
          {
            type: "set",
            attr: "points",
            val: [
              { x: 13, y: 13 },
              { x: 43, y: 13 },
              { x: 43, y: 53 },
              { x: 13, y: 53 },
            ],
          },
        ],
      },
    ]);
  });

  it("drops the attributes a single-axis move leaves untouched", () => {
    const changes = buildMoveChanges(moveFixture(), ["a"], 0, -5, PAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0].operations.map((operation) => operation.attr)).toEqual([
      "y",
      "selrect",
      "points",
    ]);
    expect(changes[0].operations[0].val).toBe(15);
  });

  it("sends nothing when the patch matches the model", () => {
    expect(buildMoveChanges(moveFixture(), ["a"], 0, 0, PAGE)).toEqual([]);
  });

  it("keeps the translated position-data operation of a text", () => {
    const objects: WorkspaceObjects = {
      t: rectShape({
        id: "t",
        type: "text",
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        "position-data": [{ x: 10, y: 20, width: 5, height: 8, "font-size": 14 }],
      }),
    };
    const changes = buildMoveChanges(objects, ["t"], 2, 4, PAGE);
    expect(changes[0].operations.map((operation) => operation.attr)).toEqual([
      "position-data",
      "x",
      "y",
      "selrect",
      "points",
    ]);
    expect(changes[0].operations[0].val).toEqual([
      { x: 12, y: 24, width: 5, height: 8, "font-size": 14 },
    ]);
  });

  it("emits the translated packed content of a path and no x/y", () => {
    const content = concatBytes(
      packedSegment(1, { 20: 10, 24: 20 }),
      packedSegment(2, { 20: 30, 24: 40 }),
    );
    const objects: WorkspaceObjects = {
      p: shape("p", "path", {
        content: new PathData(content),
        selrect: { ...RECT_SELRECT },
        points: RECT_POINTS.map((point) => ({ ...point })),
      }),
    };
    const changes = buildMoveChanges(objects, ["p"], 3, -7, PAGE);
    expect(changes[0].operations.map((operation) => operation.attr)).toEqual([
      "content",
      "selrect",
      "points",
    ]);
    const value = changes[0].operations[0].val;
    expect(value).toBeInstanceOf(PathData);
    const moved = (value as PathData).bytes;
    expect(readFloat(moved, 20)).toBe(13);
    expect(readFloat(moved, 24)).toBe(13);
    expect(readFloat(moved, SEGMENT + 20)).toBe(33);
    expect(readFloat(moved, SEGMENT + 24)).toBe(33);
  });

  it("drops a path whose translation round-trips to the same bytes", () => {
    const objects: WorkspaceObjects = {
      p: shape("p", "path", {
        content: new PathData(packedSegment(1, { 20: 10, 24: 20 })),
        selrect: { ...RECT_SELRECT },
      }),
    };
    expect(buildMoveChanges(objects, ["p"], 0, 0, PAGE)).toEqual([]);
  });

  it("skips shapes without changes and ids missing from the model", () => {
    const objects: WorkspaceObjects = {
      noGeom: shape("noGeom", "rect"),
      a: rectShape({ id: "a", x: 10, y: 20, width: 30, height: 40 }),
    };
    const changes = buildMoveChanges(objects, ["noGeom", "a", "missing", "a"], 1, 1, PAGE);
    expect(changes).toHaveLength(1);
    expect(changes[0].id).toBe("a");
  });
});

// --- T4 fixtures -------------------------------------------------------------

function frameShape(
  id: string,
  geo: { x: number; y: number; width: number; height: number },
  extra: Record<string, unknown> = {},
): WorkspaceShape {
  return shape(id, "frame", {
    x: geo.x,
    y: geo.y,
    width: geo.width,
    height: geo.height,
    selrect: { x: geo.x, y: geo.y, width: geo.width, height: geo.height },
    "parent-id": ZERO_UUID,
    "frame-id": ZERO_UUID,
    shapes: [],
    ...extra,
  });
}

function rootShape(shapes: string[]): WorkspaceShape {
  return shape(ZERO_UUID, "frame", { shapes });
}

// --- T4: target frame resolution + reparent change ---------------------------

describe("topNestedFrameAt", () => {
  it("returns the frame under the position, ZERO_UUID over the blank", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }),
    };
    expect(topNestedFrameAt(objects, { x: 50, y: 50 }, new Set())).toBe("f1");
    expect(topNestedFrameAt(objects, { x: 150, y: 50 }, new Set())).toBe(ZERO_UUID);
  });

  it("includes the closed frame bounds, like the fast box test", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }),
    };
    expect(topNestedFrameAt(objects, { x: 100, y: 100 }, new Set())).toBe("f1");
  });

  it("descends into the deepest frame hit", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["outer"]),
      outer: frameShape("outer", { x: 0, y: 0, width: 200, height: 200 }, { shapes: ["inner"] }),
      inner: frameShape(
        "inner",
        { x: 50, y: 50, width: 100, height: 100 },
        { "parent-id": "outer", "frame-id": "outer" },
      ),
    };
    expect(topNestedFrameAt(objects, { x: 100, y: 100 }, new Set())).toBe("inner");
    // Outside the inner frame but inside the outer one.
    expect(topNestedFrameAt(objects, { x: 20, y: 20 }, new Set())).toBe("outer");
  });

  it("excludes the frames of a live move", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["outer"]),
      outer: frameShape("outer", { x: 0, y: 0, width: 200, height: 200 }, { shapes: ["inner"] }),
      inner: frameShape(
        "inner",
        { x: 50, y: 50, width: 100, height: 100 },
        { "parent-id": "outer", "frame-id": "outer" },
      ),
    };
    // Dragging the inner frame lands on its parent...
    expect(topNestedFrameAt(objects, { x: 100, y: 100 }, new Set(["inner"]))).toBe("outer");
    // ...and a whole nested chain excludes back to the root.
    expect(topNestedFrameAt(objects, { x: 100, y: 100 }, new Set(["outer", "inner"]))).toBe(
      ZERO_UUID,
    );
  });

  it("drops the hidden and blocked frames", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }, { hidden: true }),
      f2: frameShape("f2", { x: 0, y: 0, width: 100, height: 100 }, { blocked: true }),
    };
    expect(topNestedFrameAt(objects, { x: 50, y: 50 }, new Set())).toBe(ZERO_UUID);
  });

  it("picks the top-most of the overlapping sibling frames", () => {
    // The tail of the shapes array paints on top (the CLJS z-order).
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f2", "f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }),
      f2: frameShape("f2", { x: 0, y: 0, width: 100, height: 100 }),
    };
    expect(topNestedFrameAt(objects, { x: 50, y: 50 }, new Set())).toBe("f1");
    const flipped: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }),
      f2: frameShape("f2", { x: 0, y: 0, width: 100, height: 100 }),
    };
    expect(topNestedFrameAt(flipped, { x: 50, y: 50 }, new Set())).toBe("f2");
  });

  it("uses the polygon test for a rotated frame", () => {
    // A 40x40 square rotated 45 degrees around (50, 50): the diamond of
    // vertices (50, 21.72) (78.28, 50) (50, 78.28) (21.72, 50).
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["rf"]),
      rf: frameShape(
        "rf",
        { x: 21.72, y: 21.72, width: 56.57, height: 56.57 },
        {
          rotation: 45,
          points: [
            { x: 50, y: 21.72 },
            { x: 78.28, y: 50 },
            { x: 50, y: 78.28 },
            { x: 21.72, y: 50 },
          ],
        },
      ),
    };
    expect(topNestedFrameAt(objects, { x: 60, y: 50 }, new Set())).toBe("rf");
    // Inside the axis-aligned box but outside the diamond.
    expect(topNestedFrameAt(objects, { x: 25, y: 25 }, new Set())).toBe(ZERO_UUID);
  });

  it("clips a nested frame away under a hiding ancestor", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["outer"]),
      outer: frameShape("outer", { x: 0, y: 0, width: 100, height: 100 }, { shapes: ["inner"] }),
      inner: frameShape(
        "inner",
        { x: 200, y: 200, width: 100, height: 100 },
        { "parent-id": "outer", "frame-id": "outer" },
      ),
    };
    // The position sits inside the inner frame but outside its clipping
    // ancestor (show-content absent = clipped).
    expect(topNestedFrameAt(objects, { x: 250, y: 250 }, new Set())).toBe(ZERO_UUID);
    // With show-content true the ancestor stops clipping.
    const shown: WorkspaceObjects = {
      ...objects,
      outer: frameShape(
        "outer",
        { x: 0, y: 0, width: 100, height: 100 },
        { shapes: ["inner"], "show-content": true },
      ),
    };
    expect(topNestedFrameAt(shown, { x: 250, y: 250 }, new Set())).toBe("inner");
  });
});

describe("reparentRoots + buildReparentChange", () => {
  const PAGE = "00000000-0000-0000-0000-0000000000ff";

  function reparentFixture(): WorkspaceObjects {
    return {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }, { shapes: ["g", "leaf"] }),
      f2: frameShape("f2", { x: 200, y: 0, width: 100, height: 100 }),
      g: shape("g", "group", { shapes: ["inner"], "parent-id": "f1", "frame-id": "f1" }),
      inner: shape("inner", "rect", { "parent-id": "g", "frame-id": "f1" }),
      leaf: shape("leaf", "rect", { "parent-id": "f1", "frame-id": "f1" }),
      loose: shape("loose", "rect", { "parent-id": ZERO_UUID, "frame-id": ZERO_UUID }),
    };
  }

  it("keeps only the roots of the selection (clean-loops)", () => {
    const objects = reparentFixture();
    expect(reparentRoots(objects, ["f1", "g", "inner"], "f2")).toEqual(["f1"]);
    expect(reparentRoots(objects, ["g", "inner", "leaf"], "f2")).toEqual(["g", "leaf"]);
  });

  it("drops the shapes already owned by the target frame", () => {
    const objects = reparentFixture();
    // Leaf already lives inside f1; loose lives under the root.
    expect(reparentRoots(objects, ["leaf", "loose"], "f1")).toEqual(["loose"]);
    expect(reparentRoots(objects, ["leaf", "loose"], ZERO_UUID)).toEqual(["leaf"]);
  });

  it("keeps the selection order and deduplicates", () => {
    const objects = reparentFixture();
    expect(reparentRoots(objects, ["loose", "leaf", "loose"], "f2")).toEqual(["loose", "leaf"]);
  });

  it("builds a mov-objects change with the reversed ids", () => {
    const objects = reparentFixture();
    const change = buildReparentChange(objects, ["loose", "leaf"], "f2", PAGE);
    expect(change).toEqual({
      type: "mov-objects",
      "page-id": PAGE,
      "parent-id": "f2",
      shapes: ["leaf", "loose"],
    });
  });

  it("returns null when nothing would move", () => {
    const objects = reparentFixture();
    expect(buildReparentChange(objects, ["leaf"], "f1", PAGE)).toBeNull();
    expect(buildReparentChange(objects, [], "f2", PAGE)).toBeNull();
    expect(buildReparentChange(objects, ["missing"], "f2", PAGE)).toBeNull();
  });
});

// --- T5: model application + wasm geometry slice -----------------------------

describe("applyReparent", () => {
  it("moves a root shape into a frame: links and both children lists", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["r1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }),
      r1: shape("r1", "rect", { "parent-id": ZERO_UUID, "frame-id": ZERO_UUID }),
    };
    const next = applyReparent(objects, ["r1"], "f1");
    expect(next.r1["parent-id"]).toBe("f1");
    expect(next.r1["frame-id"]).toBe("f1");
    expect(next[ZERO_UUID].shapes).toEqual([]);
    expect(next.f1.shapes).toEqual(["r1"]);
    // The original map and shapes stay untouched.
    expect(objects.r1["parent-id"]).toBe(ZERO_UUID);
    expect(objects[ZERO_UUID].shapes).toEqual(["r1"]);
    expect(objects.f1.shapes).toEqual([]);
  });

  it("keeps a moved frame's subtree frame-ids and rewrites the frame itself", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["outer", "inner"]),
      outer: frameShape(
        "outer",
        { x: 0, y: 0, width: 300, height: 300 },
        { shapes: ["sibling"] },
      ),
      sibling: shape("sibling", "rect", { "parent-id": "outer", "frame-id": "outer" }),
      inner: frameShape(
        "inner",
        { x: 10, y: 10, width: 100, height: 100 },
        { "parent-id": ZERO_UUID, "frame-id": ZERO_UUID, shapes: ["leaf"] },
      ),
      leaf: shape("leaf", "rect", { "parent-id": "inner", "frame-id": "inner" }),
    };
    const next = applyReparent(objects, ["inner"], "outer");
    expect(next.inner["parent-id"]).toBe("outer");
    expect(next.inner["frame-id"]).toBe("outer");
    // The children of a moved frame already point at it: unchanged.
    expect(next.leaf["frame-id"]).toBe("inner");
    expect(next.outer.shapes).toEqual(["sibling", "inner"]);
    // The moved frame leaves the root; the other root child stays.
    expect(next[ZERO_UUID].shapes).toEqual(["outer"]);
  });

  it("rewrites the whole subtree of a moved non-frame container", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }, { shapes: ["g"] }),
      f2: frameShape("f2", { x: 200, y: 0, width: 100, height: 100 }),
      g: shape("g", "group", { shapes: ["c1"], "parent-id": "f1", "frame-id": "f1" }),
      c1: shape("c1", "group", { shapes: ["c2"], "parent-id": "g", "frame-id": "f1" }),
      c2: shape("c2", "rect", { "parent-id": "c1", "frame-id": "f1" }),
    };
    const next = applyReparent(objects, ["g"], "f2");
    expect(next.g["parent-id"]).toBe("f2");
    expect(next.g["frame-id"]).toBe("f2");
    expect(next.c1["frame-id"]).toBe("f2");
    expect(next.c2["frame-id"]).toBe("f2");
    // The intermediate container parent-ids do not change.
    expect(next.c1["parent-id"]).toBe("g");
    expect(next.c2["parent-id"]).toBe("c1");
    expect(next.f1.shapes).toEqual([]);
    expect(next.f2.shapes).toEqual(["g"]);
  });

  it("drags out to the root: parent-id and frame-id become the zero root", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }, { shapes: ["r1"] }),
      r1: shape("r1", "rect", { "parent-id": "f1", "frame-id": "f1" }),
    };
    const next = applyReparent(objects, ["r1"], ZERO_UUID);
    expect(next.r1["parent-id"]).toBe(ZERO_UUID);
    expect(next.r1["frame-id"]).toBe(ZERO_UUID);
    expect(next[ZERO_UUID].shapes).toEqual(["f1", "r1"]);
    expect(next.f1.shapes).toEqual([]);
  });

  it("returns the same reference when the target is inside the moved subtree", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }, { shapes: ["inner"] }),
      inner: frameShape(
        "inner",
        { x: 10, y: 10, width: 50, height: 50 },
        { "parent-id": "f1", "frame-id": "f1" },
      ),
    };
    // Dragging f1 into inner: the whole change is invalid (the backend
    // gate), and dragging a frame into itself too.
    expect(applyReparent(objects, ["f1"], "inner")).toBe(objects);
    expect(applyReparent(objects, ["f1"], "f1")).toBe(objects);
  });

  it("returns the same reference for a missing root or target", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { x: 0, y: 0, width: 100, height: 100 }),
    };
    expect(applyReparent(objects, ["missing"], "f1")).toBe(objects);
    expect(applyReparent(objects, ["f1"], "missing")).toBe(objects);
    expect(applyReparent(objects, [], "f1")).toBe(objects);
  });
});

describe("movedGeometry", () => {
  it("translates the selrect corners of a plain shape", () => {
    const geometry = movedGeometry(rectShape(), 5, -3);
    expect(geometry?.selrect).toEqual({ x1: 15, y1: 17, x2: 45, y2: 57 });
    expect(geometry?.pathContent).toBeUndefined();
  });

  it("falls back to x/y + width/height when the corners are absent", () => {
    const plain = shape("r2", "rect", {
      selrect: { x: 10, y: 20, width: 30, height: 40 },
    });
    expect(movedGeometry(plain, 1, 2)?.selrect).toEqual({ x1: 11, y1: 22, x2: 41, y2: 62 });
  });

  it("carries the translated packed content of path shapes", () => {
    const content = concatBytes(
      packedSegment(1, { 20: 1, 24: 2 }),
      packedSegment(3, { 4: 1, 8: 1, 12: 2, 16: 2, 20: 3, 24: 3 }),
      packedSegment(4),
    );
    const path = shape("p", "path", {
      content: new PathData(content),
      selrect: { ...RECT_SELRECT },
    });
    const bytes = movedGeometry(path, 3, -7)?.pathContent;
    expect(bytes).toBeDefined();
    expect(bytes).not.toBe(content);
    // The move segment endpoint and the curve handles + endpoint shift.
    expect(readFloat(bytes as Uint8Array, 20)).toBe(4);
    expect(readFloat(bytes as Uint8Array, 24)).toBe(-5);
    expect(readFloat(bytes as Uint8Array, SEGMENT + 4)).toBe(4);
    expect(readFloat(bytes as Uint8Array, SEGMENT + 8)).toBe(-6);
    expect(readFloat(bytes as Uint8Array, SEGMENT + 24)).toBe(-4);
  });

  it("answers null without a selrect", () => {
    expect(movedGeometry(shape("x", "rect"), 1, 1)).toBeNull();
  });
});
