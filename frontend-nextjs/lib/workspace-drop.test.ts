// Unit tests for the flex drop-index of lib/workspace-drop (F9.3
// drop-index): the slot mapping of the CLJS get-drop-index over one layout
// line, for both the normal and the reverse directions, the hidden/absolute
// filtering and the fallbacks.

import { describe, expect, it } from "vitest";

import { dropIndexForFrame } from "@/lib/workspace-drop";
import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

function frame(id: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type: "frame", ...extra };
}

function rect(
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
    selrect: { x, y, width, height },
    ...extra,
  };
}

describe("dropIndexForFrame", () => {
  it("maps a normal row from the list tail to the list head", () => {
    // The tail of the children list is the first item of the flow: c sits
    // left, b in the middle and a right.
    const objects: WorkspaceObjects = {
      flex: frame("flex", { layout: "flex", "layout-flex-dir": "row", shapes: ["a", "b", "c"] }),
      c: rect("c", 0, 0, 80, 40),
      b: rect("b", 100, 0, 80, 40),
      a: rect("a", 200, 0, 80, 40),
    };
    // Left half of c: before the first flow child, index 2 + 1.
    expect(dropIndexForFrame(objects, "flex", { x: 10, y: 10 })).toBe(3);
    // The exact center belongs to the half before the center.
    expect(dropIndexForFrame(objects, "flex", { x: 40, y: 10 })).toBe(3);
    // Right half of c / left half of b: between c and b.
    expect(dropIndexForFrame(objects, "flex", { x: 90, y: 10 })).toBe(2);
    // At the center of a: before a, index 0 + 1.
    expect(dropIndexForFrame(objects, "flex", { x: 240, y: 10 })).toBe(1);
    // Past the last flow child (the far right end): the list head.
    expect(dropIndexForFrame(objects, "flex", { x: 300, y: 10 })).toBe(0);
  });

  it("maps a row-reverse in list order", () => {
    // A reverse row lays the children in list order: a left, b middle,
    // c right.
    const objects: WorkspaceObjects = {
      flex: frame("flex", {
        layout: "flex",
        "layout-flex-dir": "row-reverse",
        shapes: ["a", "b", "c"],
      }),
      a: rect("a", 0, 0, 80, 40),
      b: rect("b", 100, 0, 80, 40),
      c: rect("c", 200, 0, 80, 40),
    };
    expect(dropIndexForFrame(objects, "flex", { x: 10, y: 10 })).toBe(0);
    expect(dropIndexForFrame(objects, "flex", { x: 90, y: 10 })).toBe(1);
    // Right half of b: after b, index 1 + 1.
    expect(dropIndexForFrame(objects, "flex", { x: 150, y: 10 })).toBe(2);
    // Past the last flow child: the children count.
    expect(dropIndexForFrame(objects, "flex", { x: 300, y: 10 })).toBe(3);
  });

  it("uses the vertical axis on a column and its reverse", () => {
    const column: WorkspaceObjects = {
      flex: frame("flex", {
        layout: "flex",
        "layout-flex-dir": "column",
        shapes: ["a", "b", "c"],
      }),
      c: rect("c", 0, 0, 80, 40),
      b: rect("b", 0, 100, 80, 40),
      a: rect("a", 0, 200, 80, 40),
    };
    expect(dropIndexForFrame(column, "flex", { x: 500, y: 10 })).toBe(3);
    expect(dropIndexForFrame(column, "flex", { x: 500, y: 300 })).toBe(0);

    const reverse: WorkspaceObjects = {
      flex: frame("flex", {
        layout: "flex",
        "layout-flex-dir": "column-reverse",
        shapes: ["a", "b", "c"],
      }),
      a: rect("a", 0, 0, 80, 40),
      b: rect("b", 0, 100, 80, 40),
      c: rect("c", 0, 200, 80, 40),
    };
    expect(dropIndexForFrame(reverse, "flex", { x: 500, y: 10 })).toBe(0);
    expect(dropIndexForFrame(reverse, "flex", { x: 500, y: 300 })).toBe(3);
  });

  it("skips the hidden and absolute children but keeps their list slots", () => {
    const objects: WorkspaceObjects = {
      flex: frame("flex", { layout: "flex", "layout-flex-dir": "row", shapes: ["a", "abs", "b"] }),
      b: rect("b", 0, 0, 80, 40),
      abs: rect("abs", 100, 0, 80, 40, { "layout-item-absolute": true }),
      hidden: rect("hidden", 100, 60, 80, 40, { hidden: true }),
      a: rect("a", 200, 0, 80, 40),
    };
    // b is the list tail (index 2): its left half maps to 3.
    expect(dropIndexForFrame(objects, "flex", { x: 10, y: 10 })).toBe(3);
    // The pointer past b and inside the slot of the absolute child lands
    // before a (index 0), not before the absolute entry (index 1).
    expect(dropIndexForFrame(objects, "flex", { x: 150, y: 10 })).toBe(1);
    expect(dropIndexForFrame(objects, "flex", { x: 250, y: 10 })).toBe(0);
  });

  it("falls back to x/y + width/height when the selrect is incomplete", () => {
    const objects: WorkspaceObjects = {
      flex: frame("flex", { layout: "flex", "layout-flex-dir": "row", shapes: ["a"] }),
      a: { id: "a", type: "rect", x: 0, y: 0, width: 80, height: 40 },
    };
    expect(dropIndexForFrame(objects, "flex", { x: 10, y: 10 })).toBe(1);
    expect(dropIndexForFrame(objects, "flex", { x: 90, y: 10 })).toBe(0);
  });

  it("returns null when the frame is missing, not a flex or has no flow child", () => {
    const objects: WorkspaceObjects = {
      plain: frame("plain", { shapes: ["a"] }),
      empty: frame("empty", { layout: "flex", "layout-flex-dir": "row", shapes: [] }),
      onlyAbsolute: frame("onlyAbsolute", {
        layout: "flex",
        "layout-flex-dir": "row",
        shapes: ["abs"],
      }),
      a: rect("a", 0, 0, 80, 40),
      abs: rect("abs", 100, 0, 80, 40, { "layout-item-absolute": true }),
      [ZERO_UUID]: frame(ZERO_UUID, { layout: "flex", "layout-flex-dir": "row", shapes: ["a"] }),
    };
    expect(dropIndexForFrame(objects, "missing", { x: 0, y: 0 })).toBeNull();
    expect(dropIndexForFrame(objects, "plain", { x: 0, y: 0 })).toBeNull();
    expect(dropIndexForFrame(objects, "empty", { x: 0, y: 0 })).toBeNull();
    expect(dropIndexForFrame(objects, "onlyAbsolute", { x: 0, y: 0 })).toBeNull();
  });

  it("skips the children without usable geometry", () => {
    const objects: WorkspaceObjects = {
      flex: frame("flex", { layout: "flex", "layout-flex-dir": "row", shapes: ["a", "broken", "b"] }),
      b: rect("b", 0, 0, 80, 40),
      broken: { id: "broken", type: "rect" },
      a: rect("a", 100, 0, 80, 40),
    };
    // The broken entry is not a flow slot, but its list index still counts.
    expect(dropIndexForFrame(objects, "flex", { x: 10, y: 10 })).toBe(3);
    expect(dropIndexForFrame(objects, "flex", { x: 90, y: 10 })).toBe(1);

    const allBroken: WorkspaceObjects = {
      flex: frame("flex", {
        layout: "flex",
        "layout-flex-dir": "row",
        shapes: ["broken"],
      }),
      broken: { id: "broken", type: "rect" },
    };
    expect(dropIndexForFrame(allBroken, "flex", { x: 0, y: 0 })).toBeNull();
  });
});
