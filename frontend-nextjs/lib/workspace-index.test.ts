// Workspace hit-testing index (F9.2) unit tests. The module under test is a
// plain-TS port of the worker selection index
// (frontend/src/app/worker/selection.cljs create-index/query-index), the
// quadtree (frontend/src/app/util/quadtree.js) and the intersect geometry
// they call; every case pins the CLJS behaviour with plain numbers.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import {
  createQuadtree,
  createWorkspaceIndex,
  overlapsShape,
  querySelection,
  quadtreeClear,
  quadtreeCount,
  quadtreeInsert,
  quadtreeRemoveAll,
  quadtreeSearch,
  rectContainsShape,
  shapeBounds,
  type Bounds,
} from "@/lib/workspace-index";

const BOUNDS: Bounds = { x: 0, y: 0, width: 100, height: 100 };

function pointRect(x: number, y: number): Bounds {
  return { x, y, width: 0.01, height: 0.01 };
}

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

// --- quadtree (ported from frontend/src/app/util/quadtree.js) ---------------

describe("quadtree", () => {
  it("inserts and searches nodes, keeping the insertion order", () => {
    const tree = createQuadtree<number>(BOUNDS);
    quadtreeInsert(tree, "a", { x: 0, y: 0, width: 1, height: 1 }, 1);
    quadtreeInsert(tree, "b", { x: 10, y: 10, width: 1, height: 1 }, 2);

    expect(quadtreeCount(tree)).toBe(2);
    const found = quadtreeSearch(tree, { x: 5, y: 5, width: 1, height: 1 });
    expect(found.map((node) => node.id)).toEqual(["a", "b"]);
    expect(found[1]?.data).toBe(2);
  });

  it("splits after maxObjects and still finds every node", () => {
    const tree = createQuadtree<number>(BOUNDS);
    for (let index = 0; index < 12; index += 1) {
      quadtreeInsert(tree, `n${index}`, { x: index, y: index, width: 1, height: 1 }, index);
    }

    // count() sums the leaf objects: n6 straddles the deepest split midpoint,
    // so its node lives in all four quadrants (15 physical copies). Verified
    // against the original quadtree.js under node.
    expect(quadtreeCount(tree)).toBe(15);
    const all = quadtreeSearch(tree, BOUNDS);
    // search() deduplicates the copies through its Set.
    expect(all).toHaveLength(12);
    // The traversal visits the quadrants in top-right, top-left, bottom-left,
    // bottom-right order: the n6 copy in the top-right quadrant comes first
    // and the bottom-right quadrant holds the tail n7..n11.
    expect(all.map((node) => node.id)).toEqual([
      "n6",
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n7",
      "n8",
      "n9",
      "n10",
      "n11",
    ]);
  });

  it("yields a node straddling several quadrants only once", () => {
    const tree = createQuadtree<number>(BOUNDS);
    for (let index = 0; index < 12; index += 1) {
      quadtreeInsert(tree, `n${index}`, { x: index, y: index, width: 1, height: 1 }, index);
    }
    // The bounds cross the split midpoint, so the node lives in all four
    // quadrants of every level it reaches.
    quadtreeInsert(tree, "big", { x: 45, y: 45, width: 10, height: 10 }, 99);

    const found = quadtreeSearch(tree, BOUNDS);
    // big lands in the top-right quadrant first, so its single yield leads;
    // the remaining order matches the split traversal seen above.
    expect(found.map((node) => node.id)).toEqual([
      "big",
      "n6",
      "n0",
      "n1",
      "n2",
      "n3",
      "n4",
      "n5",
      "n7",
      "n8",
      "n9",
      "n10",
      "n11",
    ]);
    expect(found.filter((node) => node.id === "big")).toHaveLength(1);
  });

  it("remove-all rebuilds the tree without the given ids", () => {
    const tree = createQuadtree<number>(BOUNDS);
    for (let index = 0; index < 12; index += 1) {
      quadtreeInsert(tree, `n${index}`, { x: index, y: index, width: 1, height: 1 }, index);
    }

    const next = quadtreeRemoveAll(tree, ["n3", "n7"]);
    expect(next).not.toBe(tree);
    expect(quadtreeCount(next)).toBe(10);
    // remove-all re-inserts the surviving nodes in the search order of the old
    // tree (n6 first, its copy in the top-right quadrant). With ten nodes the
    // rebuilt tree stays a single unsplit node, so the order sticks.
    expect(quadtreeSearch(next, BOUNDS).map((node) => node.id)).toEqual([
      "n6",
      "n0",
      "n1",
      "n2",
      "n4",
      "n5",
      "n8",
      "n9",
      "n10",
      "n11",
    ]);
    // The original tree is untouched (15 physical copies, see above).
    expect(quadtreeCount(tree)).toBe(15);
  });

  it("clears every node", () => {
    const tree = createQuadtree<number>(BOUNDS);
    quadtreeInsert(tree, "a", { x: 0, y: 0, width: 1, height: 1 }, 1);
    quadtreeClear(tree);

    expect(quadtreeCount(tree)).toBe(0);
    expect(quadtreeSearch(tree, BOUNDS)).toEqual([]);
  });
});

// --- Fixtures ---------------------------------------------------------------

function makeRectShape(
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

function makeTextShape(): WorkspaceShape {
  return {
    id: "t1",
    type: "text",
    "parent-id": "f1",
    "frame-id": "f1",
    x: 20,
    y: 30,
    width: 40,
    height: 10,
    points: rectPoints(20, 30, 40, 10),
    selrect: { x: 20, y: 30, width: 40, height: 10 },
    // The (T(c) M T(-c)) conjugation of a translation is the same
    // translation, so the position-data rect shifts by (5, 0).
    transform: { a: 1, b: 0, c: 0, d: 1, e: 5, f: 0 },
    "position-data": [{ x: 20, y: 30, width: 40, height: 10 }],
    fills: [],
  };
}

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
      shapes: ["r1", "r2", "t1"],
    },
    r1: makeRectShape("r1", 10, 10, 100, 50),
    r2: makeRectShape("r2", 10, 10, 100, 50),
    t1: makeTextShape(),
  };
}

function hollowObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["h1"] },
    h1: {
      id: "h1",
      type: "rect",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: rectPoints(0, 0, 100, 100),
      selrect: { x: 0, y: 0, width: 100, height: 100 },
      fills: [],
      strokes: [{ "stroke-width": 20, "stroke-alignment": "center" }],
    },
  };
}

function clippingObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["cf"] },
    cf: {
      id: "cf",
      type: "frame",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      "show-content": false,
      x: 0,
      y: 0,
      width: 100,
      height: 100,
      points: rectPoints(0, 0, 100, 100),
      selrect: { x: 0, y: 0, width: 100, height: 100 },
      shapes: ["c1"],
      fills: [{ "fill-color": "#000000" }],
    },
    c1: makeRectShape("c1", 90, 10, 50, 50, { "frame-id": "cf", "parent-id": "cf" }),
  };
}

// --- Index construction -----------------------------------------------------

describe("createWorkspaceIndex", () => {
  it("builds the parents and clip indexes", () => {
    const index = createWorkspaceIndex(baseObjects());

    expect(index.parentsIndex[ZERO_UUID]).toEqual([]);
    expect(index.parentsIndex["f1"]).toEqual([ZERO_UUID]);
    expect(index.parentsIndex["r1"]).toEqual(["f1", ZERO_UUID]);
    expect(index.parentsIndex["t1"]).toEqual(["f1", ZERO_UUID]);
    expect(index.clipIndex["r1"]).toEqual([]);
    expect(index.clipIndex["t1"]).toEqual([]);
  });

  it("keeps the 10% padding of the root-children bounds (y is not padded)", () => {
    const index = createWorkspaceIndex(baseObjects());

    // f1 is 400x300 at the origin: pad 40/30 horizontally and 30 vertically.
    expect(index.bounds).toEqual({ x: -40, y: 0, width: 480, height: 360 });
  });

  it("collects the clipping ancestors (frames without show-content)", () => {
    const objects = baseObjects();
    objects["f1"] = { ...objects["f1"], "show-content": false };
    const index = createWorkspaceIndex(objects);

    expect(index.clipIndex["r1"]).toHaveLength(1);
    expect(index.clipIndex["r1"][0]?.id).toBe("f1");
  });

  it("indexes a rotated rect by the bounds of its points", () => {
    const objects = baseObjects();
    // 45-degree rotated square: the points bounding box is 100x100.
    objects["r1"] = {
      ...objects["r1"],
      points: [
        { x: 50, y: 0 },
        { x: 100, y: 50 },
        { x: 50, y: 100 },
        { x: 0, y: 50 },
      ],
    };
    const index = createWorkspaceIndex(objects);

    const node = quadtreeSearch(index.quadtree, BOUNDS).find((entry) => entry.id === "r1");
    expect(node?.bounds).toEqual({ x: 0, y: 0, width: 100, height: 100 });
  });

  it("uses the position-data rects (y - height) for the text bounds", () => {
    const index = createWorkspaceIndex(baseObjects());

    const node = quadtreeSearch(index.quadtree, { x: 20, y: 15, width: 50, height: 20 }).find(
      (entry) => entry.id === "t1",
    );
    expect(node?.bounds).toEqual({ x: 25, y: 20, width: 40, height: 10 });
  });
});

// --- shapeBounds ------------------------------------------------------------

describe("shapeBounds", () => {
  it("falls back to points->rect for shapes without position data", () => {
    expect(shapeBounds(makeRectShape("r1", 10, 10, 100, 50))).toEqual({
      x: 10,
      y: 10,
      width: 100,
      height: 50,
    });
  });

  it("returns null when there are no points at all", () => {
    expect(shapeBounds({ id: "g", type: "group" })).toBeNull();
    expect(shapeBounds({ id: "g", type: "group", points: [] })).toBeNull();
  });

  it("derives the text bounds from the position data through the transform", () => {
    expect(shapeBounds(makeTextShape())).toEqual({ x: 25, y: 20, width: 40, height: 10 });
  });
});

// --- rectContainsShape / overlapsShape --------------------------------------

describe("rectContainsShape", () => {
  it("checks every shape point inside the rect", () => {
    const shape = makeRectShape("r1", 10, 10, 100, 50);

    expect(rectContainsShape({ x: 0, y: 0, width: 200, height: 100 }, shape)).toBe(true);
    expect(rectContainsShape({ x: 0, y: 0, width: 50, height: 100 }, shape)).toBe(false);
  });
});

describe("overlapsShape", () => {
  it("misses the hollow center of an unfilled stroked rect and hits its band", () => {
    const shape = hollowObjects()["h1"] as WorkspaceShape;

    expect(overlapsShape(shape, pointRect(50, 50))).toBe(false);
    expect(overlapsShape(shape, pointRect(-5, 50))).toBe(true);
    // with usingSelrect the ring logic is bypassed and the selrect hits.
    expect(overlapsShape(shape, pointRect(50, 50), true)).toBe(true);
  });
});

// --- querySelection ---------------------------------------------------------

describe("querySelection", () => {
  it("returns the child shapes under the point in insertion order", () => {
    const index = createWorkspaceIndex(baseObjects());

    expect(querySelection(index, pointRect(30, 40))).toEqual(["r1", "r2"]);
    expect(querySelection(index, pointRect(1000, 1000))).toEqual([]);
  });

  it("excludes hidden shapes", () => {
    const objects = baseObjects();
    objects["r2"] = { ...objects["r2"], hidden: true };
    const index = createWorkspaceIndex(objects);

    expect(querySelection(index, pointRect(30, 40))).toEqual(["r1"]);
  });

  it("filters by frame-id", () => {
    const index = createWorkspaceIndex(baseObjects());

    expect(querySelection(index, pointRect(30, 40), { frameId: "f1" })).toEqual(["r1", "r2"]);
    expect(querySelection(index, pointRect(30, 40), { frameId: "other" })).toEqual([]);
  });

  it("includes the frame itself when asked", () => {
    const index = createWorkspaceIndex(baseObjects());

    expect(querySelection(index, pointRect(30, 40), { includeFrames: true })).toEqual([
      "f1",
      "r1",
      "r2",
    ]);
  });

  it("rejects hits outside a clipping ancestor", () => {
    const index = createWorkspaceIndex(clippingObjects());

    expect(querySelection(index, pointRect(95, 20))).toEqual(["c1"]);
    expect(querySelection(index, pointRect(120, 30))).toEqual([]);
  });

  it("misses the hollow center of an unfilled stroked rect", () => {
    const index = createWorkspaceIndex(hollowObjects());

    expect(querySelection(index, pointRect(50, 50))).toEqual([]);
    expect(querySelection(index, pointRect(-5, 50))).toEqual(["h1"]);
    expect(querySelection(index, pointRect(50, 50), { usingSelrect: true })).toEqual(["h1"]);
  });

  it("requires containing the root frames in full-frame mode", () => {
    const index = createWorkspaceIndex(baseObjects());

    const partial = querySelection(
      index,
      { x: 0, y: 0, width: 50, height: 50 },
      { includeFrames: true, fullFrame: true },
    );
    expect(partial).toEqual(["r1", "r2", "t1"]);

    const full = querySelection(
      index,
      { x: -10, y: -10, width: 500, height: 400 },
      { includeFrames: true, fullFrame: true },
    );
    expect(full).toEqual(["f1", "r1", "r2", "t1"]);
  });
});
