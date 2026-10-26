// Unit tests for the layout and constraint attribute model
// (lib/workspace-layout-attrs): the enum defaults, the complete maps the
// wire replaces, the layout-item values and the measures locks. The module
// is pure, so every branch runs in node.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceShape } from "@/lib/workspace";
import {
  CONSTRAINT_ATTRS,
  LAYOUT_ATTRS,
  LAYOUT_ITEM_ATTRS,
  constraintPatch,
  constraintsOf,
  defaultTrack,
  fixedScrollVisible,
  gapPatch,
  inFrameForConstraints,
  layoutItemValues,
  layoutKindOf,
  layoutPatch,
  layoutValues,
  marginPatch,
  measureLocks,
  paddingPatch,
  removeLayoutPatch,
  simpleQuad,
  trackOf,
  trackPatch,
  tracksPatch,
} from "@/lib/workspace-layout-attrs";

function shape(attrs: Record<string, unknown> = {}): WorkspaceShape {
  return { id: "shape-1", type: "frame", ...attrs };
}

describe("layout kind and values", () => {
  it("only reads a layout off a frame", () => {
    expect(layoutKindOf(shape({ layout: "flex" }))).toBe("flex");
    expect(layoutKindOf(shape({ layout: "grid" }))).toBe("grid");
    expect(layoutKindOf(shape({ layout: "flex", type: "rect" }))).toBeNull();
    expect(layoutKindOf(shape())).toBeNull();
  });

  it("reads the flex values with the initializer defaults", () => {
    const values = layoutValues(shape({ layout: "flex" }));
    expect(values).toEqual({
      kind: "flex",
      direction: "row",
      wrap: "nowrap",
      gapType: "multiple",
      rowGap: 0,
      columnGap: 0,
      alignItems: "start",
      alignContent: "stretch",
      justifyContent: "start",
      justifyItems: "start",
      paddingType: "simple",
      padding: [0, 0, 0, 0],
      rows: [],
      columns: [],
    });
  });

  it("reads the grid defaults with its own justify-content", () => {
    const values = layoutValues(shape({ layout: "grid" }));
    expect(values.kind).toBe("grid");
    expect(values.justifyContent).toBe("stretch");
    expect(values.direction).toBe("row");
  });

  it("reads the stored gap, padding and tracks", () => {
    const values = layoutValues(
      shape({
        layout: "grid",
        "layout-grid-dir": "column",
        "layout-gap-type": "simple",
        "layout-gap": { "row-gap": 8, "column-gap": 8 },
        "layout-padding-type": "multiple",
        "layout-padding": { p1: 1, p2: 2, p3: 3, p4: 4 },
        "layout-grid-rows": [{ type: "fixed", value: 40 }, { type: "auto" }],
      }),
    );
    expect(values.direction).toBe("column");
    expect(values.gapType).toBe("simple");
    expect(values.rowGap).toBe(8);
    expect(values.columnGap).toBe(8);
    expect(values.padding).toEqual([1, 2, 3, 4]);
    expect(values.rows).toEqual([{ type: "fixed", value: 40 }, { type: "auto" }]);
  });
});

describe("layout patches", () => {
  it("builds the flex initializer", () => {
    expect(layoutPatch("flex")).toEqual({
      layout: "flex",
      "layout-flex-dir": "row",
      "layout-gap-type": "multiple",
      "layout-gap": { "row-gap": 0, "column-gap": 0 },
      "layout-align-items": "start",
      "layout-justify-content": "start",
      "layout-align-content": "stretch",
      "layout-wrap-type": "nowrap",
      "layout-padding-type": "simple",
      "layout-padding": { p1: 0, p2: 0, p3: 0, p4: 0 },
    });
  });

  it("builds the grid initializer with the empty cells map", () => {
    const patch = layoutPatch("grid");
    expect(patch["layout"]).toBe("grid");
    expect(patch["layout-grid-dir"]).toBe("row");
    expect(patch["layout-justify-items"]).toBe("start");
    expect(patch["layout-justify-content"]).toBe("stretch");
    expect(patch["layout-grid-cells"]).toEqual({});
    expect(patch["layout-grid-rows"]).toEqual([]);
    expect(patch["layout-grid-columns"]).toEqual([]);
  });

  it("clears every layout attribute, grid keys included", () => {
    const patch = removeLayoutPatch();
    expect(Object.keys(patch)).toEqual([...LAYOUT_ATTRS]);
    for (const attr of LAYOUT_ATTRS) expect(patch[attr]).toBeNull();
    expect(patch["layout-grid-rows"]).toBeNull();
    expect(patch["layout-grid-cells"]).toBeNull();
  });

  it("keeps both gaps equal in the simple mode", () => {
    expect(gapPatch("simple", 8, 99)).toEqual({
      "layout-gap-type": "simple",
      "layout-gap": { "row-gap": 8, "column-gap": 8 },
    });
    expect(gapPatch("multiple", 8, 12)).toEqual({
      "layout-gap-type": "multiple",
      "layout-gap": { "row-gap": 8, "column-gap": 12 },
    });
  });

  it("sends the complete padding and margin maps", () => {
    expect(paddingPatch("simple", simpleQuad(4, 8))).toEqual({
      "layout-padding-type": "simple",
      "layout-padding": { p1: 4, p2: 8, p3: 4, p4: 8 },
    });
    expect(marginPatch("multiple", [1, 2, 3, 4])).toEqual({
      "layout-item-margin-type": "multiple",
      "layout-item-margin": { m1: 1, m2: 2, m3: 3, m4: 4 },
    });
  });

  it("clamps negative gaps and paddings to zero", () => {
    expect(gapPatch("multiple", -2, -3)["layout-gap"]).toEqual({
      "row-gap": 0,
      "column-gap": 0,
    });
    expect(paddingPatch("multiple", [-1, -2, -3, -4])["layout-padding"]).toEqual({
      p1: 0,
      p2: 0,
      p3: 0,
      p4: 0,
    });
  });
});

describe("grid tracks", () => {
  it("defaults to the flex track", () => {
    expect(defaultTrack()).toEqual({ type: "flex", value: 1 });
    expect(trackOf(null)).toEqual({ type: "flex", value: 1 });
    expect(trackOf({ type: "nope", value: 3 })).toEqual({ type: "flex", value: 1 });
  });

  it("reads a stored track and drops the value of auto", () => {
    expect(trackOf({ type: "fixed", value: 40 })).toEqual({ type: "fixed", value: 40 });
    expect(trackOf({ type: "auto", value: 40 })).toEqual({ type: "auto" });
  });

  it("builds a track from the select and the value", () => {
    expect(trackPatch("percent", 50)).toEqual({ type: "percent", value: 50 });
    expect(trackPatch("auto", null)).toEqual({ type: "auto" });
    expect(trackPatch("flex", 2)).toEqual({ type: "flex", value: 2 });
    expect(trackPatch("bogus", null)).toEqual({ type: "flex", value: 1 });
  });

  it("builds the axis patch", () => {
    expect(tracksPatch("rows", [{ type: "flex", value: 1 }])).toEqual({
      "layout-grid-rows": [{ type: "flex", value: 1 }],
    });
    expect(tracksPatch("columns", [])).toEqual({ "layout-grid-columns": [] });
  });
});

describe("layout item values", () => {
  it("reads the defaults", () => {
    expect(layoutItemValues(shape())).toEqual({
      hSizing: "fix",
      vSizing: "fix",
      alignSelf: "stretch",
      absolute: false,
      zIndex: 0,
      minW: null,
      minH: null,
      maxW: null,
      maxH: null,
      marginType: "simple",
      margin: [0, 0, 0, 0],
    });
  });

  it("reads the stored values", () => {
    const values = layoutItemValues(
      shape({
        "layout-item-h-sizing": "fill",
        "layout-item-v-sizing": "auto",
        "layout-item-align-self": "center",
        "layout-item-absolute": true,
        "layout-item-z-index": 3,
        "layout-item-min-w": 10,
        "layout-item-margin-type": "multiple",
        "layout-item-margin": { m1: 1, m2: 2, m3: 3, m4: 4 },
      }),
    );
    expect(values.hSizing).toBe("fill");
    expect(values.vSizing).toBe("auto");
    expect(values.alignSelf).toBe("center");
    expect(values.absolute).toBe(true);
    expect(values.zIndex).toBe(3);
    expect(values.minW).toBe(10);
    expect(values.minH).toBeNull();
    expect(values.marginType).toBe("multiple");
    expect(values.margin).toEqual([1, 2, 3, 4]);
  });

  it("names every layout-item attribute once", () => {
    expect(new Set(LAYOUT_ITEM_ATTRS).size).toBe(LAYOUT_ITEM_ATTRS.length);
    expect(LAYOUT_ITEM_ATTRS).toContain("layout-item-h-sizing");
    expect(LAYOUT_ITEM_ATTRS).toContain("layout-item-absolute");
  });
});

describe("constraints", () => {
  const frame = shape({ id: "frame-1" });

  it("hides the menu on the root board", () => {
    expect(inFrameForConstraints(shape({ "parent-id": ZERO_UUID }))).toBe(false);
    expect(inFrameForConstraints(shape())).toBe(false);
    expect(inFrameForConstraints(shape({ "parent-id": "frame-1" }))).toBe(true);
  });

  it("derives the defaults from the parent type", () => {
    expect(constraintsOf(shape({ "parent-id": "frame-1" }), frame)).toEqual({
      h: "left",
      v: "top",
      fixedScroll: false,
    });
    expect(constraintsOf(shape({ "parent-id": "group-1" }), shape({ type: "group" }))).toEqual(
      {
        h: "scale",
        v: "scale",
        fixedScroll: false,
      },
    );
    expect(constraintsOf(shape({ "parent-id": "frame-1" }), null)).toEqual({
      h: "scale",
      v: "scale",
      fixedScroll: false,
    });
  });

  it("keeps the stored values and the fixed-scroll flag", () => {
    expect(
      constraintsOf(
        shape({ "parent-id": "frame-1", "constraints-h": "leftright", "fixed-scroll": true }),
        frame,
      ),
    ).toEqual({ h: "leftright", v: "top", fixedScroll: true });
  });

  it("shows fixed-scroll only for a first-level child", () => {
    expect(
      fixedScrollVisible(shape({ "parent-id": "frame-1", "frame-id": "frame-1" })),
    ).toBe(true);
    expect(
      fixedScrollVisible(shape({ "parent-id": "group-1", "frame-id": "frame-1" })),
    ).toBe(false);
    expect(fixedScrollVisible(shape())).toBe(false);
  });

  it("builds the constraint patch and drops invalid values", () => {
    expect(constraintPatch("left", "top")).toEqual({
      "constraints-h": "left",
      "constraints-v": "top",
    });
    expect(constraintPatch(null, "topbottom")).toEqual({ "constraints-v": "topbottom" });
    expect(constraintPatch("bogus", "nope")).toEqual({});
  });

  it("names the three constraint attributes", () => {
    expect([...CONSTRAINT_ATTRS]).toEqual(["constraints-h", "constraints-v", "fixed-scroll"]);
  });
});

describe("measures locks", () => {
  const flexParent = shape({ id: "frame-1", layout: "flex" });

  it("locks the position of a non-absolute flex child", () => {
    expect(measureLocks(shape({ "parent-id": "frame-1" }), flexParent)).toEqual({
      position: true,
      width: false,
      height: false,
    });
  });

  it("keeps the position of an absolute flex child", () => {
    expect(
      measureLocks(
        shape({ "parent-id": "frame-1", "layout-item-absolute": true }),
        flexParent,
      ),
    ).toEqual({ position: false, width: false, height: false });
  });

  it("locks a fill width of a flex child or a flex container", () => {
    expect(
      measureLocks(shape({ "layout-item-h-sizing": "fill" }), flexParent),
    ).toMatchObject({ width: true, height: false });
    expect(
      measureLocks(
        shape({ layout: "flex", "layout-item-h-sizing": "auto" }),
        null,
      ),
    ).toMatchObject({ width: true, height: false });
  });

  it("keeps the sizing of a fill shape outside any flex parent", () => {
    expect(
      measureLocks(shape({ "layout-item-h-sizing": "fill" }), shape({ type: "group" })),
    ).toEqual({ position: false, width: false, height: false });
  });
});
