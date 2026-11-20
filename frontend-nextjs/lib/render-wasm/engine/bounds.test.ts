import { describe, expect, it } from "vitest";
import {
  calculatePadding,
  getRectFilterBounds,
  getShapeFilterBounds,
  joinRects,
  makeRect,
  objectBounds,
  pointsRect,
  rectToPoints,
  reduceObjects,
  type Rect,
} from "./bounds";

type Shape = Record<string, unknown>;

function box(x: number, y: number, width: number, height: number): Rect {
  return makeRect(x, y, width, height);
}

function shape(overrides: Shape = {}): Shape {
  const selrect = (overrides.selrect as Rect | undefined) ?? box(0, 0, 100, 100);
  return {
    id: "shape-1",
    type: "rect",
    selrect,
    points: rectToPoints(selrect),
    ...overrides,
  };
}

describe("makeRect", () => {
  it("keeps the 0.01 floor on both sides and fills the corners", () => {
    expect(makeRect(5, 6, 0, -3)).toEqual({
      x: 5,
      y: 6,
      width: 0.01,
      height: 0.01,
      x1: 5,
      y1: 6,
      x2: 5.01,
      y2: 6.01,
    });
  });
});

describe("pointsRect", () => {
  it("wraps the points in an axis-aligned box", () => {
    expect(pointsRect([{ x: 10, y: 20 }, { x: -5, y: 40 }])).toEqual(box(-5, 20, 15, 20));
  });

  it("answers nil without points", () => {
    expect(pointsRect([])).toBeNull();
  });
});

describe("joinRects", () => {
  it("unions the rects by their corners", () => {
    expect(joinRects([box(0, 0, 10, 10), box(20, 5, 10, 10)])).toEqual(box(0, 0, 30, 15));
  });

  it("ignores nil entries and answers nil when nothing is left", () => {
    expect(joinRects([null, box(1, 2, 3, 4), undefined])).toEqual(box(1, 2, 3, 4));
    expect(joinRects([null, undefined])).toBeNull();
  });
});

describe("calculatePadding", () => {
  it("is zero without strokes or shadows", () => {
    expect(calculatePadding(shape())).toEqual({ horizontal: 0, vertical: 0 });
  });

  it("takes half the centered stroke width, then the diagonal margin", () => {
    const padding = calculatePadding(
      shape({ strokes: [{ "stroke-width": 10, "stroke-alignment": "center" }] }),
    );
    // sqrt(2 * 5 * 5) = 7.0711 -> ceil
    expect(padding).toEqual({ horizontal: 8, vertical: 8 });
  });

  it("defaults an absent alignment to center", () => {
    const padding = calculatePadding(shape({ strokes: [{ "stroke-width": 10 }] }));
    expect(padding).toEqual({ horizontal: 8, vertical: 8 });
  });

  it("adds no inner stroke to a closed rect", () => {
    const padding = calculatePadding(
      shape({ strokes: [{ "stroke-width": 10, "stroke-alignment": "inner" }] }),
    );
    expect(padding).toEqual({ horizontal: 0, vertical: 0 });
  });

  it("adds the stroke width and the diagonal to an inner path", () => {
    const padding = calculatePadding(
      shape({
        type: "path",
        content: [
          { command: "move-to", params: { x: 0, y: 0 } },
          { command: "line-to", params: { x: 10, y: 0 } },
        ],
        strokes: [{ "stroke-width": 10, "stroke-alignment": "inner" }],
      }),
    );
    // 10 + sqrt(2 * 10 * 10) = 24.1421 -> ceil
    expect(padding).toEqual({ horizontal: 25, vertical: 25 });
  });

  it("adds the cap marker margin of an open path only", () => {
    const stroke = {
      "stroke-width": 10,
      "stroke-alignment": "center",
      "stroke-cap-end": "triangle-arrow",
    };
    const open = calculatePadding(
      shape({
        type: "path",
        content: [
          { command: "move-to", params: { x: 0, y: 0 } },
          { command: "line-to", params: { x: 10, y: 0 } },
        ],
        strokes: [stroke],
      }),
    );
    // 5 + sqrt(2 * 5 * 5) + 4.25 * 10 = 54.5711 -> ceil
    expect(open).toEqual({ horizontal: 55, vertical: 55 });

    const closed = calculatePadding(
      shape({
        type: "path",
        content: [
          { command: "move-to", params: { x: 0, y: 0 } },
          { command: "line-to", params: { x: 10, y: 0 } },
          { command: "line-to", params: { x: 0, y: 0 } },
        ],
        strokes: [stroke],
      }),
    );
    // A path keeps the stroke width in its margin either way; only the cap
    // margin goes away when the path closes.
    expect(closed).toEqual({ horizontal: 13, vertical: 13 });
  });

  it("adds the drop shadow margin per axis and honours the ignore flags", () => {
    const shadow = {
      style: "drop-shadow",
      "offset-x": 3,
      "offset-y": 4,
      blur: 5,
      spread: 2,
    };
    const withShadow = shape({ shadow: [shadow, { ...shadow, hidden: true }] });
    expect(calculatePadding(withShadow)).toEqual({ horizontal: 27, vertical: 28 });
    expect(calculatePadding(withShadow, false, true)).toEqual({ horizontal: 0, vertical: 0 });
    expect(calculatePadding(withShadow, true)).toEqual({ horizontal: 27, vertical: 28 });
  });

  it("ignores the margin entirely when asked to", () => {
    const padding = calculatePadding(
      shape({ strokes: [{ "stroke-width": 10 }], shadow: [{ style: "drop-shadow", blur: 4 }] }),
      true,
      true,
    );
    expect(padding).toEqual({ horizontal: 0, vertical: 0 });
  });
});

describe("getShapeFilterBounds", () => {
  it("uses the points box when no shadow or blur widens the shape", () => {
    const rotated = shape({
      selrect: box(0, 0, 100, 100),
      points: [
        { x: 0, y: 0 },
        { x: 80, y: 20 },
        { x: 60, y: 100 },
        { x: -20, y: 80 },
      ],
    });
    const bounds = getShapeFilterBounds(rotated);
    expect(bounds.x).toBe(-20);
    expect(bounds.width).toBe(100);
    expect(bounds.y).toBe(0);
    expect(bounds.height).toBe(100);
  });

  it("keeps the selrect of an svg-raw child that is not the svg root", () => {
    const bounds = getShapeFilterBounds(
      shape({ type: "svg-raw", content: { tag: "g" }, selrect: box(3, 4, 5, 6) }),
    );
    expect(bounds).toEqual(box(3, 4, 5, 6));
  });

  it("doubles the layer blur around the box", () => {
    const bounds = getShapeFilterBounds(shape({ blur: { type: "layer-blur", value: 2 } }));
    expect(bounds).toEqual(box(-4, -4, 108, 108));
  });

  it("joins the drop shadow rect with the box", () => {
    const bounds = getShapeFilterBounds(
      shape({ shadow: [{ style: "drop-shadow", "offset-x": 5, "offset-y": 0 }] }),
    );
    // filter-x = min(0, 0 + 5 - 5) = 0, width = 100 + 5 + 10
    expect(bounds.x).toBe(0);
    expect(bounds.width).toBe(115);
  });
});

describe("getRectFilterBounds", () => {
  it("is the input when there is nothing to widen", () => {
    expect(getRectFilterBounds(box(1, 2, 3, 4), [], 0)).toEqual(box(1, 2, 3, 4));
  });
});

describe("reduceObjects", () => {
  const objects = {
    root: { id: "root", shapes: ["a", "b"] },
    a: { id: "a", shapes: ["a1"] },
    a1: { id: "a1", shapes: [] },
    b: { id: "b", shapes: [] },
  };

  it("walks depth first and prepends the children", () => {
    const ids = reduceObjects<string[]>(objects, "root", null, (out, item) => {
      out.push(String(item.id));
      return out;
    }, []);
    expect(ids).toEqual(["a", "a1", "b"]);
  });

  it("skips the children of a rejected shape", () => {
    const ids = reduceObjects<string[]>(
      objects,
      "root",
      (item) => item.id !== "a",
      (out, item) => {
        out.push(String(item.id));
        return out;
      },
      [],
    );
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("objectBounds", () => {
  it("unions the visible children of a frame", () => {
    const objects = {
      frame: shape({ id: "frame", type: "frame", "show-content": true, shapes: ["child"] }),
      child: shape({ id: "child", selrect: box(200, 0, 50, 50) }),
    };
    const bounds = objectBounds(objects, objects.frame, { ignoreMargin: false });
    expect(bounds).toEqual(box(0, 0, 250, 100));
  });

  it("keeps the frame box when its content is hidden", () => {
    const objects = {
      frame: shape({ id: "frame", type: "frame", "show-content": false, shapes: ["child"] }),
      child: shape({ id: "child", selrect: box(200, 0, 50, 50) }),
    };
    const bounds = objectBounds(objects, objects.frame, { ignoreMargin: false });
    expect(bounds).toEqual(box(0, 0, 100, 100));
  });

  it("skips hidden children", () => {
    const objects = {
      frame: shape({ id: "frame", type: "frame", "show-content": true, shapes: ["child"] }),
      child: shape({ id: "child", hidden: true, selrect: box(200, 0, 50, 50) }),
    };
    const bounds = objectBounds(objects, objects.frame, { ignoreMargin: false });
    expect(bounds).toEqual(box(0, 0, 100, 100));
  });

  it("stops at a masked group or a bool shape", () => {
    const masked = {
      group: shape({ id: "group", type: "group", "masked-group": true, shapes: ["child"] }),
      child: shape({ id: "child", selrect: box(200, 0, 50, 50) }),
    };
    expect(objectBounds(masked, masked.group, { ignoreMargin: false })).toEqual(box(0, 0, 100, 100));

    const bool = {
      group: shape({ id: "group", type: "bool", shapes: ["child"] }),
      child: shape({ id: "child", selrect: box(200, 0, 50, 50) }),
    };
    expect(objectBounds(bool, bool.group, { ignoreMargin: false })).toEqual(box(0, 0, 100, 100));
  });

  it("adds the children of a group", () => {
    const objects = {
      group: shape({ id: "group", type: "group", shapes: ["child"] }),
      child: shape({ id: "child", selrect: box(100, 0, 50, 50) }),
    };
    const bounds = objectBounds(objects, objects.group, { ignoreMargin: false });
    expect(bounds).toEqual(box(0, 0, 150, 100));
  });

  it("expands the result with the shape's own drop shadow", () => {
    const target = shape({ shadow: [{ style: "drop-shadow", "offset-x": 5 }] });
    const bounds = objectBounds({ "shape-1": target }, target);
    // base: filter box 0..115 with the 15 padding -> -15..130
    // final filter: another 5 + 10 wider than the base join
    expect(bounds.x).toBe(-15);
    expect(bounds.width).toBe(160);
  });
});
