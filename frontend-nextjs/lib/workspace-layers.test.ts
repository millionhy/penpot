// Unit tests for the workspace layer tree (lib/workspace-layers): array
// order, depth, name fallback, missing ids and parents, cycles, the name
// filter with ancestor retention and the collapsed/filtered row walk.

import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import {
  buildLayerTree,
  filterLayerTree,
  visibleLayerRows,
} from "@/lib/workspace-layers";
import type { WorkspaceObjects } from "@/lib/workspace";

// A three-level fixture with a missing child, a blank name and an orphan
// whose parent-id points to a shape that is not in the map.
function makeObjects(): WorkspaceObjects {
  return {
    [ZERO_UUID]: {
      id: ZERO_UUID,
      type: "root",
      shapes: ["frame", "orphan", "missing"],
    },
    frame: {
      id: "frame",
      type: "frame",
      name: "Frame",
      shapes: ["group", "child"],
    },
    group: {
      id: "group",
      type: "group",
      name: "Group",
      // The cycle back to frame must not recurse forever.
      shapes: ["leaf", "frame"],
    },
    leaf: { id: "leaf", type: "rect", name: "   " },
    child: { id: "child", type: "rect", name: "Child" },
    orphan: {
      id: "orphan",
      type: "rect",
      name: "Orphan",
      "parent-id": "gone",
    },
  };
}

describe("buildLayerTree", () => {
  it("walks the root shapes in array order and nests the children", () => {
    const tree = buildLayerTree(makeObjects());

    expect(tree.map((node) => node.id)).toEqual(["frame", "orphan"]);
    expect(tree[0].depth).toBe(0);
    expect(tree[0].children.map((node) => node.id)).toEqual(["group", "child"]);
    expect(tree[0].children[0].depth).toBe(1);
    expect(tree[0].children[0].children.map((node) => node.id)).toEqual(["leaf"]);
    expect(tree[0].children[0].children[0].depth).toBe(2);
  });

  it("skips missing child ids and keeps a root child with a missing parent", () => {
    const tree = buildLayerTree(makeObjects());

    expect(tree.map((node) => node.id)).not.toContain("missing");
    expect(tree[1].id).toBe("orphan");
    expect(tree[1].name).toBe("Orphan");
  });

  it("falls back to the shape type for a blank name", () => {
    const tree = buildLayerTree(makeObjects());
    expect(tree[0].children[0].children[0].name).toBe("rect");
  });

  it("renders a repeated id once and terminates on a cycle", () => {
    const tree = buildLayerTree(makeObjects());
    const ids = tree[0].children[0].children.map((node) => node.id);
    expect(ids).toEqual(["leaf"]);
  });

  it("returns an empty tree without a root", () => {
    expect(buildLayerTree({ a: { id: "a", type: "rect" } })).toEqual([]);
  });
});

describe("filterLayerTree", () => {
  it("matches case-insensitively, trims the query and keeps the ancestors", () => {
    const tree = buildLayerTree(makeObjects());
    const filtered = filterLayerTree(tree, "  CHILD  ");

    expect(filtered.map((node) => node.id)).toEqual(["frame"]);
    expect(filtered[0].children.map((node) => node.id)).toEqual(["child"]);
  });

  it("keeps a matching parent without its non-matching descendants", () => {
    const tree = buildLayerTree(makeObjects());
    const filtered = filterLayerTree(tree, "group");

    expect(filtered.map((node) => node.id)).toEqual(["frame"]);
    expect(filtered[0].children.map((node) => node.id)).toEqual(["group"]);
    expect(filtered[0].children[0].children).toEqual([]);
  });

  it("returns an empty list when nothing matches", () => {
    const tree = buildLayerTree(makeObjects());
    expect(filterLayerTree(tree, "nothing")).toEqual([]);
  });

  it("returns the input tree for an empty query", () => {
    const tree = buildLayerTree(makeObjects());
    expect(filterLayerTree(tree, "   ")).toBe(tree);
  });
});

describe("visibleLayerRows", () => {
  it("shows only the roots while every node is collapsed", () => {
    const tree = buildLayerTree(makeObjects());
    const rows = visibleLayerRows(tree, new Set(), false);

    expect(rows.map((row) => row.node.id)).toEqual(["frame", "orphan"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 0]);
  });

  it("expands one level at a time", () => {
    const tree = buildLayerTree(makeObjects());

    expect(
      visibleLayerRows(tree, new Set(["frame"]), false).map((row) => row.node.id),
    ).toEqual(["frame", "group", "child", "orphan"]);

    expect(
      visibleLayerRows(tree, new Set(["frame", "group"]), false).map(
        (row) => row.node.id,
      ),
    ).toEqual(["frame", "group", "leaf", "child", "orphan"]);
  });

  it("shows every remaining node in a filtered tree regardless of expansion", () => {
    const tree = buildLayerTree(makeObjects());
    const filtered = filterLayerTree(tree, "child");
    const rows = visibleLayerRows(filtered, new Set(), true);

    expect(rows.map((row) => row.node.id)).toEqual(["frame", "child"]);
    expect(rows.map((row) => row.depth)).toEqual([0, 1]);
  });
});
