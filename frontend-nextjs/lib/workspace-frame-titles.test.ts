// Unit tests for the frame title geometry (lib/workspace-frame-titles):
// the non-rotated case, the 90-degree case and the use-width rule, plus
// the top-level frame walk and the unusable-input cases.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  titleTransform,
  titleTransformUseWidth,
  topLevelFrames,
} from "@/lib/workspace-frame-titles";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

function frame(overrides: Partial<WorkspaceShape>): WorkspaceShape {
  return { id: "frame", type: "frame", name: "Frame", ...overrides };
}

// A 100 x 100 frame at the origin, points in the rect->points order.
const SQUARE_POINTS = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 100 },
  { x: 0, y: 100 },
];

// A 200 x 100 frame rotated 90 degrees around its center (100, 50); the
// points keep the rect->points order of the original corners.
const ROTATED_90_POINTS = [
  { x: 150, y: -50 },
  { x: 150, y: 150 },
  { x: 50, y: 150 },
  { x: 50, y: -50 },
];

describe("titleTransformUseWidth", () => {
  it("uses the width for rotations 0, 45 and 180", () => {
    expect(titleTransformUseWidth(frame({ rotation: 0 }))).toBe(true);
    expect(titleTransformUseWidth(frame({ rotation: 45 }))).toBe(true);
    expect(titleTransformUseWidth(frame({ rotation: 180 }))).toBe(true);
  });

  it("uses the height for rotations 46 and 90", () => {
    expect(titleTransformUseWidth(frame({ rotation: 46 }))).toBe(false);
    expect(titleTransformUseWidth(frame({ rotation: 90 }))).toBe(false);
  });

  it("defaults to the width when the rotation is missing", () => {
    expect(titleTransformUseWidth(frame({}))).toBe(true);
  });
});

describe("titleTransform", () => {
  it("places the label 10 screen pixels above a non-rotated frame", () => {
    const result = titleTransform(
      frame({ points: SQUARE_POINTS, rotation: 0 }),
      2,
    );

    expect(result).not.toBeNull();
    expect(result?.angle).toBeCloseTo(0, 5);
    expect(result?.pivotX).toBeCloseTo(0, 5);
    expect(result?.pivotY).toBeCloseTo(-5, 5);
    expect(result?.scale).toBeCloseTo(0.5, 5);
    expect(result?.translateX).toBeCloseTo(0, 5);
    expect(result?.translateY).toBeCloseTo(-10, 5);
  });

  it("keeps the label horizontal and constant-size on a 90-degree frame", () => {
    const result = titleTransform(
      frame({ points: ROTATED_90_POINTS, rotation: 90 }),
      1,
    );

    expect(result).not.toBeNull();
    expect(result?.angle).toBeCloseTo(0, 5);
    expect(result?.pivotX).toBeCloseTo(50, 5);
    expect(result?.pivotY).toBeCloseTo(-60, 5);
    expect(result?.scale).toBeCloseTo(1, 5);
    expect(result?.translateX).toBeCloseTo(50, 5);
    expect(result?.translateY).toBeCloseTo(-60, 5);
  });

  it("returns null without usable points", () => {
    expect(titleTransform(frame({}), 1)).toBeNull();
    expect(
      titleTransform(frame({ points: [{ x: 0, y: 0 }] }), 1),
    ).toBeNull();
  });

  it("returns null for a zero zoom", () => {
    expect(titleTransform(frame({ points: SQUARE_POINTS }), 0)).toBeNull();
  });
});

describe("topLevelFrames", () => {
  it("returns root frames in order and skips nested frames and non-frames", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: {
        id: ZERO_UUID,
        type: "root",
        shapes: ["board", "group", "missing"],
      },
      board: { id: "board", type: "frame", name: "Board" },
      group: { id: "group", type: "group", name: "Group", shapes: ["nested"] },
      nested: { id: "nested", type: "frame", name: "Nested" },
    };

    const frames = topLevelFrames(objects);

    expect(frames.map((shape) => shape.id)).toEqual(["board"]);
  });

  it("returns an empty list without a root", () => {
    expect(topLevelFrames({})).toEqual([]);
  });
});
