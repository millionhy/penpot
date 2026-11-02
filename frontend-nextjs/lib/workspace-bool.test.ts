import { describe, expect, it } from "vitest";

import { ZERO_UUID } from "@/lib/file-data";
import { PathData } from "@/lib/transit";
import {
  BOOL_SHORTCUTS,
  BOOL_TYPE_NAMES,
  boolHead,
  boolOperands,
  buildBoolChanges,
  createBoolShape,
  orderByIndexedShapes,
} from "@/lib/workspace-bool";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";

function shape(id: string, overrides: Record<string, unknown> = {}): WorkspaceShape {
  return {
    id,
    type: "rect",
    "parent-id": ZERO_UUID,
    "frame-id": ZERO_UUID,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...overrides,
  };
}

function objects(...shapes: WorkspaceShape[]): WorkspaceObjects {
  const map: WorkspaceObjects = {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: [] },
  };
  for (const item of shapes) map[item.id] = item;
  const root = map[ZERO_UUID];
  root.shapes = shapes
    .filter((item) => item["parent-id"] === ZERO_UUID)
    .map((item) => item.id);
  return map;
}

// A 10 x 10 square, the content the renderer would answer for the fixtures.
function squareContent(): PathData {
  return PathData.fromSegments([
    { command: "move-to", x: 0, y: 0 },
    { command: "line-to", x: 10, y: 0 },
    { command: "line-to", x: 10, y: 10 },
    { command: "line-to", x: 0, y: 10 },
    { command: "close-path" },
  ]);
}

describe("bool constants", () => {
  it("names the four types like create-bool names the shape", () => {
    expect(BOOL_TYPE_NAMES).toEqual({
      union: "Union",
      difference: "Difference",
      intersection: "Intersection",
      exclude: "Exclude",
    });
  });

  it("maps the four shortcut letters", () => {
    expect(BOOL_SHORTCUTS).toEqual({
      u: "union",
      d: "difference",
      i: "intersection",
      e: "exclude",
    });
  });
});

describe("orderByIndexedShapes", () => {
  it("walks the tree top-most first", () => {
    const bottom = shape("bottom");
    const top = shape("top");
    const frame = shape("frame", { type: "frame", shapes: ["inner"] });
    const inner = shape("inner", { "parent-id": "frame", "frame-id": "frame" });
    // The root children list is bottom-first; the traversal starts at its end.
    const map: WorkspaceObjects = {
      [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["bottom", "frame", "top"] },
      bottom,
      frame,
      inner,
      top,
    };
    expect(orderByIndexedShapes(map, ["top", "inner", "bottom"])).toEqual([
      "top",
      "inner",
      "bottom",
    ]);
  });

  it("drops ids the tree does not reach", () => {
    const map = objects(shape("only"));
    expect(orderByIndexedShapes(map, ["only", "ghost"])).toEqual(["only"]);
    expect(map[ZERO_UUID].shapes).toEqual(["only"]);
  });
});

describe("boolOperands", () => {
  it("keeps the selection in tree order, top-most first", () => {
    const map = objects(shape("a"), shape("b"));
    expect(boolOperands(map, ["a", "b"]).map((item) => item.id)).toEqual(["b", "a"]);
  });

  it("drops frames, variants and shapes inside a component copy", () => {
    const map = objects(
      shape("rect"),
      shape("frame", { type: "frame" }),
      shape("variant", { "variant-id": "v1" }),
      shape("copy", { "parent-id": "instance", "frame-id": "instance" }),
      shape("instance", { type: "group", "shape-ref": "main" }),
    );
    map[ZERO_UUID].shapes = ["rect", "frame", "variant", "instance"];
    map["instance"].shapes = ["copy"];
    expect(boolOperands(map, ["rect", "frame", "variant", "copy"]).map((item) => item.id)).toEqual([
      "rect",
    ]);
  });

  it("keeps the head of a selection and drops its descendants", () => {
    const map = objects(shape("group", { type: "group", shapes: ["child"] }));
    map["child"] = shape("child", { "parent-id": "group", "frame-id": "group" });
    expect(boolOperands(map, ["group", "child"]).map((item) => item.id)).toEqual(["group"]);
  });
});

describe("boolHead", () => {
  it("takes the bottom shape of a difference and the top one otherwise", () => {
    const bottom = shape("bottom");
    const top = shape("top");
    expect(boolHead("difference", [bottom, top])).toBe(bottom);
    expect(boolHead("union", [bottom, top])).toBe(top);
    expect(boolHead("union", [])).toBeNull();
  });
});

describe("createBoolShape", () => {
  it("builds the record from the head and the content box", () => {
    const head = shape("top", {
      fills: [{ "fill-color": "#ff0000", "fill-opacity": 1 }],
      strokes: [{ "stroke-color": "#00ff00" }],
      shadow: [{ id: "shadow" }],
    });
    const bottom = shape("bottom", { fills: [] });
    const bool = createBoolShape("union", "bool", [bottom, head], squareContent());
    expect(bool).toMatchObject({
      id: "bool",
      type: "bool",
      name: "Union",
      "bool-type": "union",
      "parent-id": ZERO_UUID,
      "frame-id": ZERO_UUID,
      shapes: ["bottom", "top"],
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      proportion: 1,
      "proportion-lock": false,
    });
    expect(bool?.fills).toEqual([{ "fill-color": "#ff0000", "fill-opacity": 1 }]);
    expect(bool?.strokes).toEqual([{ "stroke-color": "#00ff00" }]);
    expect(bool?.shadow).toEqual([{ id: "shadow" }]);
    expect(bool?.selrect).toMatchObject({ x: 0, y: 0, width: 10, height: 10 });
    expect(bool?.points).toHaveLength(4);
  });

  it("takes the keeps of the bottom shape of a difference", () => {
    const bottom = shape("bottom", { fills: [{ "fill-color": "#0000ff" }] });
    const top = shape("top", { fills: [{ "fill-color": "#ff0000" }] });
    const bool = createBoolShape("difference", "bool", [bottom, top], squareContent());
    expect(bool?.fills).toEqual([{ "fill-color": "#0000ff" }]);
  });

  it("gives an imported svg a black fill", () => {
    const head = shape("svg", { "svg-attrs": { "fill-rule": "evenodd" }, fills: [] });
    const bool = createBoolShape("union", "bool", [head], squareContent());
    expect(bool?.fills).toEqual([{ "fill-color": "#000000", "fill-opacity": 1 }]);
  });

  it("answers null without content", () => {
    expect(createBoolShape("union", "bool", [], squareContent())).toBeNull();
  });
});

describe("buildBoolChanges", () => {
  it("adds the bool above the head and reparents the operands", () => {
    const bottom = shape("bottom", { "layout-item-min-w": 10, "layout-item-absolute": true });
    const top = shape("top");
    const map = objects(bottom, top);
    const creation = buildBoolChanges(
      map,
      ["bottom", "top"],
      "union",
      "page",
      "bool",
      squareContent(),
    );
    expect(creation).not.toBeNull();
    const changes = creation!.changes;
    expect(changes[0]).toMatchObject({
      type: "add-obj",
      id: "bool",
      "page-id": "page",
      "parent-id": ZERO_UUID,
      // The head is the top shape, the second child of the root: index 1 + 1.
      index: 2,
    });
    const mod = changes.find((change) => change.type === "mod-obj");
    expect(mod).toMatchObject({ type: "mod-obj", id: "bottom" });
    expect(changes[changes.length - 1]).toMatchObject({
      type: "mov-objects",
      "parent-id": "bool",
      shapes: ["bottom", "top"],
    });
  });

  it("sends no mod-obj when the operands carry no layout-item data", () => {
    const map = objects(shape("a"), shape("b"));
    const creation = buildBoolChanges(map, ["a", "b"], "exclude", "page", "bool", squareContent());
    expect(creation!.changes.map((change) => change.type)).toEqual([
      "add-obj",
      "mov-objects",
    ]);
    expect((creation!.shape.shapes as string[]).length).toBe(2);
    expect(creation!.shape["bool-type"]).toBe("exclude");
  });

  it("answers null for an empty selection", () => {
    expect(buildBoolChanges(objects(), [], "union", "page", "bool", squareContent())).toBeNull();
  });
});
