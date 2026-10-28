// The guides menu of lib/workspace-guides.ts: the :grids of a frame, the
// defaults of a new grid and the pure surgery behind the type / size / gutter
// / margin / item-length / color / eye rows.

import { describe, expect, it } from "vitest";

import {
  addGuide,
  calculateDefaultItemLength,
  DEFAULT_LAYOUT_COLOR,
  DEFAULT_SQUARE_COLOR,
  defaultGridParams,
  guideColorOf,
  guidePatch,
  guidesOf,
  newGuide,
  removeGuide,
  withGuideColor,
  withGuideDisplay,
  withGuideItemLength,
  withGuideParams,
  withGuideSize,
  withGuideType,
} from "@/lib/workspace-guides";
import type { WorkspaceShape } from "@/lib/workspace";

function frame(id: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type: "frame", width: 400, height: 300, ...extra };
}

describe("defaultGridParams", () => {
  it("gives a square grid only a size and a color", () => {
    expect(defaultGridParams("square")).toEqual({
      size: 16,
      color: { ...DEFAULT_SQUARE_COLOR },
    });
  });

  it("gives a column grid the layout fields", () => {
    expect(defaultGridParams("column")).toEqual({
      size: 12,
      type: "stretch",
      "item-length": null,
      gutter: 8,
      margin: 0,
      color: { ...DEFAULT_LAYOUT_COLOR },
    });
  });

  it("returns a fresh color map per call", () => {
    const first = defaultGridParams("square");
    (first.color as Record<string, unknown>).color = "#000000";
    expect(defaultGridParams("square").color).toEqual(DEFAULT_SQUARE_COLOR);
  });
});

describe("newGuide", () => {
  it("starts square and shown", () => {
    expect(newGuide()).toEqual({
      type: "square",
      display: true,
      params: defaultGridParams("square"),
    });
  });
});

describe("guidesOf", () => {
  it("reads the stored grids", () => {
    const grids = [{ type: "column", display: false, params: { size: 4 } }];
    expect(guidesOf(frame("f", { grids }))).toEqual(grids);
  });

  it("skips a grid with an unknown type", () => {
    expect(guidesOf(frame("f", { grids: [{ type: "hex" }, { params: {} }] }))).toEqual([]);
  });

  it("defaults a missing display to shown and a missing params to an empty map", () => {
    expect(guidesOf(frame("f", { grids: [{ type: "row" }] }))).toEqual([
      { type: "row", display: true, params: {} },
    ]);
  });

  it("returns an empty list for a shape without grids", () => {
    expect(guidesOf(frame("f"))).toEqual([]);
  });
});

describe("addGuide / removeGuide", () => {
  it("appends a square grid", () => {
    const guides = addGuide([], "square");
    expect(guides).toEqual([newGuide("square")]);
  });

  it("splices the row at the index", () => {
    const guides = [newGuide("square"), newGuide("column"), newGuide("row")];
    expect(removeGuide(guides, 1).map((grid) => grid.type)).toEqual(["square", "row"]);
  });

  it("ignores an out-of-range index", () => {
    const guides = [newGuide("square")];
    expect(removeGuide(guides, 9)).toHaveLength(1);
  });
});

describe("withGuideType", () => {
  it("restarts the params of the new type", () => {
    const [grid] = withGuideType([newGuide("square")], 0, "column");
    expect(grid.type).toBe("column");
    expect(grid.params).toEqual(defaultGridParams("column"));
  });

  it("keeps the stored grid for an unknown type", () => {
    const [grid] = withGuideType([newGuide("square")], 0, "hex" as never);
    expect(grid.type).toBe("square");
  });
});

describe("withGuideDisplay", () => {
  it("writes the explicit boolean", () => {
    expect(withGuideDisplay([newGuide()], 0, false)[0].display).toBe(false);
  });
});

describe("withGuideParams / withGuideColor", () => {
  it("merges a params patch", () => {
    const [grid] = withGuideParams([newGuide("column")], 0, { gutter: 24, margin: 16 });
    expect(grid.params).toEqual({ ...defaultGridParams("column"), gutter: 24, margin: 16 });
  });

  it("writes the hex and keeps the stored opacity", () => {
    const [grid] = withGuideColor([newGuide("square")], 0, "#112233");
    expect(grid.params.color).toEqual({ color: "#112233", opacity: 0.4 });
  });

  it("clamps a typed opacity", () => {
    const [grid] = withGuideColor([newGuide("square")], 0, "#112233", 3);
    expect(guideColorOf(grid)).toEqual({ color: "#112233", opacity: 1 });
  });

  it("falls back to the type default when the color is missing", () => {
    expect(guideColorOf({ type: "row", display: true, params: {} })).toEqual({
      ...DEFAULT_LAYOUT_COLOR,
    });
  });
});

describe("calculateDefaultItemLength", () => {
  it("fits twelve items with a gutter between and around", () => {
    // (400 - (0 + (0 - 12)) - 12 * 12) / 12
    expect(calculateDefaultItemLength(400, 0, 12)).toBeCloseTo(22.3333, 4);
  });

  it("returns zero for a non-positive frame side", () => {
    expect(calculateDefaultItemLength(0, 0, 12)).toBe(0);
  });
});

describe("withGuideSize", () => {
  it("keeps the stored item length for a typed size", () => {
    const guides = withGuideItemLength([newGuide("column")], 0, 30);
    const [grid] = withGuideSize(guides, 0, 6, 400);
    expect(grid.params.size).toBe(6);
    expect(grid.params["item-length"]).toBe(30);
  });

  it("recomputes the item length for the auto option", () => {
    // (400 - (0 + (0 - 8)) - 8 * 12) / 12
    const [grid] = withGuideSize([newGuide("column")], 0, null, 400);
    expect(grid.params.size).toBeNull();
    expect(grid.params["item-length"]).toBeCloseTo(26, 4);
  });

  it("returns every grid when the index is out of range", () => {
    expect(withGuideSize([newGuide()], 4, 8, 400)).toHaveLength(1);
  });
});

describe("withGuideItemLength", () => {
  it("clears the item length on zero", () => {
    const [grid] = withGuideItemLength([newGuide("column")], 0, 0);
    expect(grid.params["item-length"]).toBeNull();
  });

  it("falls back to the twelve column size when both are empty", () => {
    const base = newGuide("column");
    const empty = { ...base, params: { ...base.params, size: null } };
    const [grid] = withGuideItemLength([empty], 0, null);
    expect(grid.params.size).toBe(12);
    expect(grid.params["item-length"]).toBeNull();
  });
});

describe("guidePatch", () => {
  it("returns a deep-enough copy", () => {
    const guides = [newGuide("square")];
    const patch = guidePatch(guides);
    (patch[0].params.color as Record<string, unknown>).color = "#000000";
    expect(guideColorOf(guides[0]).color).toBe(DEFAULT_SQUARE_COLOR.color);
  });
});
