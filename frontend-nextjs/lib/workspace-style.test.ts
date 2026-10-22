// Unit tests for the workspace style model (lib/workspace-style): the
// immutable fill/stroke surgery, the shape defaults and the mod-obj change
// the panel sends. The module is pure, so every branch runs in node.

import { describe, expect, it } from "vitest";

import type { WorkspaceShape } from "@/lib/workspace";
import {
  DEFAULT_FILL,
  DEFAULT_STROKE,
  addFill,
  addStroke,
  buildStyleChange,
  fillsOf,
  isSolidFill,
  isSolidStroke,
  radiusOf,
  removeFill,
  removeStroke,
  shapeBlocked,
  shapeHidden,
  shapeOpacity,
  strokesOf,
  supportsFillStroke,
  withFillColor,
  withFillOpacity,
  withStrokeColor,
  withStrokeOpacity,
  withStrokeWidth,
} from "@/lib/workspace-style";

function shape(attrs: Record<string, unknown> = {}): WorkspaceShape {
  return { id: "shape-1", type: "rect", ...attrs };
}

describe("defaults", () => {
  it("uses the CLJS default fill and stroke", () => {
    expect(DEFAULT_FILL).toEqual({ "fill-color": "#B1B2B5", "fill-opacity": 1 });
    expect(DEFAULT_STROKE).toEqual({
      "stroke-color": "#000000",
      "stroke-opacity": 1,
      "stroke-width": 1,
      "stroke-alignment": "inner",
      "stroke-style": "solid",
    });
  });

  it("reads missing fill/stroke lists as empty arrays", () => {
    expect(fillsOf(shape())).toEqual([]);
    expect(strokesOf(shape())).toEqual([]);
    expect(fillsOf(shape({ fills: null }))).toEqual([]);
    expect(strokesOf(shape({ strokes: "nope" }))).toEqual([]);
  });

  it("copies the array but shares the elements", () => {
    const fill = { "fill-color": "#112233", "fill-opacity": 1 };
    const shapeWithFill = shape({ fills: [fill] });
    const fills = fillsOf(shapeWithFill);
    expect(fills).not.toBe(shapeWithFill.fills);
    expect(fills[0]).toBe(fill);
  });
});

describe("solid detection", () => {
  it("accepts a plain fill and rejects gradients, images and non-objects", () => {
    expect(isSolidFill({ "fill-color": "#000000", "fill-opacity": 1 })).toBe(true);
    expect(isSolidFill({ "fill-color": "#000000", "fill-color-gradient": {} })).toBe(false);
    expect(isSolidFill({ "fill-color": "#000000", "fill-image": { id: "img" } })).toBe(false);
    expect(isSolidFill({ "fill-opacity": 1 })).toBe(false);
    expect(isSolidFill(null)).toBe(false);
  });

  it("accepts a plain stroke and rejects stroke images", () => {
    expect(isSolidStroke(DEFAULT_STROKE)).toBe(true);
    expect(isSolidStroke({ ...DEFAULT_STROKE, "stroke-image": { id: "img" } })).toBe(false);
    expect(isSolidStroke(null)).toBe(false);
  });
});

describe("fills", () => {
  it("prepends the default fill", () => {
    const existing = { "fill-color": "#112233", "fill-opacity": 1 };
    const next = addFill([existing]);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(DEFAULT_FILL);
    expect(next[1]).toBe(existing);
    expect(next[0]).not.toBe(DEFAULT_FILL);
  });

  it("removes by index and ignores an out-of-range index", () => {
    const a = { "fill-color": "#111111" };
    const b = { "fill-color": "#222222" };
    expect(removeFill([a, b], 0)).toEqual([b]);
    expect(removeFill([a, b], 5)).toEqual([a, b]);
  });

  it("updates one fill preserving the other keys and the input array", () => {
    const first = { "fill-color": "#111111", "fill-opacity": 0.5, extra: true };
    const second = { "fill-color": "#222222", "fill-opacity": 1 };
    const fills = [first, second];
    const next = withFillColor(fills, 0, "#ABCDEF");
    expect(next[0]).toEqual({
      "fill-color": "#ABCDEF",
      "fill-opacity": 0.5,
      extra: true,
    });
    expect(next[1]).toBe(second);
    expect(fills[0]).toBe(first);
  });

  it("clamps the fill opacity and leaves other rows alone", () => {
    const fills = [{ "fill-color": "#111111", "fill-opacity": 1 }];
    expect(withFillOpacity(fills, 0, 2)[0]).toMatchObject({ "fill-opacity": 1 });
    expect(withFillOpacity(fills, 0, -1)[0]).toMatchObject({ "fill-opacity": 0 });
    expect(withFillOpacity(fills, 9, 0.5)).toEqual(fills);
  });
});

describe("strokes", () => {
  it("prepends the default stroke without sharing the object", () => {
    const existing = { "stroke-color": "#112233", "stroke-width": 4 };
    const next = addStroke([existing]);
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual(DEFAULT_STROKE);
    expect(next[0]).not.toBe(DEFAULT_STROKE);
    expect(next[1]).toBe(existing);
  });

  it("removes by index", () => {
    const a = { "stroke-color": "#111111" };
    const b = { "stroke-color": "#222222" };
    expect(removeStroke([a, b], 1)).toEqual([a]);
    expect(removeStroke([a, b], 9)).toEqual([a, b]);
  });

  it("updates the color, width and opacity preserving the other keys", () => {
    const stroke = {
      "stroke-color": "#111111",
      "stroke-width": 2,
      "stroke-opacity": 0.5,
      "stroke-alignment": "inner",
    };
    const colored = withStrokeColor([stroke], 0, "#00FF00")[0] as Record<string, unknown>;
    expect(colored).toEqual({ ...stroke, "stroke-color": "#00FF00" });

    const wider = withStrokeWidth([stroke], 0, 8)[0] as Record<string, unknown>;
    expect(wider).toEqual({ ...stroke, "stroke-width": 8 });

    const faded = withStrokeOpacity([stroke], 0, 0.25)[0] as Record<string, unknown>;
    expect(faded).toEqual({ ...stroke, "stroke-opacity": 0.25 });
  });

  it("clamps the width at zero and the opacity to 0..1", () => {
    const stroke = { "stroke-color": "#111111", "stroke-width": 1, "stroke-opacity": 1 };
    expect(withStrokeWidth([stroke], 0, -3)[0]).toMatchObject({ "stroke-width": 0 });
    expect(withStrokeOpacity([stroke], 0, 4)[0]).toMatchObject({ "stroke-opacity": 1 });
    expect(withStrokeOpacity([stroke], 0, -4)[0]).toMatchObject({ "stroke-opacity": 0 });
  });
});

describe("shape flags and radius", () => {
  it("reads opacity, hidden and blocked with their defaults", () => {
    expect(shapeOpacity(shape())).toBe(1);
    expect(shapeOpacity(shape({ opacity: 0.4 }))).toBe(0.4);
    expect(shapeOpacity(shape({ opacity: 3 }))).toBe(1);
    expect(shapeHidden(shape())).toBe(false);
    expect(shapeHidden(shape({ hidden: true }))).toBe(true);
    expect(shapeBlocked(shape())).toBe(false);
    expect(shapeBlocked(shape({ blocked: true }))).toBe(true);
    // :locked is not the CLJS lock attribute.
    expect(shapeBlocked(shape({ locked: true }))).toBe(false);
  });

  it("reads the four radii, missing values as zero", () => {
    expect(radiusOf(shape())).toEqual([0, 0, 0, 0]);
    expect(radiusOf(shape({ r1: 4, r2: -2, r3: 8 }))).toEqual([4, 0, 8, 0]);
    expect(radiusOf(shape({ r1: 1, r2: 2, r3: 3, r4: 4 }))).toEqual([1, 2, 3, 4]);
  });
});

describe("supportsFillStroke", () => {
  it("allows the painted types", () => {
    for (const type of ["rect", "circle", "frame", "path", "bool", "image"]) {
      expect(supportsFillStroke(type)).toBe(true);
    }
  });

  it("gates text, group and svg-raw out", () => {
    expect(supportsFillStroke("text")).toBe(false);
    expect(supportsFillStroke("group")).toBe(false);
    expect(supportsFillStroke("svg-raw")).toBe(false);
  });
});

describe("buildStyleChange", () => {
  it("produces one mod-obj with one set per attribute", () => {
    const fills = [{ "fill-color": "#123456", "fill-opacity": 1 }];
    const change = buildStyleChange("shape-1", "page-1", {
      fills,
      opacity: 0.5,
      r1: 2,
      r2: 2,
      r3: 2,
      r4: 2,
    });
    expect(change.type).toBe("mod-obj");
    expect(change.id).toBe("shape-1");
    expect(change["page-id"]).toBe("page-1");
    expect(change.operations).toEqual([
      { type: "set", attr: "fills", val: fills },
      { type: "set", attr: "opacity", val: 0.5 },
      { type: "set", attr: "r1", val: 2 },
      { type: "set", attr: "r2", val: 2 },
      { type: "set", attr: "r3", val: 2 },
      { type: "set", attr: "r4", val: 2 },
    ]);
  });

  it("keeps the envelope untouched for a single attribute", () => {
    const change = buildStyleChange("shape-2", "page-2", { blocked: true });
    expect(change).toEqual({
      type: "mod-obj",
      id: "shape-2",
      "page-id": "page-2",
      operations: [{ type: "set", attr: "blocked", val: true }],
    });
  });
});
