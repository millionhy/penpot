// Unit tests for the workspace style model (lib/workspace-style): the
// immutable fill/stroke/shadow/blur surgery, the shape defaults and the
// mod-obj change the panel sends. The module is pure, so every branch runs in
// node.

import { describe, expect, it } from "vitest";

import type { WorkspaceShape } from "@/lib/workspace";
import {
  DEFAULT_FILL,
  DEFAULT_STROKE,
  addBlur,
  addFill,
  addShadow,
  addStroke,
  blurOf,
  buildStyleChange,
  fillsOf,
  isSolidFill,
  isSolidStroke,
  radiusOf,
  removeFill,
  removeShadow,
  removeStroke,
  shapeBlocked,
  shapeHidden,
  shapeOpacity,
  shadowsOf,
  shadowsPatch,
  strokesOf,
  supportsFillStroke,
  withBlurHidden,
  withBlurValue,
  withFillColor,
  withFillOpacity,
  withShadowColor,
  withShadowHidden,
  withShadowNumber,
  withShadowOpacity,
  withShadowStyle,
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

describe("shadows", () => {
  const SHADOW = {
    id: "shadow-1",
    style: "drop-shadow",
    "offset-x": 4,
    "offset-y": 4,
    blur: 4,
    spread: 0,
    hidden: false,
    color: { color: "#000000", opacity: 0.2 },
  };

  it("reads the list, a missing or malformed value as none", () => {
    expect(shadowsOf(shape({ shadow: [SHADOW] }))).toEqual([SHADOW]);
    expect(shadowsOf(shape())).toEqual([]);
    expect(shadowsOf(shape({ shadow: null }))).toEqual([]);
    expect(shadowsOf(shape({ shadow: SHADOW }))).toEqual([]);
  });

  it("prepends the CLJS default shadow and keeps the existing order", () => {
    const next = addShadow([SHADOW], "shadow-2");
    expect(next).toHaveLength(2);
    expect(next[0]).toEqual({
      id: "shadow-2",
      style: "drop-shadow",
      "offset-x": 4,
      "offset-y": 4,
      blur: 4,
      spread: 0,
      hidden: false,
      color: { color: "#000000", opacity: 0.2 },
    });
    expect(next[1]).toBe(SHADOW);
  });

  it("removes by index and ignores an out-of-range index", () => {
    const other = { ...SHADOW, id: "shadow-2" };
    expect(removeShadow([SHADOW, other], 0)).toEqual([other]);
    expect(removeShadow([SHADOW, other], 7)).toEqual([SHADOW, other]);
  });

  it("replaces the list with a nil val when the last shadow goes", () => {
    const shadows = [SHADOW];
    expect(shadowsPatch([])).toBeNull();
    expect(shadowsPatch(shadows)).toEqual(shadows);
    expect(shadowsPatch(shadows)).not.toBe(shadows);
  });

  it("edits the numeric fields, clamping the blur at zero", () => {
    const moved = withShadowNumber([SHADOW], 0, "offset-x", -12)[0] as Record<string, unknown>;
    expect(moved).toEqual({ ...SHADOW, "offset-x": -12 });
    const blurred = withShadowNumber([SHADOW], 0, "blur", -3)[0] as Record<string, unknown>;
    expect(blurred).toEqual({ ...SHADOW, blur: 0 });
    const spread = withShadowNumber([SHADOW], 0, "spread", 6)[0] as Record<string, unknown>;
    expect(spread).toEqual({ ...SHADOW, spread: 6 });
  });

  it("ignores a non-finite number and an out-of-range index", () => {
    const shadows = [SHADOW];
    expect(withShadowNumber(shadows, 0, "blur", Number.NaN)[0]).toBe(SHADOW);
    expect(withShadowNumber(shadows, 3, "blur", 8)[0]).toBe(SHADOW);
  });

  it("keeps the style inside the schema enum", () => {
    expect(withShadowStyle([SHADOW], 0, "inner-shadow")[0]).toMatchObject({
      style: "inner-shadow",
    });
    expect(withShadowStyle([SHADOW], 0, "glow")[0]).toBe(SHADOW);
  });

  it("flips the visibility", () => {
    expect(withShadowHidden([SHADOW], 0, true)[0]).toMatchObject({ hidden: true });
    expect(withShadowHidden([SHADOW], 0, false)[0]).toMatchObject({ hidden: false });
  });

  it("merges the color and the opacity into the nested color map", () => {
    const linked = {
      ...SHADOW,
      color: { color: "#111111", opacity: 0.3, "ref-id": "color-1", "ref-file": "file-1" },
    };
    expect(withShadowColor([linked], 0, "#00FF00")[0]).toMatchObject({
      color: {
        color: "#00FF00",
        opacity: 0.3,
        "ref-id": "color-1",
        "ref-file": "file-1",
      },
    });
    expect(withShadowOpacity([SHADOW], 0, 0.75)[0]).toMatchObject({
      color: { color: "#000000", opacity: 0.75 },
    });
    expect(withShadowOpacity([SHADOW], 0, 4)[0]).toMatchObject({
      color: { opacity: 1 },
    });
  });

  it("leaves the other shadows and the input array untouched", () => {
    const other = { ...SHADOW, id: "shadow-2" };
    const shadows = [SHADOW, other];
    const next = withShadowNumber(shadows, 0, "offset-y", 9);
    expect(next[1]).toBe(other);
    expect(shadows[0]).toBe(SHADOW);
  });
});

describe("blur", () => {
  const BLUR = { id: "blur-1", type: "layer-blur", value: 4, hidden: false };

  it("reads the single map, a missing or malformed value as none", () => {
    expect(blurOf(shape({ blur: BLUR }))).toEqual(BLUR);
    expect(blurOf(shape())).toBeNull();
    expect(blurOf(shape({ blur: "nope" }))).toBeNull();
  });

  it("creates the CLJS default layer blur", () => {
    expect(addBlur("blur-2")).toEqual({
      id: "blur-2",
      type: "layer-blur",
      value: 4,
      hidden: false,
    });
  });

  it("edits the value and the visibility, clamping at zero", () => {
    expect(withBlurValue(BLUR, -2)).toEqual({ ...BLUR, value: 0 });
    expect(withBlurValue(BLUR, 12)).toEqual({ ...BLUR, value: 12 });
    expect(withBlurHidden(BLUR, true)).toEqual({ ...BLUR, hidden: true });
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
