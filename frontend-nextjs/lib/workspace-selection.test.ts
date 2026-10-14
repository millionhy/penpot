// Workspace selection and hover semantics (F9.2) unit tests. The module
// under test is the plain-TS port of the CLJS hover chain
// (viewport/hooks.cljs setup-hover-shapes), the click selection
// (data/workspace/selection.cljs select-shape) and the marquee query
// (select-shapes-by-current-selrect); every case pins the CLJS behaviour
// against a small fixture object table, without the CLJS runtime.

import { describe, expect, it, vi } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { createWorkspaceIndex } from "@/lib/workspace-index";
import {
  areaInitialSelection,
  cleanLoops,
  computeHoverStack,
  createHoverIdsCache,
  getParentIds,
  getParentsWithSelf,
  hiddenParentQmark,
  hoverQueryRect,
  hoverShapeId,
  hoverStackAt,
  queryHoverIds,
  selectionAfterArea,
  selectionAfterClick,
} from "@/lib/workspace-selection";

// --- Fixtures ---------------------------------------------------------------

function rectPoints(
  x: number,
  y: number,
  width: number,
  height: number,
): { x: number; y: number }[] {
  return [
    { x, y },
    { x: x + width, y },
    { x: x + width, y: y + height },
    { x, y: y + height },
  ];
}

function makeRect(
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
    "parent-id": "f1",
    "frame-id": "f1",
    x,
    y,
    width,
    height,
    points: rectPoints(x, y, width, height),
    selrect: { x, y, width, height },
    fills: [{ "fill-color": "#112233" }],
    strokes: [],
    ...extra,
  };
}

function makeFrame(
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  shapes: string[],
  extra: Record<string, unknown> = {},
): WorkspaceShape {
  return {
    id,
    type: "frame",
    "parent-id": "f1",
    "frame-id": "f1",
    "show-content": true,
    x,
    y,
    width,
    height,
    points: rectPoints(x, y, width, height),
    selrect: { x, y, width, height },
    shapes,
    ...extra,
  };
}

// A board (f1) with a plain rect (r1), a group (g1) holding a rect (r2)
// and a text (t1), a nested frame without fills (f2) holding r3, a nested
// frame with fills (f3), a blocked rect (d1) and a hidden group (g0)
// holding h1.
function baseObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["f1"] },
    f1: {
      id: "f1",
      type: "frame",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      "show-content": true,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      points: rectPoints(0, 0, 400, 300),
      selrect: { x: 0, y: 0, width: 400, height: 300 },
      shapes: ["r1", "g1", "f2", "f3", "d1", "g0"],
    },
    r1: makeRect("r1", 10, 10, 100, 50),
    g1: {
      id: "g1",
      type: "group",
      "parent-id": "f1",
      "frame-id": "f1",
      x: 200,
      y: 10,
      width: 100,
      height: 50,
      points: rectPoints(200, 10, 100, 50),
      selrect: { x: 200, y: 10, width: 100, height: 50 },
      shapes: ["r2", "t1"],
    },
    r2: makeRect("r2", 200, 10, 100, 50, { "parent-id": "g1" }),
    t1: {
      id: "t1",
      type: "text",
      "parent-id": "g1",
      "frame-id": "f1",
      x: 210,
      y: 20,
      width: 40,
      height: 10,
      points: rectPoints(210, 20, 40, 10),
      selrect: { x: 210, y: 20, width: 40, height: 10 },
      fills: [],
    },
    f2: makeFrame("f2", 50, 100, 100, 100, ["r3"], { fills: [] }),
    r3: makeRect("r3", 60, 110, 20, 20, { "parent-id": "f2" }),
    f3: makeFrame("f3", 150, 150, 80, 80, [], {
      fills: [{ "fill-color": "#445566" }],
    }),
    d1: makeRect("d1", 10, 220, 50, 50, { blocked: true }),
    g0: {
      id: "g0",
      type: "group",
      "parent-id": "f1",
      "frame-id": "f1",
      hidden: true,
      x: 250,
      y: 150,
      width: 50,
      height: 50,
      points: rectPoints(250, 150, 50, 50),
      selrect: { x: 250, y: 150, width: 50, height: 50 },
      shapes: ["h1"],
    },
    h1: makeRect("h1", 250, 150, 50, 50, { "parent-id": "g0" }),
  };
}

// A board with a bool (b1) whose painted bounds miss its child (r6): the
// child sits outside the visible area of the boolean operation.
function clipObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["f1"] },
    f1: {
      id: "f1",
      type: "frame",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      "show-content": true,
      x: 0,
      y: 0,
      width: 400,
      height: 300,
      points: rectPoints(0, 0, 400, 300),
      selrect: { x: 0, y: 0, width: 400, height: 300 },
      shapes: ["b1"],
    },
    b1: {
      id: "b1",
      type: "bool",
      "parent-id": "f1",
      "frame-id": "f1",
      x: 300,
      y: 200,
      width: 20,
      height: 20,
      points: rectPoints(300, 200, 20, 20),
      selrect: { x: 300, y: 200, width: 20, height: 20 },
      fills: [{ "fill-color": "#000000" }],
      shapes: ["r6"],
    },
    r6: makeRect("r6", 340, 240, 30, 30, { "parent-id": "b1" }),
  };
}

// Over r1 (10,10,100,50).
const CLICK_POINT = { x: 60, y: 35 };

// --- Parent walks and predicates --------------------------------------------

describe("parent walks", () => {
  it("collects the ancestors nearest-first up to zero", () => {
    const objects = baseObjects();
    expect(getParentIds(objects, "r2")).toEqual(["g1", "f1", ZERO_UUID]);
    expect(getParentIds(objects, "f1")).toEqual([ZERO_UUID]);
    expect(getParentIds(objects, ZERO_UUID)).toEqual([]);
  });

  it("stops on a self-referencing parent", () => {
    const objects = baseObjects();
    objects["loop"] = { id: "loop", type: "rect", "parent-id": "loop" };
    expect(getParentIds(objects, "loop")).toEqual([]);
  });

  it("collects the parent chain with self", () => {
    const objects = baseObjects();
    expect(getParentsWithSelf(objects, "r2").map((shape) => shape.id)).toEqual([
      "r2",
      "g1",
      "f1",
      ZERO_UUID,
    ]);
    expect(getParentsWithSelf(objects, "missing")).toEqual([]);
  });
});

describe("hiddenParentQmark", () => {
  it("flags shapes under a hidden ancestor", () => {
    const objects = baseObjects();
    expect(hiddenParentQmark(objects, "r1")).toBe(false);
    expect(hiddenParentQmark(objects, "r2")).toBe(false);
    expect(hiddenParentQmark(objects, "h1")).toBe(true);
  });

  it("treats zero and missing links as visible", () => {
    const objects = baseObjects();
    expect(hiddenParentQmark(objects, ZERO_UUID)).toBe(false);
    expect(hiddenParentQmark(objects, "missing")).toBe(false);
    expect(hiddenParentQmark(objects, "f1")).toBe(false);
  });
});

describe("cleanLoops", () => {
  it("drops the ids with an ancestor inside the set", () => {
    const objects = baseObjects();
    expect(cleanLoops(objects, ["r2", "g1"])).toEqual(["g1"]);
    expect(cleanLoops(objects, ["g1", "r2"])).toEqual(["g1"]);
  });

  it("keeps unrelated ids and deduplicates", () => {
    const objects = baseObjects();
    expect(cleanLoops(objects, ["r2"])).toEqual(["r2"]);
    expect(cleanLoops(objects, [])).toEqual([]);
    expect(cleanLoops(objects, ["r2", "r2", "r1"])).toEqual(["r2", "r1"]);
  });
});

// --- Hover ------------------------------------------------------------------

describe("hoverQueryRect", () => {
  it("uses the 5 / zoom half size around the position", () => {
    expect(hoverQueryRect({ x: 60, y: 35 }, 1)).toEqual({
      x: 55,
      y: 30,
      width: 10,
      height: 10,
    });
    expect(hoverQueryRect({ x: 60, y: 35 }, 2)).toEqual({
      x: 57.5,
      y: 32.5,
      width: 5,
      height: 5,
    });
  });
});

describe("queryHoverIds", () => {
  it("queries with include-frames and keeps the live geometry", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);

    const ids = queryHoverIds(index, CLICK_POINT, 1, false);
    expect(new Set(ids)).toEqual(new Set(["f1", "r1"]));
  });

  it("relaxes the non-frame clip parents while mod is held", () => {
    const objects = clipObjects();
    const index = createWorkspaceIndex(objects);
    const point = { x: 350, y: 250 };

    // The bool clips r6 outside its painted area.
    expect(queryHoverIds(index, point, 1, false)).not.toContain("r6");
    // With mod the bool clip relaxes (deep selection).
    expect(queryHoverIds(index, point, 1, true)).toContain("r6");
  });
});

describe("computeHoverStack", () => {
  function chainObjects(): WorkspaceObjects {
    return {
      [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["p1", "a", "c", "d"] },
      p1: {
        id: "p1",
        type: "group",
        hidden: true,
        "parent-id": ZERO_UUID,
        "frame-id": ZERO_UUID,
        shapes: ["b"],
      },
      b: makeRect("b", 0, 0, 10, 10, { "parent-id": "p1", "frame-id": ZERO_UUID }),
      a: makeRect("a", 20, 0, 10, 10, { "parent-id": ZERO_UUID, "frame-id": ZERO_UUID }),
      c: {
        id: "c",
        type: "svg-raw",
        "parent-id": ZERO_UUID,
        "frame-id": ZERO_UUID,
        points: rectPoints(40, 0, 10, 10),
        selrect: { x: 40, y: 0, width: 10, height: 10 },
      },
      d: makeRect("d", 60, 0, 10, 10, {
        "parent-id": ZERO_UUID,
        "frame-id": ZERO_UUID,
        blocked: true,
      }),
    };
  }

  it("filters hidden-parent, blocked and svg-raw shapes through the sorter", () => {
    const objects = chainObjects();
    const sortIds = vi.fn((ids: readonly string[]) => [...ids].reverse());

    // Sorted tail-first: [d, c, b, a]; d (blocked, the default editor
    // mode), c (svg-raw) and b (hidden parent) are removed.
    const stack = computeHoverStack(["a", "b", "c", "d"], objects, {
      mod: false,
      sortIds,
    });
    expect(stack).toEqual(["a"]);
    expect(sortIds).toHaveBeenCalledWith(["a", "b", "c", "d"], false);
  });

  it("keeps blocked shapes for a read-only user and deduplicates", () => {
    const objects = chainObjects();

    const stack = computeHoverStack(["a", "b", "c", "d", "a"], objects, {
      mod: false,
      readOnly: true,
    });
    expect(stack).toEqual(["a", "d"]);
  });

  it("caches the stack per (mod, ids)", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);
    const sortIds = vi.fn((ids: readonly string[]) => [...ids]);
    const cache = createHoverIdsCache();
    const options = { mod: false, sortIds, cache } as const;

    const first = hoverStackAt(index, objects, CLICK_POINT, 1, options);
    expect(first).toEqual(expect.arrayContaining(["f1", "r1"]));

    const second = hoverStackAt(index, objects, CLICK_POINT, 1, options);
    expect(second).toEqual(first);
    expect(sortIds).toHaveBeenCalledTimes(1);

    // A different mod is a different cache key.
    hoverStackAt(index, objects, CLICK_POINT, 1, { mod: true, sortIds, cache });
    expect(sortIds).toHaveBeenCalledTimes(2);

    // An empty query short-circuits before the cache.
    expect(hoverStackAt(index, objects, { x: 1000, y: 1000 }, 1, options)).toEqual([]);
    expect(sortIds).toHaveBeenCalledTimes(2);

    cache.clear();
    hoverStackAt(index, objects, CLICK_POINT, 1, options);
    expect(sortIds).toHaveBeenCalledTimes(3);
  });
});

describe("hoverShapeId", () => {
  const PLAIN = { mod: false, selected: [] as string[] };

  it("picks the front-most shape of the stack", () => {
    const objects = baseObjects();
    expect(hoverShapeId(["r2", "g1", "f1"], objects, CLICK_POINT, PLAIN)).toBe("r2");
  });

  it("drops root frames with content and empty stacks", () => {
    const objects = baseObjects();
    expect(hoverShapeId(["f1"], objects, CLICK_POINT, PLAIN)).toBeNull();
    expect(hoverShapeId([], objects, CLICK_POINT, PLAIN)).toBeNull();
  });

  it("keeps a group only while one of its children is on the stack", () => {
    const objects = baseObjects();
    expect(hoverShapeId(["g1"], objects, CLICK_POINT, PLAIN)).toBeNull();
    expect(hoverShapeId(["r2", "g1"], objects, CLICK_POINT, PLAIN)).toBe("r2");
  });

  it("hits text only over its glyphs", () => {
    const objects = baseObjects();
    const glyphs = { id: "t1", point: CLICK_POINT };

    // Over the glyphs the text wins; away from them it falls through to
    // the group around it (the empty parts of the text box are clickable
    // through).
    const inside = vi.fn(
      (id: string, point: { x: number; y: number }) =>
        id === glyphs.id && point === glyphs.point,
    );
    expect(
      hoverShapeId(["t1", "g1"], objects, CLICK_POINT, { ...PLAIN, intersectPosition: inside }),
    ).toBe("t1");
    expect(
      hoverShapeId(["t1", "g1"], objects, CLICK_POINT, {
        ...PLAIN,
        intersectPosition: () => false,
      }),
    ).toBe("g1");

    // With no adapter the filter degrades to "inside" (the documented
    // selrect fallback).
    expect(hoverShapeId(["t1", "g1"], objects, CLICK_POINT, PLAIN)).toBe("t1");
  });

  it("drops the ancestors of the current selection", () => {
    const objects = baseObjects();
    expect(
      hoverShapeId(["g1"], objects, CLICK_POINT, { mod: false, selected: ["r2"] }),
    ).toBeNull();
    expect(
      hoverShapeId(["r2", "g1"], objects, CLICK_POINT, { mod: false, selected: ["r2"] }),
    ).toBe("r2");
  });

  it("skips groups, empty nested frames and detached boards in mod mode", () => {
    const objects = baseObjects();
    const mod = { mod: true, selected: [] as string[] };

    // Groups step aside for the deep selection.
    expect(hoverShapeId(["g1"], objects, CLICK_POINT, mod)).toBeNull();
    expect(hoverShapeId(["r2", "g1"], objects, CLICK_POINT, mod)).toBe("r2");
    // A nested frame without fills is transparent; one with fills is not.
    expect(hoverShapeId(["f2"], objects, CLICK_POINT, mod)).toBeNull();
    expect(hoverShapeId(["f3"], objects, CLICK_POINT, mod)).toBe("f3");
    // A board (direct child of zero) stays hittable: mod is how the empty
    // canvas areas of a board are reached.
    expect(hoverShapeId(["f1"], objects, CLICK_POINT, mod)).toBe("f1");
  });

  it("hovers plain nested frames outside mod mode", () => {
    const objects = baseObjects();
    // The no-fill skip only applies to mod; without it a nested frame is
    // an ordinary hover candidate.
    expect(hoverShapeId(["f2"], objects, CLICK_POINT, PLAIN)).toBe("f2");
  });
});

// --- Click selection --------------------------------------------------------

describe("selectionAfterClick", () => {
  it("replaces the selection with the clicked shape", () => {
    expect(selectionAfterClick(["a", "b"], "c", false)).toEqual(["c"]);
    expect(selectionAfterClick([], "c", false)).toEqual(["c"]);
  });

  it("toggles the membership keeping the order", () => {
    expect(selectionAfterClick(["a"], "c", true)).toEqual(["a", "c"]);
    expect(selectionAfterClick(["a", "b"], "a", true)).toEqual(["b"]);
  });
});

// --- Area selection ---------------------------------------------------------

describe("areaInitialSelection", () => {
  it("starts from the current selection only for append and remove", () => {
    expect(areaInitialSelection(["a", "b"], true, false)).toEqual(["a", "b"]);
    expect(areaInitialSelection(["a"], false, true)).toEqual(["a"]);
  });

  it("starts empty on a plain drag, so a click on the empty canvas clears", () => {
    expect(areaInitialSelection(["a"], false, false)).toEqual([]);
  });
});

describe("selectionAfterArea", () => {
  const ALL = { x: -10, y: -10, width: 500, height: 400 };
  const OVER_R1 = { x: 0, y: 0, width: 150, height: 80 };
  const GRAZE_R1 = { x: 50, y: 50, width: 100, height: 30 };
  const OVER_G1 = { x: 190, y: 0, width: 120, height: 70 };

  it("appends the fully contained shapes", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);
    expect(selectionAfterArea(objects, index, OVER_R1, [])).toEqual(["r1"]);
  });

  it("hits the non-board shapes by overlap and the boards by containment", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);

    // Grazing r1 still selects it (only root frames and instances need
    // full containment); the board is not contained so it stays out.
    expect(selectionAfterArea(objects, index, GRAZE_R1, [])).toEqual(["r1"]);
    // A rect containing the whole board selects the board alone
    // (clean-loops drops its contained children).
    expect(selectionAfterArea(objects, index, ALL, [])).toEqual(["f1"]);
  });

  it("appends to the initial selection and deduplicates", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);
    expect(selectionAfterArea(objects, index, OVER_R1, ["f3"])).toEqual(["f3", "r1"]);
    expect(selectionAfterArea(objects, index, OVER_R1, ["r1"])).toEqual(["r1"]);
  });

  it("removes the hit shapes in remove mode", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);
    expect(selectionAfterArea(objects, index, OVER_R1, ["r1"], { remove: true })).toEqual([]);
    expect(
      selectionAfterArea(objects, index, OVER_R1, ["r1", "f3"], { remove: true }),
    ).toEqual(["f3"]);
  });

  it("ignores groups when asked to", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);

    // Without ignore-groups the group joins and clean-loops drops its
    // children; with it the children stay and the group is skipped.
    expect(selectionAfterArea(objects, index, OVER_G1, [])).toEqual(["g1"]);
    expect(
      selectionAfterArea(objects, index, OVER_G1, [], { ignoreGroups: true }).sort(),
    ).toEqual(["r2", "t1"]);
  });

  it("filters blocked shapes and hidden-parent chains from the append", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);

    const overD1 = { x: 0, y: 210, width: 70, height: 70 };
    expect(selectionAfterArea(objects, index, overD1, [])).toEqual([]);

    const overH1 = { x: 240, y: 140, width: 70, height: 70 };
    expect(selectionAfterArea(objects, index, overH1, [])).toEqual([]);
  });

  it("keeps the initial members untouched by the filters", () => {
    const objects = baseObjects();
    const index = createWorkspaceIndex(objects);
    const overD1 = { x: 0, y: 210, width: 70, height: 70 };
    expect(selectionAfterArea(objects, index, overD1, ["d1"])).toEqual(["d1"]);
  });
});
