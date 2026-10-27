// Unit tests for lib/workspace-reflow.ts: which attribute edits ask the
// renderer for a reflow, and how its matrices become file changes. The
// layout algorithm itself is tested in render-wasm (cargo test), not here.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import { applyReflow, attrsAskReflow, reflowChanges, reflowEntries, reflowTargetIds } from "@/lib/workspace-reflow";
import {
  IDENTITY_MATRIX,
  matrixRecord,
  type Matrix6,
} from "@/lib/workspace-transform";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

// --- Fixtures ----------------------------------------------------------------

const SELRECT = { x: 0, y: 0, width: 100, height: 50, x1: 0, y1: 0, x2: 100, y2: 50 };
const POINTS = [
  { x: 0, y: 0 },
  { x: 100, y: 0 },
  { x: 100, y: 50 },
  { x: 0, y: 50 },
];

const IDENTITY_RECORD = matrixRecord(IDENTITY_MATRIX);

function rect(id: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return {
    id,
    type: "rect",
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    selrect: { ...SELRECT },
    points: POINTS.map((point) => ({ ...point })),
    rotation: 0,
    transform: { ...IDENTITY_RECORD },
    "transform-inverse": { ...IDENTITY_RECORD },
    ...extra,
  };
}

function page(rows: WorkspaceShape[]): WorkspaceObjects {
  return Object.fromEntries(rows.map((row) => [row.id, row]));
}

function moveX(value: number): Matrix6 {
  return [1, 0, 0, 1, value, 0];
}

// --- Trigger set -------------------------------------------------------------

describe("attrsAskReflow", () => {
  it("accepts the layout key and every layout-prefixed key", () => {
    for (const attr of [
      "layout",
      "layout-gap",
      "layout-padding",
      "layout-item-h-sizing",
      "layout-grid-cells",
      "layout-align-items",
    ]) {
      expect(attrsAskReflow({ [attr]: true })).toBe(true);
    }
  });

  it("rejects constraints and the other style attributes", () => {
    for (const attr of ["constraints-h", "opacity", "hidden", "r1", "fills"]) {
      expect(attrsAskReflow({ [attr]: true })).toBe(false);
    }
  });

  it("accepts one layout key in a mixed patch", () => {
    expect(attrsAskReflow({ opacity: 0.5, "layout-gap": { "row-gap": 4 } })).toBe(true);
  });
});

describe("reflowTargetIds", () => {
  it("keeps the edited layout shape and drops everything else", () => {
    const objects = page([rect("frame-1"), rect("rect-1")]);
    expect(
      reflowTargetIds(objects, [
        { id: "frame-1", attrs: { "layout-gap": { "row-gap": 4 } } },
        { id: "rect-1", attrs: { opacity: 0.5 } },
      ]),
    ).toEqual(["frame-1"]);
  });

  it("drops the root board, which lays out nothing", () => {
    const objects = page([rect(ZERO_UUID)]);
    expect(reflowTargetIds(objects, [{ id: ZERO_UUID, attrs: { layout: "flex" } }])).toEqual([]);
  });

  it("drops an id the model no longer has", () => {
    expect(reflowTargetIds(page([]), [{ id: "gone", attrs: { layout: "flex" } }])).toEqual([]);
  });

  it("asks once for repeated edits of one shape", () => {
    const objects = page([rect("frame-1")]);
    expect(
      reflowTargetIds(objects, [
        { id: "frame-1", attrs: { "layout-gap": { "row-gap": 1 } } },
        { id: "frame-1", attrs: { "layout-padding": { p1: 2, p2: 2, p3: 2, p4: 2 } } },
      ]),
    ).toEqual(["frame-1"]);
  });

  it("keeps the order of the first appearance", () => {
    const objects = page([rect("a"), rect("b")]);
    expect(
      reflowTargetIds(objects, [
        { id: "b", attrs: { layout: "grid" } },
        { id: "a", attrs: { layout: "flex" } },
      ]),
    ).toEqual(["b", "a"]);
  });
});

describe("reflowEntries", () => {
  it("marks every target with the identity transform", () => {
    expect(reflowEntries(["a", "b"])).toEqual([
      { id: "a", matrix: IDENTITY_MATRIX, rotation: 0 },
      { id: "b", matrix: IDENTITY_MATRIX, rotation: 0 },
    ]);
  });
});

// --- Result to changes -------------------------------------------------------

describe("reflowChanges", () => {
  it("turns one returned matrix into one mod-obj", () => {
    const objects = page([rect("rect-1")]);
    const changes = reflowChanges(objects, [["rect-1", moveX(10)]], "page-1");

    expect(changes).toHaveLength(1);
    const change = changes[0];
    expect(change.type).toBe("mod-obj");
    expect(change.id).toBe("rect-1");
    const operations = change.operations as Array<{ attr: string; val: unknown }>;
    const x = operations.find((operation) => operation.attr === "x");
    expect(x?.val).toBe(10);
  });

  it("drops a shape the renderer left in place", () => {
    const objects = page([rect("rect-1")]);
    expect(reflowChanges(objects, [["rect-1", IDENTITY_MATRIX]], "page-1")).toEqual([]);
  });

  it("ignores a shape the model no longer has", () => {
    expect(reflowChanges(page([]), [["gone", moveX(10)]], "page-1")).toEqual([]);
  });
});

describe("applyReflow", () => {
  it("moves the local shape like the returned matrix", () => {
    const objects = page([rect("rect-1")]);
    const next = applyReflow(objects, [["rect-1", moveX(10)]]);

    expect(next["rect-1"].x).toBe(10);
    expect(next["rect-1"].selrect).toMatchObject({ x: 10, width: 100 });
  });

  it("leaves the model untouched for an identity result", () => {
    const objects = page([rect("rect-1")]);
    const next = applyReflow(objects, [["rect-1", IDENTITY_MATRIX]]);
    expect(next["rect-1"].x).toBe(0);
  });
});
