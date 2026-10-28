// The align/distribute math of lib/workspace-align.ts. The expectations
// mirror calc-align-pos (six axes), align-to-rect (a multi selection aligns
// to its wrapping box), align-to-parent (a single shape aligns to the parent
// frame) and distribute-space (even gaps between the wrapping boxes).

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  alignMoves,
  boundsOf,
  canAlign,
  canDistribute,
  distributeMoves,
  unionBounds,
} from "@/lib/workspace-align";
import { IDENTITY_MATRIX, matrixRecord } from "@/lib/workspace-transform";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

const IDENTITY_RECORD = matrixRecord(IDENTITY_MATRIX);
const PARENT_ID = "frame-1";
const ROOT_ID = ZERO_UUID;

function shape(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  extra: Record<string, unknown> = {},
): WorkspaceShape {
  return {
    id,
    type: "rect",
    x,
    y,
    width,
    height,
    selrect: { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height },
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
    rotation: 0,
    transform: { ...IDENTITY_RECORD },
    "transform-inverse": { ...IDENTITY_RECORD },
    ...extra,
  };
}

function objectsOf(...shapes: WorkspaceShape[]): WorkspaceObjects {
  const objects: WorkspaceObjects = {};
  for (const item of shapes) objects[item.id] = item;
  return objects;
}

function movesById(moves: readonly { id: string; dx: number; dy: number }[]) {
  const out: Record<string, { dx: number; dy: number }> = {};
  for (const move of moves) out[move.id] = { dx: move.dx, dy: move.dy };
  return out;
}

describe("boundsOf", () => {
  it("reads the stored points box", () => {
    expect(boundsOf(shape("a", 10, 20, 100, 50))).toEqual({
      x: 10,
      y: 20,
      width: 100,
      height: 50,
    });
  });

  it("wraps a rotated shape with its axis-aligned box", () => {
    // A 100x50 box rotated 90 degrees around its center.
    const rotated = shape("a", 0, 0, 100, 50, {
      points: [
        { x: 75, y: -25 },
        { x: 75, y: 75 },
        { x: -25, y: 75 },
        { x: -25, y: -25 },
      ],
    });
    expect(boundsOf(rotated)).toEqual({ x: -25, y: -25, width: 100, height: 100 });
  });

  it("falls back to the selrect when the shape carries no points", () => {
    const bare = shape("a", 5, 6, 30, 40);
    delete bare["points"];
    expect(boundsOf(bare)).toEqual({ x: 5, y: 6, width: 30, height: 40 });
  });

  it("returns null without a selrect", () => {
    const bare = shape("a", 0, 0, 10, 10);
    delete bare["points"];
    delete bare["selrect"];
    expect(boundsOf(bare)).toBeNull();
  });
});

describe("unionBounds", () => {
  it("wraps every box", () => {
    expect(
      unionBounds([
        { x: 0, y: 0, width: 10, height: 10 },
        { x: 20, y: 5, width: 10, height: 20 },
      ]),
    ).toEqual({ x: 0, y: 0, width: 30, height: 25 });
  });

  it("returns null for an empty list", () => {
    expect(unionBounds([])).toBeNull();
  });
});

describe("canAlign", () => {
  it("accepts a multi selection", () => {
    const objects = objectsOf(shape("a", 0, 0, 10, 10), shape("b", 20, 0, 10, 10));
    expect(canAlign(objects, ["a", "b"])).toBe(true);
  });

  it("rejects a single root child", () => {
    const objects = objectsOf(shape("a", 0, 0, 10, 10, { "parent-id": ROOT_ID }));
    expect(canAlign(objects, ["a"])).toBe(false);
  });

  it("accepts a single shape inside a frame", () => {
    const objects = objectsOf(shape("a", 0, 0, 10, 10, { "parent-id": PARENT_ID }));
    expect(canAlign(objects, ["a"])).toBe(true);
  });

  it("rejects an empty selection", () => {
    expect(canAlign({}, [])).toBe(false);
  });
});

describe("canDistribute", () => {
  it("needs three shapes", () => {
    expect(canDistribute(["a", "b"])).toBe(false);
    expect(canDistribute(["a", "b", "c"])).toBe(true);
  });
});

describe("alignMoves over a multi selection", () => {
  const objects = objectsOf(
    shape("a", 0, 0, 100, 50),
    shape("b", 200, 100, 40, 40),
  );

  it("aligns the left edges", () => {
    const moves = movesById(alignMoves(objects, ["a", "b"], "hleft"));
    expect(moves.a).toBeUndefined();
    expect(moves.b).toEqual({ dx: -200, dy: 0 });
  });

  it("aligns the horizontal centers", () => {
    const moves = movesById(alignMoves(objects, ["a", "b"], "hcenter"));
    // The wrapper spans 0..240; its center sits at 120.
    expect(moves.a).toEqual({ dx: 70, dy: 0 });
    expect(moves.b).toEqual({ dx: -100, dy: 0 });
  });

  it("aligns the right edges", () => {
    const moves = movesById(alignMoves(objects, ["a", "b"], "hright"));
    expect(moves.a).toEqual({ dx: 140, dy: 0 });
    expect(moves.b).toBeUndefined();
  });

  it("aligns the top edges", () => {
    const moves = movesById(alignMoves(objects, ["a", "b"], "vtop"));
    expect(moves.b).toEqual({ dx: 0, dy: -100 });
  });

  it("aligns the vertical centers", () => {
    const moves = movesById(alignMoves(objects, ["a", "b"], "vcenter"));
    // The wrapper spans 0..140; its center sits at 70.
    expect(moves.a).toEqual({ dx: 0, dy: 45 });
    expect(moves.b).toEqual({ dx: 0, dy: -50 });
  });

  it("aligns the bottom edges", () => {
    const moves = movesById(alignMoves(objects, ["a", "b"], "vbottom"));
    expect(moves.a).toEqual({ dx: 0, dy: 90 });
    expect(moves.b).toBeUndefined();
  });
});

describe("alignMoves over a single selection", () => {
  it("aligns the shape to the parent frame", () => {
    const parent = shape(PARENT_ID, 100, 100, 400, 300, { type: "frame" });
    const child = shape("a", 120, 130, 50, 50, { "parent-id": PARENT_ID });
    const objects = objectsOf(parent, child);
    const moves = movesById(alignMoves(objects, ["a"], "hleft"));
    expect(moves.a).toEqual({ dx: -20, dy: 0 });
  });

  it("carries the delta through a rotated parent", () => {
    // The parent rotates 90 degrees around its center, so its local x axis
    // points down in world coordinates and the delta turns with it.
    const parent = shape(PARENT_ID, 0, 0, 100, 100, {
      type: "frame",
      rotation: 90,
      transform: { a: 0, b: 1, c: -1, d: 0, e: 0, f: 0 },
    });
    const child = shape("a", 50, 50, 10, 10, { "parent-id": PARENT_ID });
    const moves = movesById(alignMoves(objectsOf(parent, child), ["a"], "hleft"));
    expect(moves.a.dx).toBeCloseTo(0, 6);
    expect(moves.a.dy).toBeCloseTo(-50, 6);
  });

  it("sends nothing when the shape already sits at the parent edge", () => {
    const parent = shape(PARENT_ID, 100, 100, 400, 300, { type: "frame" });
    const child = shape("a", 100, 130, 50, 50, { "parent-id": PARENT_ID });
    const objects = objectsOf(parent, child);
    expect(alignMoves(objects, ["a"], "hleft")).toEqual([]);
  });

  it("sends nothing when the parent is missing", () => {
    const child = shape("a", 0, 0, 10, 10, { "parent-id": PARENT_ID });
    expect(alignMoves(objectsOf(child), ["a"], "hleft")).toEqual([]);
  });
});

describe("distributeMoves", () => {
  it("spreads the even gap between three boxes", () => {
    const objects = objectsOf(
      shape("a", 0, 0, 10, 10),
      shape("b", 30, 0, 10, 10),
      shape("c", 100, 0, 10, 10),
    );
    // The wrapper spans 0..110, the boxes 30 wide, so the gap is 40 each.
    const moves = movesById(distributeMoves(objects, ["a", "b", "c"], "horizontal"));
    expect(moves.a).toBeUndefined();
    expect(moves.b).toEqual({ dx: 20, dy: 0 });
    expect(moves.c).toBeUndefined();
  });

  it("sorts by the box center before spreading", () => {
    const objects = objectsOf(
      shape("c", 100, 0, 10, 10),
      shape("a", 0, 0, 10, 10),
      shape("b", 30, 0, 10, 10),
    );
    const moves = movesById(distributeMoves(objects, ["c", "a", "b"], "horizontal"));
    expect(moves.b).toEqual({ dx: 20, dy: 0 });
    expect(moves.a).toBeUndefined();
    expect(moves.c).toBeUndefined();
  });

  it("spreads vertically", () => {
    const objects = objectsOf(
      shape("a", 0, 0, 10, 10),
      shape("b", 0, 30, 10, 10),
      shape("c", 0, 100, 10, 10),
    );
    const moves = movesById(distributeMoves(objects, ["a", "b", "c"], "vertical"));
    expect(moves.b).toEqual({ dx: 0, dy: 20 });
  });

  it("needs three shapes", () => {
    const objects = objectsOf(shape("a", 0, 0, 10, 10), shape("b", 50, 0, 10, 10));
    expect(distributeMoves(objects, ["a", "b"], "horizontal")).toEqual([]);
  });

  it("drops shapes without a box from the count", () => {
    const bare = shape("d", 0, 0, 10, 10);
    delete bare["points"];
    delete bare["selrect"];
    const objects = objectsOf(
      shape("a", 0, 0, 10, 10),
      shape("b", 30, 0, 10, 10),
      bare,
    );
    expect(distributeMoves(objects, ["a", "b", "d"], "horizontal")).toEqual([]);
  });
});
