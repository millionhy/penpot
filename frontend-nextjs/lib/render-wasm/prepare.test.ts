import { describe, expect, it } from "vitest";
import { ZERO_UUID } from "./engine";
import { makeRect, rectToPoints } from "./engine/bounds";
import { getChildrenIds, prepareObjects, preparePageObjects } from "./prepare";

function rect(id: string, x: number, y: number): Record<string, unknown> {
  return {
    id,
    type: "rect",
    x,
    y,
    width: 10,
    height: 10,
    selrect: makeRect(x, y, 10, 10),
    points: rectToPoints(makeRect(x, y, 10, 10)),
  };
}

function page(): Record<string, unknown> {
  return {
    [ZERO_UUID]: { id: ZERO_UUID, type: "frame", shapes: ["frame", "loose"] },
    frame: { ...rect("frame", 10, 20), type: "frame", shapes: ["child", "group"] },
    child: rect("child", 10, 20),
    group: { id: "group", type: "group", shapes: ["nested"] },
    nested: rect("nested", 30, 40),
    loose: rect("loose", 100, 100),
  };
}

describe("getChildrenIds", () => {
  it("walks depth first in shapes order", () => {
    expect(getChildrenIds(page(), "frame")).toEqual(["child", "group", "nested"]);
  });

  it("reports the id that closes a cycle once", () => {
    const objects = {
      a: { id: "a", shapes: ["b"] },
      b: { id: "b", shapes: ["a"] },
      c: { id: "c", shapes: ["c"] },
    };
    // The compiled walk stops only when it reaches an id it already visited
    // on the same branch, so b is listed and then a closes the loop. A self
    // reference is listed once, because the first level is never filtered.
    expect(getChildrenIds(objects, "a")).toEqual(["b", "a"]);
    expect(getChildrenIds(objects, "c")).toEqual(["c"]);
    expect(getChildrenIds(objects, "missing")).toEqual([]);
  });
});

describe("prepareObjects", () => {
  it("shifts the frame and its subtree into vbox space", () => {
    const objects = page();
    const prepared = prepareObjects(objects, "frame", { x: 5, y: 6 }, { x: 1, y: 2 });

    for (const id of ["frame", "child", "group", "nested"]) {
      expect(prepared[id]).not.toBe(objects[id]);
    }
    expect((prepared.frame as { x: number }).x).toBe(4);
    expect((prepared.frame as { y: number }).y).toBe(12);
    expect((prepared.nested as { x: number }).x).toBe(24);
    expect((prepared.nested as { y: number }).y).toBe(32);
    expect((prepared.child as { selrect: { x: number } }).selrect.x).toBe(4);
  });

  it("leaves the rest of the page alone", () => {
    const objects = page();
    const prepared = prepareObjects(objects, "frame", { x: 5, y: 6 }, { x: 0, y: 0 });
    expect(prepared.loose).toBe(objects.loose);
    expect(prepared[ZERO_UUID]).toBe(objects[ZERO_UUID]);
    expect((prepared.loose as { x: number }).x).toBe(100);
  });

  it("does not mutate the input", () => {
    const objects = page();
    prepareObjects(objects, "frame", { x: 5, y: 6 }, { x: 1, y: 2 });
    expect((objects.frame as { x: number }).x).toBe(10);
    expect((objects.nested as { x: number }).x).toBe(30);
  });
});

describe("preparePageObjects", () => {
  it("shifts every object but the page root", () => {
    const objects = page();
    const prepared = preparePageObjects(objects, { x: 5, y: 6 }, { x: 1, y: 2 });
    expect(prepared[ZERO_UUID]).toBe(objects[ZERO_UUID]);
    expect((prepared.loose as { x: number }).x).toBe(94);
    expect((prepared.loose as { y: number }).y).toBe(92);
    expect((prepared.frame as { x: number }).x).toBe(4);
    expect((prepared.group as { x?: number }).x).toBeUndefined();
  });
});
