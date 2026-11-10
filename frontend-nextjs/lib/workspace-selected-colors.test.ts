// The selected-colors menu of lib/workspace-selected-colors.ts: the unique
// color groups of a selection (fills, strokes and shadow colors), the usage
// list of a group and the batch patch that recolors every usage at once.

import { describe, expect, it } from "vitest";

import {
  colorUpdates,
  selectedColors,
  usageShapeIds,
} from "@/lib/workspace-selected-colors";
import type { WorkspaceShape } from "@/lib/workspace";

function shape(id: string, extra: Record<string, unknown> = {}): WorkspaceShape {
  return { id, type: "rect", ...extra };
}

describe("selectedColors", () => {
  it("groups the same color once and lists both usages", () => {
    const groups = selectedColors([
      shape("a", { fills: [{ "fill-color": "#112233", "fill-opacity": 1 }] }),
      shape("b", { fills: [{ "fill-color": "#112233", "fill-opacity": 1 }] }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].color).toBe("#112233");
    expect(groups[0].opacity).toBe(1);
    expect(groups[0].usages).toEqual([
      { shapeId: "a", prop: "fill", index: 0 },
      { shapeId: "b", prop: "fill", index: 0 },
    ]);
  });

  it("keeps the same hex at two opacities apart", () => {
    const groups = selectedColors([
      shape("a", {
        fills: [
          { "fill-color": "#112233", "fill-opacity": 1 },
          { "fill-color": "#112233", "fill-opacity": 0.5 },
        ],
      }),
    ]);
    expect(groups.map((group) => group.opacity)).toEqual([1, 0.5]);
  });

  it("reads strokes and shadow colors", () => {
    const groups = selectedColors([
      shape("a", {
        strokes: [{ "stroke-color": "#445566", "stroke-opacity": 0.25 }],
        shadow: [{ color: { color: "#778899", opacity: 0.2 } }],
      }),
    ]);
    expect(groups).toEqual([
      { color: "#445566", opacity: 0.25, usages: [{ shapeId: "a", prop: "stroke", index: 0 }] },
      { color: "#778899", opacity: 0.2, usages: [{ shapeId: "a", prop: "shadow", index: 0 }] },
    ]);
  });

  it("skips gradient and image paints", () => {
    const groups = selectedColors([
      shape("a", {
        fills: [
          { "fill-color": "#112233", "fill-color-gradient": { type: "linear" } },
          { "fill-color": "#112233", "fill-image": { id: "i" } },
        ],
      }),
    ]);
    expect(groups).toEqual([]);
  });

  it("reads a missing paint opacity as one", () => {
    const groups = selectedColors([
      shape("a", { fills: [{ "fill-color": "#112233" }] }),
    ]);
    expect(groups[0].opacity).toBe(1);
  });

  it("aggregates the colors of a container subtree", () => {
    const groups = selectedColors([
      shape("board", { fills: [{ "fill-color": "#FFFFFF", "fill-opacity": 1 }] }),
      shape("c1", { fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }] }),
      shape("c2", { fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }] }),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups[0].usages).toEqual([
      { shapeId: "board", prop: "fill", index: 0 },
    ]);
    expect(groups[1].usages).toEqual([
      { shapeId: "c1", prop: "fill", index: 0 },
      { shapeId: "c2", prop: "fill", index: 0 },
    ]);
  });
});

describe("usageShapeIds", () => {
  it("returns the shapes once, in first-use order", () => {
    const [group] = selectedColors([
      shape("a", {
        fills: [
          { "fill-color": "#112233", "fill-opacity": 1 },
          { "fill-color": "#112233", "fill-opacity": 1 },
        ],
      }),
      shape("b", { fills: [{ "fill-color": "#112233", "fill-opacity": 1 }] }),
    ]);
    expect(usageShapeIds(group)).toEqual(["a", "b"]);
  });
});

describe("colorUpdates", () => {
  const a = shape("a", {
    fills: [
      { "fill-color": "#112233", "fill-opacity": 1 },
      { "fill-color": "#999999", "fill-opacity": 1 },
    ],
    strokes: [{ "stroke-color": "#112233", "stroke-opacity": 1 }],
  });

  it("rewrites only the usages of the group", () => {
    const [group] = selectedColors([a]);
    const updates = colorUpdates([a], group.usages, { color: "#ABCDEF" });
    expect(updates).toHaveLength(1);
    expect(updates[0].id).toBe("a");
    expect(updates[0].attrs).toEqual({
      fills: [
        { "fill-color": "#ABCDEF", "fill-opacity": 1 },
        { "fill-color": "#999999", "fill-opacity": 1 },
      ],
      strokes: [{ "stroke-color": "#ABCDEF", "stroke-opacity": 1 }],
    });
  });

  it("rewrites the opacity of every usage", () => {
    const [group] = selectedColors([a]);
    const updates = colorUpdates([a], group.usages, { opacity: 0.4 });
    const fills = updates[0].attrs.fills as Record<string, unknown>[];
    const strokes = updates[0].attrs.strokes as Record<string, unknown>[];
    expect(fills[0]["fill-opacity"]).toBe(0.4);
    expect(fills[1]["fill-opacity"]).toBe(1);
    expect(strokes[0]["stroke-opacity"]).toBe(0.4);
  });

  it("rewrites the shadow color", () => {
    const withShadow = shape("b", { shadow: [{ color: { color: "#111111", opacity: 0.2 } }] });
    const [group] = selectedColors([withShadow]);
    const updates = colorUpdates([withShadow], group.usages, {
      color: "#222222",
      opacity: 0.5,
    });
    expect(updates[0].attrs.shadow).toEqual([
      { color: { color: "#222222", opacity: 0.5 } },
    ]);
  });

  it("drops a usage whose shape is not in the list", () => {
    const [group] = selectedColors([a]);
    expect(colorUpdates([], group.usages, { color: "#ABCDEF" })).toEqual([]);
  });

  it("sends nothing without usages", () => {
    expect(colorUpdates([a], [], { color: "#ABCDEF" })).toEqual([]);
  });

  it("recolors every usage across a subtree", () => {
    const board = shape("board", {
      fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }],
    });
    const c1 = shape("c1", { fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }] });
    const c2 = shape("c2", { fills: [{ "fill-color": "#B1B2B5", "fill-opacity": 1 }] });
    const subtree = [board, c1, c2];
    const [group] = selectedColors(subtree);
    const updates = colorUpdates(subtree, group.usages, { color: "#FF0000" });
    expect(updates.map((item) => item.id).sort()).toEqual(["board", "c1", "c2"]);
    for (const item of updates) {
      const fills = item.attrs.fills as Record<string, unknown>[];
      expect(fills[0]["fill-color"]).toBe("#FF0000");
    }
  });
});
