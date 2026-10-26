// Unit tests for the drawing model (lib/workspace-draw): the threshold and
// modifier rules of drawing/box.cljs, the click fallback, the setup-shape
// defaults per type, the component-copy parent climb and the add-shape
// append. All pure: no wasm, no store.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  applyAddShape,
  clickDrawRect,
  createDrawShape,
  drawRectFromPoints,
  firstValidParent,
} from "@/lib/workspace-draw";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

const ORIGIN = { x: 0, y: 0 };
const STILL = { square: false, center: false };

function shape(id: string, type: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type, ...extra };
}

const RECT = { x: 10, y: 20, width: 30, height: 40 };

describe("drawRectFromPoints", () => {
  it("rejects a drag up to 10 screen pixels and accepts past it", () => {
    // 10 world units at zoom 1 is exactly the threshold, not past it.
    expect(drawRectFromPoints(ORIGIN, { x: 10, y: 0 }, 1, STILL)).toBeNull();
    expect(drawRectFromPoints(ORIGIN, { x: 10.01, y: 0 }, 1, STILL)).toEqual({
      x: 0,
      y: 0,
      width: 10.01,
      height: 0.01,
    });
    // The threshold scales with the zoom: 10 world units at zoom 2 = 20 px.
    expect(drawRectFromPoints(ORIGIN, { x: 10, y: 0 }, 2, STILL)).toEqual({
      x: 0,
      y: 0,
      width: 10,
      height: 0.01,
    });
  });

  it("normalizes a drag toward the top left to positive sides", () => {
    expect(drawRectFromPoints({ x: 100, y: 100 }, { x: 40, y: 70 }, 1, STILL)).toEqual({
      x: 40,
      y: 70,
      width: 60,
      height: 30,
    });
  });

  it("keeps a 0.01 floor on a perfectly axis-aligned drag", () => {
    expect(drawRectFromPoints(ORIGIN, { x: 50, y: 0 }, 1, STILL)).toEqual({
      x: 0,
      y: 0,
      width: 50,
      height: 0.01,
    });
  });

  it("squares the dominant axis with Shift", () => {
    expect(
      drawRectFromPoints(ORIGIN, { x: 100, y: 50 }, 1, { square: true, center: false }),
    ).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    // A negative secondary delta squares upward too.
    expect(
      drawRectFromPoints(ORIGIN, { x: 100, y: -50 }, 1, { square: true, center: false }),
    ).toEqual({ x: 0, y: -100, width: 100, height: 100 });
    // A dominant vertical delta widens the horizontal one.
    expect(
      drawRectFromPoints(ORIGIN, { x: 50, y: 100 }, 1, { square: true, center: false }),
    ).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("keeps sign(0) = 0: a zero secondary delta stays at the 0.01 floor", () => {
    expect(
      drawRectFromPoints({ x: 0, y: 0 }, { x: 100, y: 0 }, 1, {
        square: true,
        center: false,
      }),
    ).toEqual({ x: 0, y: 0, width: 100, height: 0.01 });
  });

  it("centers the rect on the press point with Alt", () => {
    expect(
      drawRectFromPoints({ x: 100, y: 100 }, { x: 150, y: 130 }, 1, {
        square: false,
        center: true,
      }),
    ).toEqual({ x: 50, y: 70, width: 100, height: 60 });
  });

  it("combines Shift and Alt", () => {
    expect(
      drawRectFromPoints({ x: 100, y: 100 }, { x: 150, y: 120 }, 1, {
        square: true,
        center: true,
      }),
    ).toEqual({ x: 50, y: 50, width: 100, height: 100 });
  });
});

describe("clickDrawRect", () => {
  it("builds a 100 x 100 rect centered on the press point", () => {
    expect(clickDrawRect({ x: 200, y: 300 })).toEqual({
      x: 150,
      y: 250,
      width: 100,
      height: 100,
    });
  });
});

describe("createDrawShape", () => {
  const ID = "shape-1";
  const PARENT = "frame-1";

  it("builds a complete rect with the setup-shape defaults", () => {
    const rect = createDrawShape("rect", RECT, PARENT, ID);
    expect(rect.id).toBe(ID);
    expect(rect.type).toBe("rect");
    expect(rect.name).toBe("Rectangle");
    expect(rect["parent-id"]).toBe(PARENT);
    expect(rect["frame-id"]).toBe(PARENT);
    expect(rect.x).toBe(10);
    expect(rect.y).toBe(20);
    expect(rect.width).toBe(30);
    expect(rect.height).toBe(40);
    expect(rect["selrect"]).toEqual({
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      x1: 10,
      y1: 20,
      x2: 40,
      y2: 60,
    });
    expect(rect.points).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
    expect(rect["fills"]).toEqual([{ "fill-color": "#B1B2B5", "fill-opacity": 1 }]);
    expect(rect["strokes"]).toEqual([]);
    expect(rect["r1"]).toBe(0);
    expect(rect["r2"]).toBe(0);
    expect(rect["r3"]).toBe(0);
    expect(rect["r4"]).toBe(0);
    expect(rect["transform"]).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(rect["transform-inverse"]).toEqual({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    expect(rect["transform"]).not.toBe(rect["transform-inverse"]);
    expect(rect["rotation"]).toBe(0);
    expect(rect["proportion"]).toBe(1);
    expect(rect["proportion-lock"]).toBe(false);
  });

  it("builds an ellipse as a circle without radius attrs", () => {
    const ellipse = createDrawShape("ellipse", RECT, PARENT, ID);
    expect(ellipse.type).toBe("circle");
    expect(ellipse.name).toBe("Ellipse");
    expect("r1" in ellipse).toBe(false);
    expect(ellipse["fills"]).toEqual([{ "fill-color": "#B1B2B5", "fill-opacity": 1 }]);
  });

  it("builds a board with the frame-only attrs", () => {
    const frame = createDrawShape("frame", RECT, ZERO_UUID, ID);
    expect(frame.type).toBe("frame");
    expect(frame.name).toBe("Board");
    expect(frame["fills"]).toEqual([{ "fill-color": "#FFFFFF", "fill-opacity": 1 }]);
    expect(frame["shapes"]).toEqual([]);
    expect(frame["hide-fill-on-export"]).toBe(false);
    expect(frame["hide-in-viewer"]).toBe(false);
    expect(frame["r1"]).toBe(0);
  });

  it("marks a nested frame hide-in-viewer", () => {
    const frame = createDrawShape("frame", RECT, PARENT, ID);
    expect(frame["hide-in-viewer"]).toBe(true);
  });
});

describe("firstValidParent", () => {
  const objects: WorkspaceObjects = {
    [ZERO_UUID]: shape(ZERO_UUID, "frame", { shapes: ["copy"] }),
    copy: shape("copy", "frame", {
      "parent-id": ZERO_UUID,
      "shape-ref": "component-1",
      shapes: ["variant"],
    }),
    variant: shape("variant", "frame", {
      "parent-id": "copy",
      "is-variant-container": true,
      shapes: [],
    }),
    plain: shape("plain", "rect", { "parent-id": ZERO_UUID }),
  };

  it("returns a plain shape as-is", () => {
    expect(firstValidParent(objects, "plain")?.id).toBe("plain");
    expect(firstValidParent(objects, ZERO_UUID)?.id).toBe(ZERO_UUID);
  });

  it("climbs out of a component copy", () => {
    expect(firstValidParent(objects, "copy")?.id).toBe(ZERO_UUID);
  });

  it("climbs out of a variant container and then a component copy", () => {
    expect(firstValidParent(objects, "variant")?.id).toBe(ZERO_UUID);
  });

  it("returns null when the chain leaves the objects map", () => {
    const orphan: WorkspaceObjects = {
      copy: shape("copy", "frame", { "shape-ref": "component-1", "parent-id": "gone" }),
    };
    expect(firstValidParent(orphan, "copy")).toBeNull();
    expect(firstValidParent(orphan, "missing")).toBeNull();
  });

  it("is cycle-safe", () => {
    const loop: WorkspaceObjects = {
      a: shape("a", "frame", { "shape-ref": "c1", "parent-id": "b" }),
      b: shape("b", "frame", { "shape-ref": "c2", "parent-id": "a" }),
    };
    expect(firstValidParent(loop, "a")).toBeNull();
  });
});

describe("applyAddShape", () => {
  function fixture(): WorkspaceObjects {
    return {
      [ZERO_UUID]: shape(ZERO_UUID, "frame", { shapes: ["existing"] }),
      existing: shape("existing", "rect", { "parent-id": ZERO_UUID }),
      frame: shape("frame", "frame", { shapes: [] }),
    };
  }

  it("appends the shape to the parent and keeps the inputs untouched", () => {
    const objects = fixture();
    const added = createDrawShape("rect", RECT, "frame", "new");
    const next = applyAddShape(objects, added, "frame");

    expect(next.new).toEqual(added);
    expect(next.frame.shapes).toEqual(["new"]);
    expect(next[ZERO_UUID]).toBe(objects[ZERO_UUID]);
    expect(objects.new).toBeUndefined();
    expect(objects.frame.shapes).toEqual([]);
  });

  it("normalizes a missing parent to the root", () => {
    const objects = fixture();
    const added = createDrawShape("rect", RECT, "gone", "new");
    const next = applyAddShape(objects, added, "gone");

    expect(next.new["parent-id"]).toBe(ZERO_UUID);
    expect(next.new["frame-id"]).toBe(ZERO_UUID);
    expect(next[ZERO_UUID].shapes).toEqual(["existing", "new"]);
  });

  it("does not append twice when the child is already listed", () => {
    const objects = fixture();
    objects.frame = { ...objects.frame, shapes: ["new"] };
    const added = createDrawShape("rect", RECT, "frame", "new");
    const next = applyAddShape(objects, added, "frame");

    expect(next.frame.shapes).toEqual(["new"]);
  });

  it("inserts at the requested index instead of the tail", () => {
    const objects = fixture();
    objects.frame = { ...objects.frame, shapes: ["a", "b"] };
    const added = createDrawShape("rect", RECT, "frame", "new");

    const next = applyAddShape(objects, added, "frame", 1);

    expect(next.frame.shapes).toEqual(["a", "new", "b"]);
  });
});
