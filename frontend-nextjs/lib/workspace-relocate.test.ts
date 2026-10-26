// Unit tests for the generate-relocate companions of lib/workspace-relocate
// (F9.3 companion changes): hide-in-viewer, the layout-item cleanup, the
// component-root add/remove and the flex sizing fix, plus the layout helpers
// they rest on.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  changeHSizing,
  changeVSizing,
  layoutItemAttrsToRemove,
  unapplyLayoutItemTokens,
} from "@/lib/workspace-layout";
import { buildRelocateChanges } from "@/lib/workspace-relocate";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

const PAGE = "00000000-0000-0000-0000-0000000000ff";

function shape(id: string, type: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type, ...extra };
}

function rootShape(children: string[]): WorkspaceShape {
  return shape(ZERO_UUID, "frame", { shapes: children });
}

function frameShape(id: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return shape(id, "frame", {
    "parent-id": ZERO_UUID,
    "frame-id": ZERO_UUID,
    shapes: [],
    ...extra,
  });
}

function movChange(roots: readonly string[], target: string): Record<string, unknown> {
  return {
    type: "mov-objects",
    "page-id": PAGE,
    "parent-id": target,
    shapes: roots.slice().reverse(),
  };
}

describe("buildRelocateChanges", () => {
  it("hides a frame dropped inside another frame", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1"),
      f2: frameShape("f2"),
    };
    const changes = buildRelocateChanges(objects, ["f1"], "f2", PAGE);
    expect(changes).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "f1",
        operations: [{ type: "set", attr: "hide-in-viewer", val: true }],
      },
      movChange(["f1"], "f2"),
    ]);
  });

  it("leaves the flag alone on a drop into the zero root", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f2"]),
      f2: frameShape("f2", { shapes: ["f1"] }),
      f1: frameShape("f1", { "parent-id": "f2", "frame-id": "f2" }),
    };
    expect(buildRelocateChanges(objects, ["f1"], ZERO_UUID, PAGE)).toEqual([
      movChange(["f1"], ZERO_UUID),
    ]);
  });

  it("skips the flag when the frame already carries it", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1", { "hide-in-viewer": true }),
      f2: frameShape("f2"),
    };
    expect(buildRelocateChanges(objects, ["f1"], "f2", PAGE)).toEqual([
      movChange(["f1"], "f2"),
    ]);
  });

  it("removes the layout-item data and tokens, merged with the other ops", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1", { shapes: ["a"] }),
      f2: frameShape("f2"),
      a: shape("a", "frame", {
        "parent-id": "f1",
        "frame-id": "f1",
        "layout-item-margin": { m1: 1, m2: 2, m3: 3, m4: 4 },
        "layout-item-align-self": "center",
        "layout-item-absolute": true,
        "layout-item-z-index": 3,
        "layout-item-h-sizing": "fill",
        "applied-tokens": { "layout-item-min-w": "t1", m1: "t2", fill: "keep" },
      }),
    };
    const changes = buildRelocateChanges(objects, ["a"], "f2", PAGE);
    expect(changes).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "a",
        operations: [
          { type: "set", attr: "layout-item-margin", val: null },
          { type: "set", attr: "layout-item-align-self", val: null },
          { type: "set", attr: "layout-item-absolute", val: null },
          { type: "set", attr: "layout-item-z-index", val: null },
          { type: "set", attr: "layout-item-h-sizing", val: null },
          { type: "set", attr: "applied-tokens", val: { fill: "keep" } },
          { type: "set", attr: "hide-in-viewer", val: true },
        ],
      },
      movChange(["a"], "f2"),
    ]);
  });

  it("keeps the layout-item data when the target is a layout", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "flex"]),
      f1: frameShape("f1", { shapes: ["a"] }),
      flex: frameShape("flex", { layout: "flex", "layout-flex-dir": "column" }),
      a: shape("a", "rect", {
        "parent-id": "f1",
        "frame-id": "f1",
        "layout-item-margin": { m1: 1 },
      }),
    };
    expect(buildRelocateChanges(objects, ["a"], "flex", PAGE)).toEqual([
      movChange(["a"], "flex"),
    ]);
  });

  it("carries the flex drop index on the mov-objects change", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "flex"]),
      f1: frameShape("f1", { shapes: ["a"] }),
      flex: frameShape("flex", { layout: "flex", "layout-flex-dir": "row" }),
      a: shape("a", "rect", { "parent-id": "f1", "frame-id": "f1" }),
    };
    expect(buildRelocateChanges(objects, ["a"], "flex", PAGE, 2)).toEqual([
      { ...movChange(["a"], "flex"), index: 2 },
    ]);
  });

  it("fixes the sizing of the old flex parent", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["flex", "f2"]),
      flex: frameShape("flex", {
        layout: "flex",
        "layout-flex-dir": "column",
        "layout-item-h-sizing": "auto",
        "layout-item-v-sizing": "auto",
        shapes: ["a", "b"],
      }),
      a: shape("a", "rect", {
        "parent-id": "flex",
        "frame-id": "flex",
        "layout-item-h-sizing": "fill",
        "layout-item-v-sizing": "fill",
      }),
      b: shape("b", "rect", {
        "parent-id": "flex",
        "frame-id": "flex",
        "layout-item-h-sizing": "fill",
        "layout-item-v-sizing": "fill",
      }),
      f2: frameShape("f2"),
    };
    const changes = buildRelocateChanges(objects, ["a"], "f2", PAGE);
    expect(changes).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "a",
        operations: [
          { type: "set", attr: "layout-item-h-sizing", val: null },
          { type: "set", attr: "layout-item-v-sizing", val: null },
        ],
      },
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "flex",
        operations: [
          { type: "set", attr: "layout-item-h-sizing", val: "fix" },
          { type: "set", attr: "layout-item-v-sizing", val: "fix" },
        ],
      },
      movChange(["a"], "f2"),
    ]);
  });

  it("fixes the sizing of a layout target that gains a filling child", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "flex"]),
      f1: frameShape("f1", { shapes: ["r"] }),
      flex: frameShape("flex", {
        layout: "flex",
        "layout-flex-dir": "row",
        "layout-item-h-sizing": "auto",
        shapes: ["c"],
      }),
      c: shape("c", "rect", {
        "parent-id": "flex",
        "frame-id": "flex",
        "layout-item-h-sizing": "fill",
      }),
      r: shape("r", "rect", { "parent-id": "f1", "frame-id": "f1" }),
    };
    const changes = buildRelocateChanges(objects, ["r"], "flex", PAGE);
    expect(changes).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "flex",
        operations: [{ type: "set", attr: "layout-item-h-sizing", val: "fix" }],
      },
      movChange(["r"], "flex"),
    ]);
  });

  it("clears component-root when the drop lands inside an instance", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["inst", "loose"]),
      inst: shape("inst", "frame", {
        "parent-id": ZERO_UUID,
        "frame-id": ZERO_UUID,
        "component-id": "c1",
        "component-root": true,
        shapes: ["inner"],
      }),
      inner: shape("inner", "frame", { "parent-id": "inst", "frame-id": "inst" }),
      loose: shape("loose", "frame", {
        "parent-id": ZERO_UUID,
        "frame-id": ZERO_UUID,
        "component-id": "c2",
        "component-root": true,
        shapes: ["sub"],
      }),
      sub: shape("sub", "rect", {
        "parent-id": "loose",
        "frame-id": "loose",
        "component-id": "c3",
        "component-root": true,
      }),
    };
    const changes = buildRelocateChanges(objects, ["loose"], "inner", PAGE);
    expect(changes).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "loose",
        operations: [
          { type: "set", attr: "hide-in-viewer", val: true },
          { type: "set", attr: "component-root", val: null },
        ],
      },
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "sub",
        operations: [{ type: "set", attr: "component-root", val: null }],
      },
      movChange(["loose"], "inner"),
    ]);
  });

  it("roots the moved instance heads when the drop lands outside", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1"]),
      f1: frameShape("f1", { shapes: ["head"] }),
      head: shape("head", "frame", {
        "parent-id": "f1",
        "frame-id": "f1",
        "component-id": "c1",
        shapes: ["body"],
      }),
      body: shape("body", "rect", { "parent-id": "head", "frame-id": "head" }),
    };
    expect(buildRelocateChanges(objects, ["head"], ZERO_UUID, PAGE)).toEqual([
      {
        type: "mod-obj",
        "page-id": PAGE,
        id: "head",
        operations: [{ type: "set", attr: "component-root", val: true }],
      },
      movChange(["head"], ZERO_UUID),
    ]);
  });

  it("sends nothing for an empty, missing or invalid move", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["f1", "f2"]),
      f1: frameShape("f1", { shapes: ["inner"] }),
      inner: frameShape("inner", { "parent-id": "f1", "frame-id": "f1" }),
      f2: frameShape("f2"),
    };
    expect(buildRelocateChanges(objects, [], "f2", PAGE)).toEqual([]);
    expect(buildRelocateChanges(objects, ["missing"], "f2", PAGE)).toEqual([]);
    expect(buildRelocateChanges(objects, ["f1"], "missing", PAGE)).toEqual([]);
    // The target sits inside the moved subtree.
    expect(buildRelocateChanges(objects, ["f1"], "inner", PAGE)).toEqual([]);
  });

  it("sends the mov-objects last with the reversed roots", () => {
    const objects: WorkspaceObjects = {
      [ZERO_UUID]: rootShape(["loose"]),
      f1: frameShape("f1", { shapes: ["leaf"] }),
      f2: frameShape("f2"),
      loose: shape("loose", "rect", { "parent-id": ZERO_UUID, "frame-id": ZERO_UUID }),
      leaf: shape("leaf", "rect", { "parent-id": "f1", "frame-id": "f1" }),
    };
    const changes = buildRelocateChanges(objects, ["loose", "leaf"], "f2", PAGE);
    expect(changes).toEqual([movChange(["loose", "leaf"], "f2")]);
  });
});

describe("layout helpers", () => {
  it("keeps the sizing of a nested layout unless it fills the axis", () => {
    const nested = shape("n", "frame", {
      layout: "flex",
      "layout-item-h-sizing": "auto",
      "layout-item-v-sizing": "fill",
      "layout-item-margin": { m1: 1 },
    });
    const attrs = layoutItemAttrsToRemove(nested);
    expect(attrs).toContain("layout-item-margin");
    expect(attrs).toContain("layout-item-v-sizing");
    expect(attrs).not.toContain("layout-item-h-sizing");
    // A plain shape loses both sizing axes.
    const plain = shape("p", "rect", {
      "layout-item-h-sizing": "auto",
      "layout-item-v-sizing": "auto",
    });
    expect(layoutItemAttrsToRemove(plain)).toContain("layout-item-h-sizing");
    expect(layoutItemAttrsToRemove(plain)).toContain("layout-item-v-sizing");
  });

  it("prunes only the layout-item tokens", () => {
    const withTokens = shape("s", "rect", {
      "applied-tokens": { fill: "t1", "layout-item-min-w": "t2", m2: "t3" },
    });
    expect(unapplyLayoutItemTokens(withTokens)).toEqual({ fill: "t1" });
    expect(unapplyLayoutItemTokens(shape("s", "rect"))).toBeNull();
    expect(unapplyLayoutItemTokens(shape("s", "rect", { "applied-tokens": {} }))).toBeNull();
  });

  it("filters the absolute children on the horizontal sizing only", () => {
    const objects: WorkspaceObjects = {
      col: shape("col", "frame", {
        layout: "flex",
        "layout-flex-dir": "column",
        "layout-item-h-sizing": "auto",
        shapes: ["abs", "plain"],
      }),
      abs: shape("abs", "rect", {
        "layout-item-h-sizing": "fix",
        "layout-item-absolute": true,
      }),
      plain: shape("plain", "rect", { "layout-item-h-sizing": "fill" }),
    };
    // Every non-absolute child fills the width; the absolute one is ignored.
    expect(changeHSizing(objects, "col", ["abs", "plain"])).toBe(true);

    const vertical: WorkspaceObjects = {
      col: shape("col", "frame", {
        layout: "flex",
        "layout-flex-dir": "column",
        "layout-item-v-sizing": "auto",
        shapes: ["abs", "plain"],
      }),
      abs: shape("abs", "rect", {
        "layout-item-v-sizing": "fill",
        "hidden": true,
      }),
      plain: shape("plain", "rect", { "layout-item-v-sizing": "fix" }),
    };
    // The vertical branch does not filter: the hidden (absolute) child still
    // counts as a filling child.
    expect(changeVSizing(vertical, "col", ["abs", "plain"])).toBe(true);
  });

  it("reports a horizontal change for an empty auto-width column", () => {
    const objects: WorkspaceObjects = {
      col: shape("col", "frame", {
        layout: "flex",
        "layout-flex-dir": "column",
        "layout-item-h-sizing": "auto",
      }),
    };
    // CLJS every? over an empty list answers true.
    expect(changeHSizing(objects, "col", [])).toBe(true);
    expect(changeVSizing(objects, "col", [])).toBe(false);
  });
});
