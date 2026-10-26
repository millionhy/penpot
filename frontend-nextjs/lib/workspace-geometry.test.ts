// The geometry segment of lib/workspace-geometry.ts: the values the style
// panel shows and the mod-obj a committed edit becomes. The expectations
// mirror change-dimensions-modifiers (world-axis scale around the first
// point), update-positions (a plain translation) and increase-rotation (a
// rotation around the selrect center).

import { describe, expect, it } from "vitest";

import {
  MIN_SIZE,
  buildGeometryChange,
  geometryEditable,
  geometryOf,
  selrectOf,
} from "@/lib/workspace-geometry";
import { applyUpdateChanges } from "@/lib/workspace-undo";
import { matrixRecord, IDENTITY_MATRIX } from "@/lib/workspace-transform";
import type { UpdateFileModObjChange } from "@/lib/transit";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

const PAGE_ID = "11111111-1111-1111-1111-111111111111";
const IDENTITY_RECORD = matrixRecord(IDENTITY_MATRIX);

function rectShape(extra: Record<string, unknown> = {}): WorkspaceShape {
  return {
    id: "rect-1",
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 },
    points: [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 50 },
      { x: 0, y: 50 },
    ],
    rotation: 0,
    transform: { ...IDENTITY_RECORD },
    "transform-inverse": { ...IDENTITY_RECORD },
    ...extra,
  };
}

// The attrs a change writes, as the local model would hold them.
function patchOf(change: UpdateFileModObjChange | null): Record<string, unknown> {
  if (change === null) return {};
  const patch: Record<string, unknown> = {};
  for (const operation of change.operations) patch[operation.attr] = operation.val;
  return patch;
}

function applyPatch(shape: WorkspaceShape, patch: Record<string, unknown>): WorkspaceShape {
  const objects: WorkspaceObjects = { [shape.id]: shape };
  const change: UpdateFileModObjChange = {
    type: "mod-obj",
    "page-id": PAGE_ID,
    id: shape.id,
    operations: Object.entries(patch).map(([attr, val]) => ({ type: "set", attr, val })),
  };
  return applyUpdateChanges(objects, [change])[shape.id];
}

describe("geometryOf", () => {
  it("reads the selrect size and the points origin", () => {
    expect(geometryOf(rectShape())).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      rotation: 0,
    });
  });

  it("reports the painted origin of a rotated shape", () => {
    const shape = rectShape({
      points: [
        { x: 25, y: 0 },
        { x: 75, y: 50 },
        { x: 25, y: 100 },
        { x: -25, y: 50 },
      ],
      rotation: 45,
    });
    expect(geometryOf(shape)).toEqual({
      x: -25,
      y: 0,
      width: 100,
      height: 50,
      rotation: 45,
    });
  });

  it("falls back to the selrect corners and rounds to two decimals", () => {
    const shape = rectShape({
      points: undefined,
      selrect: { x: 1.234, y: 5.678, width: 10, height: 20 },
    });
    expect(geometryOf(shape)).toEqual({ x: 1.23, y: 5.68, width: 10, height: 20, rotation: 0 });
  });

  it("returns null without a usable selrect", () => {
    expect(geometryOf(rectShape({ selrect: undefined }))).toBeNull();
    expect(geometryOf(rectShape({ selrect: { x: 0, y: 0 } }))).toBeNull();
  });
});

describe("selrectOf", () => {
  it("derives the edges", () => {
    expect(selrectOf(rectShape())).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 50,
      x1: 0,
      y1: 0,
      x2: 100,
      y2: 50,
    });
  });
});

describe("geometryEditable", () => {
  it("accepts a plain rect", () => {
    expect(geometryEditable(rectShape())).toBe(true);
  });

  it("rejects text, blocked shapes and shapes without a selrect", () => {
    expect(geometryEditable(rectShape({ type: "text" }))).toBe(false);
    expect(geometryEditable(rectShape({ blocked: true }))).toBe(false);
    expect(geometryEditable(rectShape({ selrect: undefined }))).toBe(false);
  });
});

describe("buildGeometryChange", () => {
  it("resizes around the first point, keeping the origin", () => {
    const shape = rectShape();
    const change = buildGeometryChange(shape, { width: 200 }, PAGE_ID);
    expect(change).not.toBeNull();
    const next = applyPatch(shape, patchOf(change));
    expect(next["width"]).toBeCloseTo(200, 6);
    expect(next["x"]).toBeCloseTo(0, 6);
    expect(next["y"]).toBeCloseTo(0, 6);
    expect(next["height"]).toBeCloseTo(50, 6);
    expect(next.selrect).toMatchObject({ x: 0, y: 0, width: 200, height: 50 });
    expect(next.points).toEqual([
      { x: 0, y: 0 },
      { x: 200, y: 0 },
      { x: 200, y: 50 },
      { x: 0, y: 50 },
    ]);
  });

  it("translates when x or y changes", () => {
    const shape = rectShape();
    const change = buildGeometryChange(shape, { x: 40 }, PAGE_ID);
    const next = applyPatch(shape, patchOf(change));
    expect(next["x"]).toBeCloseTo(40, 6);
    expect(next["y"]).toBeCloseTo(0, 6);
    expect(next.selrect).toMatchObject({ x: 40, y: 0, width: 100, height: 50 });
    expect(next.rotation).toBeCloseTo(0, 6);
  });

  it("moves only the requested axis", () => {
    const shape = rectShape();
    const change = buildGeometryChange(shape, { y: -15 }, PAGE_ID);
    const next = applyPatch(shape, patchOf(change));
    expect(next["x"]).toBeCloseTo(0, 6);
    expect(next["y"]).toBeCloseTo(-15, 6);
    expect(next.selrect).toMatchObject({ x: 0, y: -15, width: 100, height: 50 });
  });

  it("rotates around the selrect center and stores the absolute angle", () => {
    const shape = rectShape();
    const change = buildGeometryChange(shape, { rotation: 90 }, PAGE_ID);
    const next = applyPatch(shape, patchOf(change));
    expect(patchOf(change).rotation).toBeCloseTo(90, 6);
    expect(next.selrect).toMatchObject({ x: 0, y: 0, width: 100, height: 50 });
    const points = next.points as Array<{ x: number; y: number }>;
    expect(points[0].x).toBeCloseTo(75, 6);
    expect(points[0].y).toBeCloseTo(-25, 6);
    expect(points[1].x).toBeCloseTo(75, 6);
    expect(points[1].y).toBeCloseTo(75, 6);
  });

  it("normalizes a >180 degree target into the stored range", () => {
    const change = buildGeometryChange(rectShape({ rotation: 350 }), { rotation: 10 }, PAGE_ID);
    const patch = patchOf(change);
    // 350 -> 10 is a +20 delta, stored as 370 % 360 = 10.
    expect(patch.rotation).toBeCloseTo(10, 6);
    expect(patch.rotation).toBeGreaterThanOrEqual(0);
  });

  it("applies size, rotation and position in one change", () => {
    const shape = rectShape();
    const change = buildGeometryChange(
      shape,
      { x: 10, y: 20, width: 50, height: 25, rotation: 90 },
      PAGE_ID,
    );
    const next = applyPatch(shape, patchOf(change));
    const rect = next.selrect as Record<string, number>;
    expect(rect.width).toBeCloseTo(50, 6);
    expect(rect.height).toBeCloseTo(25, 6);
    expect(next.rotation).toBeCloseTo(90, 6);
    const geometry = geometryOf(next);
    expect(geometry?.x).toBeCloseTo(10, 2);
    expect(geometry?.y).toBeCloseTo(20, 2);
  });

  it("clamps a zero size to the panel minimum", () => {
    const change = buildGeometryChange(rectShape(), { width: 0 }, PAGE_ID);
    const patch = patchOf(change);
    expect(patch.width).toBeCloseTo(MIN_SIZE, 6);
  });

  it("sends nothing when the target matches the current geometry", () => {
    expect(buildGeometryChange(rectShape(), { x: 0, y: 0 }, PAGE_ID)).toBeNull();
    expect(buildGeometryChange(rectShape(), { width: 100, height: 50 }, PAGE_ID)).toBeNull();
    expect(buildGeometryChange(rectShape(), { rotation: 0 }, PAGE_ID)).toBeNull();
    expect(buildGeometryChange(rectShape(), {}, PAGE_ID)).toBeNull();
  });

  it("refuses a shape whose geometry this slice cannot rewrite", () => {
    expect(buildGeometryChange(rectShape({ type: "text" }), { width: 20 }, PAGE_ID)).toBeNull();
    expect(buildGeometryChange(rectShape({ blocked: true }), { width: 20 }, PAGE_ID)).toBeNull();
  });

  it("never carries the id or the page beyond the change envelope", () => {
    const change = buildGeometryChange(rectShape(), { width: 120 }, PAGE_ID);
    expect(change?.id).toBe("rect-1");
    expect(change?.["page-id"]).toBe(PAGE_ID);
    for (const operation of change?.operations ?? []) {
      expect(["id", "page-id", "type"]).not.toContain(operation.attr);
    }
  });
});
