import { describe, expect, it } from "vitest";
import {
  applySvgDerived,
  applySvgFilters,
  resolveShapeFills,
  svgFillToFills,
  type SvgDerivedShape,
} from "./svg-derived";
import type { SvgNode } from "./upload";

const nextId = () => "generated-id";

function linearDefs(): Record<string, SvgNode> {
  return {
    grad: {
      tag: "linearGradient",
      attrs: {
        gradientUnits: "objectBoundingBox",
        x1: "0%",
        y1: "0%",
        x2: "100%",
        y2: "0%",
      },
      content: [
        { tag: "stop", attrs: { offset: "0", "stop-color": "#ffffff" } },
        {
          tag: "stop",
          attrs: { offset: "100%", "stop-color": "rgb(0, 0, 0)", "stop-opacity": "0.5" },
        },
      ],
    },
  };
}

describe("svgFillToFills", () => {
  it("prefers the style fill and reads its opacity", () => {
    expect(
      svgFillToFills({
        "svg-attrs": { style: { fill: "currentColor", fillOpacity: 0.5 } },
      }),
    ).toEqual([{ "fill-color": "#000000", "fill-opacity": 0.5 }]);
  });

  it("falls back to the fill attribute", () => {
    expect(
      svgFillToFills({ "svg-attrs": { style: { fill: "none" }, fill: "red" } }),
    ).toEqual([{ "fill-color": "#ff0000" }]);
  });

  it("derives nothing from none or an unknown paint", () => {
    expect(svgFillToFills({ "svg-attrs": { fill: "none" } })).toBeUndefined();
    expect(svgFillToFills({ "svg-attrs": { fill: "paint(1)" } })).toBeUndefined();
    expect(svgFillToFills({})).toBeUndefined();
  });

  it("reads a linear gradient with its stops", () => {
    expect(
      svgFillToFills({
        "svg-attrs": { fill: "url(#grad)" },
        "svg-defs": linearDefs(),
      }),
    ).toEqual([
      {
        "fill-color-gradient": {
          type: "linear",
          "start-x": 0,
          "start-y": 0,
          "end-x": 1,
          "end-y": 0,
          width: 1,
          stops: [
            { color: "#ffffff", offset: 0 },
            { color: "#000000", opacity: 0.5, offset: 1 },
          ],
        },
      },
    ]);
  });

  it("follows the href chain, the referenced node first", () => {
    const defs: Record<string, SvgNode> = {
      base: {
        tag: "linearGradient",
        attrs: { x1: "0", x2: "1" },
        content: [{ tag: "stop", attrs: { offset: "0", "stop-color": "red" } }],
      },
      alias: {
        tag: "linearGradient",
        attrs: { "xlink:href": "#base", x1: "0.5" },
        content: [],
      },
    };

    const fills = svgFillToFills({
      "svg-attrs": { fill: "url(#alias)" },
      "svg-defs": defs,
    });

    expect(fills?.[0]["fill-color-gradient"]).toMatchObject({
      type: "linear",
      "start-x": 0.5,
      "end-x": 1,
      stops: [{ color: "#ff0000", offset: 0 }],
    });
  });

  it("builds a radial gradient with the y radius as the base", () => {
    const defs: Record<string, SvgNode> = {
      radial: {
        tag: "radialGradient",
        attrs: { cx: "0.5", cy: "0.5", r: "0.25" },
        content: [{ tag: "stop", attrs: { offset: "0", "stop-color": "blue" } }],
      },
    };

    const fills = svgFillToFills({
      "svg-attrs": { fill: "url(#radial)" },
      "svg-defs": defs,
    });

    expect(fills?.[0]["fill-color-gradient"]).toMatchObject({
      type: "radial",
      "start-x": 0.5,
      "start-y": 0.5,
      "end-x": 0.5,
      "end-y": 0.75,
      width: 1,
    });
  });

  it("maps user space coordinates through the viewBox", () => {
    const defs: Record<string, SvgNode> = {
      grad: {
        tag: "linearGradient",
        attrs: {
          gradientUnits: "userSpaceOnUse",
          x1: "0",
          y1: "0",
          x2: "50",
          y2: "50",
        },
        content: [{ tag: "stop", attrs: { offset: "0", "stop-color": "lime" } }],
      },
    };

    const shape: SvgDerivedShape = {
      selrect: { x: 10, y: 20, width: 200, height: 100 },
      "svg-viewbox": { x: 0, y: 0, width: 100, height: 100 },
      "svg-attrs": { fill: "url(#grad)" },
      "svg-defs": defs,
    };

    expect(svgFillToFills(shape)?.[0]["fill-color-gradient"]).toMatchObject({
      "start-x": 0,
      "start-y": 0,
      "end-x": 0.5,
      "end-y": 0.5,
    });
  });

  it("applies the gradient transform", () => {
    const defs: Record<string, SvgNode> = {
      grad: {
        tag: "linearGradient",
        attrs: {
          gradientTransform: "translate(0.5 0)",
          x1: "0",
          y1: "0",
          x2: "1",
          y2: "0",
        },
        content: [{ tag: "stop", attrs: { offset: "0", "stop-color": "red" } }],
      },
    };

    expect(
      svgFillToFills({ "svg-attrs": { fill: "url(#grad)" }, "svg-defs": defs })?.[0][
        "fill-color-gradient"
      ],
    ).toMatchObject({ "start-x": 0.5, "end-x": 1.5 });
  });

  it("ignores a referenced node that is not a gradient", () => {
    const defs: Record<string, SvgNode> = {
      grad: { tag: "filter", attrs: {}, content: [] },
    };

    expect(
      svgFillToFills({ "svg-attrs": { fill: "url(#grad)" }, "svg-defs": defs }),
    ).toBeUndefined();
  });
});

describe("resolveShapeFills", () => {
  it("keeps the model fills", () => {
    const shape: SvgDerivedShape = {
      fills: [{ "fill-color": "#123456" }],
      "svg-attrs": { fill: "red" },
    };
    expect(resolveShapeFills(shape)).toEqual([{ "fill-color": "#123456" }]);
  });

  it("falls back to the svg fill", () => {
    expect(resolveShapeFills({ "svg-attrs": { fill: "red" } })).toEqual([
      { "fill-color": "#ff0000" },
    ]);
  });

  it("defaults raw svg shapes to black", () => {
    expect(resolveShapeFills({ type: "svg-raw", "svg-attrs": {} })).toEqual([
      { "fill-color": "#000000", "fill-opacity": 1 },
    ]);
    expect(resolveShapeFills({ type: "group", "svg-attrs": {} })).toEqual([
      { "fill-color": "#000000", "fill-opacity": 1 },
    ]);
  });

  it("answers an empty list when nothing applies", () => {
    expect(resolveShapeFills({ type: "rect", "svg-attrs": {} })).toEqual([]);
    expect(resolveShapeFills({ type: "svg-raw" })).toEqual([]);
  });
});

describe("applySvgFilters", () => {
  it("turns a gaussian blur into a layer blur", () => {
    const shape: SvgDerivedShape = {
      "svg-attrs": { filter: "url(#f)" },
      "svg-defs": {
        f: {
          tag: "filter",
          content: [{ tag: "feGaussianBlur", attrs: { stdDeviation: "4" } }],
        },
      },
    };

    const result = applySvgFilters(shape, nextId);
    expect(result).not.toBe(shape);
    expect(result.blur).toEqual({
      id: "generated-id",
      type: "layer-blur",
      value: 4,
      hidden: false,
    });
    expect(result.shadow).toBeUndefined();
  });

  it("reads the filter from the style attribute too", () => {
    const result = applySvgFilters(
      {
        "svg-attrs": { style: { filter: "url(#f)" } },
        "svg-defs": {
          f: {
            tag: "filter",
            content: [{ tag: "feGaussianBlur", attrs: { stdDeviation: "2" } }],
          },
        },
      },
      nextId,
    );

    expect(result.blur?.value).toBe(2);
  });

  it("builds a drop shadow from the offset chain", () => {
    const result = applySvgFilters(
      {
        "svg-attrs": { filter: "url(#f)" },
        "svg-defs": {
          f: {
            tag: "filter",
            content: [
              { tag: "feGaussianBlur", attrs: { stdDeviation: "3" } },
              { tag: "feOffset", attrs: { dx: "5", dy: "6" } },
              {
                tag: "feFlood",
                attrs: { "flood-color": "blue", "flood-opacity": "0.25" },
              },
            ],
          },
        },
      },
      nextId,
    );

    expect(result.blur).toBeUndefined();
    expect(result.shadow).toEqual([
      {
        id: "generated-id",
        style: "drop-shadow",
        "offset-x": 5,
        "offset-y": 6,
        blur: 6,
        spread: 0,
        hidden: false,
        color: { color: "#0000ff", opacity: 0.25 },
      },
    ]);
  });

  it("reads the shadow colour from the colour matrix", () => {
    const result = applySvgFilters(
      {
        "svg-attrs": { filter: "url(#f)" },
        "svg-defs": {
          f: {
            tag: "filter",
            content: [
              { tag: "feOffset", attrs: { dx: "1", dy: "2" } },
              {
                tag: "feColorMatrix",
                attrs: {
                  type: "matrix",
                  values: "0 0 0 0 1  0 0 0 0 0.5  0 0 0 0 0  0 0 0 0.5 0.25",
                },
              },
            ],
          },
        },
      },
      nextId,
    );

    expect(result.shadow?.[0].color).toEqual({ color: "#ff8000", opacity: 0.75 });
    expect(result.shadow?.[0].blur).toBe(0);
  });

  it("defaults an feDropShadow to two", () => {
    const result = applySvgFilters(
      {
        "svg-attrs": { filter: "url(#f)" },
        "svg-defs": {
          f: {
            tag: "filter",
            content: [{ tag: "feDropShadow", attrs: { dx: "1" } }],
          },
        },
      },
      nextId,
    );

    expect(result.shadow).toEqual([
      {
        id: "generated-id",
        style: "drop-shadow",
        "offset-x": 1,
        "offset-y": 2,
        blur: 4,
        spread: 0,
        hidden: false,
        color: { color: "#000000", opacity: 1 },
      },
    ]);
  });

  it("keeps the effects the shape already has", () => {
    const blur = { id: "own-blur", type: "layer-blur", value: 9, hidden: false };
    const shadow = [{ id: "own-shadow", style: "drop-shadow" }];

    const result = applySvgFilters(
      {
        blur,
        shadow,
        "svg-attrs": { filter: "url(#f)" },
        "svg-defs": {
          f: {
            tag: "filter",
            content: [{ tag: "feGaussianBlur", attrs: { stdDeviation: "2" } }],
          },
        },
      },
      nextId,
    );

    expect(result.blur).toBe(blur);
    expect(result.shadow).toBe(shadow);
    expect(result.shadow).toHaveLength(1);
  });

  it("returns the shape untouched without a filter def", () => {
    const shape: SvgDerivedShape = { "svg-attrs": {} };
    expect(applySvgFilters(shape, nextId)).toBe(shape);

    const missing: SvgDerivedShape = {
      "svg-attrs": { filter: "url(#nope)" },
      "svg-defs": {},
    };
    expect(applySvgFilters(missing, nextId)).toBe(missing);
  });
});

describe("applySvgDerived", () => {
  it("always carries the three keys", () => {
    const result = applySvgDerived({ type: "rect", "svg-attrs": null }, nextId);

    expect(result.fills).toEqual([]);
    expect(Object.prototype.hasOwnProperty.call(result, "blur")).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(result, "shadow")).toBe(true);
    expect(result.blur).toBeUndefined();
    expect(result.shadow).toBeUndefined();
  });

  it("combines the derived fill with the filter effects", () => {
    const result = applySvgDerived(
      {
        type: "svg-raw",
        "svg-attrs": { fill: "#112233", filter: "url(#f)" },
        "svg-defs": {
          f: {
            tag: "filter",
            content: [{ tag: "feGaussianBlur", attrs: { stdDeviation: "1.5" } }],
          },
        },
      },
      nextId,
    );

    expect(result.fills).toEqual([{ "fill-color": "#112233" }]);
    expect(result.blur).toEqual({
      id: "generated-id",
      type: "layer-blur",
      value: 1.5,
      hidden: false,
    });
  });
});