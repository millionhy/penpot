import { describe, expect, it } from "vitest";
import {
  applySvgDerived,
  applySvgFilters,
  resolveShapeFills,
  svgFillToFills,
} from "./svg-derived.js";
import type { Shape, Shadow, SvgNode } from "./upload.js";

const SHAPE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

function shape(overrides: Partial<Shape> = {}): Shape {
  return { id: SHAPE_ID, type: "rect", ...overrides };
}

// UUIDs are generated per call, so compare everything else.
function withoutIds(shadows: readonly Shadow[] | null | undefined): Omit<Shadow, "id">[] {
  return (shadows ?? []).map((shadow) => {
    const { id: _id, ...rest } = shadow;
    return rest;
  });
}

const radialSeed: Shape = shape({
  selrect: { x: 100, y: 200, width: 200, height: 100 },
  "svg-attrs": { fillOpacity: "0.5", style: { fill: "url(#grad)" } },
  "svg-defs": {
    grad: {
      tag: "radialGradient",
      attrs: { id: "grad", gradientUnits: "userSpaceOnUse", cx: "150", cy: "250", r: "50" },
      content: [
        { tag: "stop", attrs: { offset: "0", style: "stop-color:#ff0000;stop-opacity:1" } },
        { tag: "stop", attrs: { offset: "1", style: "stop-color:#00ff00;stop-opacity:0" } },
      ],
    },
  },
});

describe("svgFillToFills", () => {
  it("builds a radial gradient in user space and keeps the fill opacity", () => {
    const fills = svgFillToFills(radialSeed);

    expect(fills).toHaveLength(1);
    expect(fills?.[0]["fill-color-gradient"]).toMatchObject({
      type: "radial",
      "start-x": 0.25,
      "start-y": 0.5,
      "end-x": 0.25,
      "end-y": 1,
      width: 0.5,
    });
    expect(fills?.[0]["fill-color-gradient"]?.stops).toEqual([
      { color: "#ff0000", opacity: 1, offset: 0 },
      { color: "#00ff00", opacity: 0, offset: 1 },
    ]);
    expect(fills?.[0]["fill-opacity"]).toBe(0.5);
  });

  it("keeps the elliptical radius from gradientTransform", () => {
    const elliptical = shape({
      selrect: { x: 0, y: 0, width: 200, height: 100 },
      "svg-attrs": { style: { fill: "url(#grad-ellipse)" } },
      "svg-defs": {
        "grad-ellipse": {
          tag: "radialGradient",
          attrs: {
            id: "grad-ellipse",
            gradientUnits: "userSpaceOnUse",
            cx: "50",
            cy: "50",
            r: "50",
            gradientTransform: "matrix(2 0 0 1 0 0)",
          },
          content: [
            { tag: "stop", attrs: { offset: "0", style: "stop-color:#000000;stop-opacity:1" } },
            { tag: "stop", attrs: { offset: "1", style: "stop-color:#ffffff;stop-opacity:1" } },
          ],
        },
      },
    });

    expect(svgFillToFills(elliptical)?.[0]["fill-color-gradient"]).toMatchObject({
      type: "radial",
      "start-x": 0.5,
      "start-y": 0.5,
      "end-x": 0.5,
      "end-y": 1,
      width: 1,
    });
  });

  it("inherits attributes and stops through xlink:href", () => {
    const linked = shape({
      selrect: { x: 0, y: 0, width: 100, height: 50 },
      "svg-attrs": { fill: "url(#child)" },
      "svg-defs": {
        parent: {
          tag: "linearGradient",
          attrs: { x1: "0", y1: "0", x2: "1", y2: "1" },
          content: [
            { tag: "stop", attrs: { offset: "0", "stop-color": "red" } },
            { tag: "stop", attrs: { offset: "1", "stop-color": "#00ff00" } },
          ],
        },
        child: { tag: "linearGradient", attrs: { "xlink:href": "#parent" } },
      },
    });

    expect(svgFillToFills(linked)?.[0]["fill-color-gradient"]).toMatchObject({
      type: "linear",
      "start-x": 0,
      "start-y": 0,
      "end-x": 1,
      "end-y": 1,
      width: 1,
    });
    expect(svgFillToFills(linked)?.[0]["fill-color-gradient"]?.stops?.map((stop) => stop.color)).toEqual([
      "#ff0000",
      "#00ff00",
    ]);
  });

  it("parses a plain color fill and skips none", () => {
    expect(svgFillToFills(shape({ "svg-attrs": { fill: "#fabada" } }))).toEqual([
      { "fill-color": "#fabada" },
    ]);
    expect(svgFillToFills(shape({ "svg-attrs": { fill: "none" } }))).toBeUndefined();
    expect(svgFillToFills(shape())).toBeUndefined();
  });

  it("treats currentColor as black", () => {
    expect(svgFillToFills(shape({ "svg-attrs": { fill: "currentColor" } }))).toEqual([
      { "fill-color": "#000000" },
    ]);
  });
});

describe("resolveShapeFills", () => {
  it("prefers existing fills", () => {
    const fills = [{ "fill-color": "#ff00ff", "fill-opacity": 0.75 }];
    expect(resolveShapeFills(shape({ fills }))).toEqual(fills);
  });

  it("falls back to the SVG fill", () => {
    expect(resolveShapeFills({ ...radialSeed, fills: [] })).toEqual(svgFillToFills(radialSeed));
  });

  it("defaults to black for svg-raw and group shapes with svg-attrs", () => {
    expect(resolveShapeFills(shape({ type: "group", "svg-attrs": {} }))).toEqual([
      { "fill-color": "#000000", "fill-opacity": 1 },
    ]);
    expect(resolveShapeFills(shape({ type: "rect", "svg-attrs": {} }))).toEqual([]);
  });

  it("accepts a hex fill on svg-raw", () => {
    expect(resolveShapeFills(shape({ type: "svg-raw", "svg-attrs": { fill: "#fabada" } }))).toEqual([
      { "fill-color": "#fabada" },
    ]);
  });
});

describe("applySvgFilters", () => {
  function filterShape(content: readonly SvgNode[]): Shape {
    return shape({
      "svg-attrs": { filter: "url(#f)" },
      "svg-defs": { f: { tag: "filter", content } },
    });
  }

  it("derives a drop shadow from the offset chain without blurring the shape", () => {
    const filtered = applySvgFilters(
      shape({
        "svg-attrs": { filter: "url(#simple-filter)" },
        "svg-defs": {
          "simple-filter": {
            tag: "filter",
            content: [
              { tag: "feOffset", attrs: { dx: "2", dy: "3" } },
              { tag: "feGaussianBlur", attrs: { stdDeviation: "4" } },
            ],
          },
        },
      }),
    );

    expect(filtered.blur).toBeUndefined();
    expect(withoutIds(filtered.shadow)).toEqual([
      {
        style: "drop-shadow",
        "offset-x": 2,
        "offset-y": 3,
        blur: 8,
        spread: 0,
        hidden: false,
        color: { color: "#000000", opacity: 1 },
      },
    ]);
    expect(filtered["svg-attrs"]?.filter).toBe("url(#simple-filter)");
  });

  it("derives a layer blur from a blur-only filter", () => {
    const filtered = applySvgFilters(
      filterShape([{ tag: "feGaussianBlur", attrs: { stdDeviation: "4" } }]),
    );

    expect(filtered.blur).toMatchObject({ type: "layer-blur", value: 4, hidden: false });
    expect(filtered.shadow).toBeUndefined();
  });

  it("reads the shadow color from the last color matrix after the offset", () => {
    const filtered = applySvgFilters(
      filterShape([
        { tag: "feOffset", attrs: { in: "SourceAlpha", dx: "12", dy: "12" } },
        { tag: "feGaussianBlur", attrs: { stdDeviation: "4" } },
        {
          tag: "feColorMatrix",
          attrs: {
            type: "matrix",
            values: "0 0 0 0 1  0 0 0 0 0  0 0 0 0 0  0 0 0 0.3 0",
          },
        },
      ]),
    );

    expect(withoutIds(filtered.shadow)[0].color).toEqual({ color: "#ff0000", opacity: 0.3 });
  });

  it("ignores a hard-alpha matrix placed before the offset", () => {
    const filtered = applySvgFilters(
      filterShape([
        { tag: "feFlood", attrs: { "flood-opacity": "0" } },
        {
          tag: "feColorMatrix",
          attrs: {
            in: "SourceAlpha",
            type: "matrix",
            values: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0",
          },
        },
        { tag: "feOffset", attrs: { dy: "4" } },
        { tag: "feGaussianBlur", attrs: { stdDeviation: "2" } },
        {
          tag: "feColorMatrix",
          attrs: { type: "matrix", values: "0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.25 0" },
        },
      ]),
    );

    expect(withoutIds(filtered.shadow)[0].color).toEqual({ color: "#000000", opacity: 0.25 });
  });

  it("reads the shadow color from a flood", () => {
    const filtered = applySvgFilters(
      filterShape([
        { tag: "feOffset", attrs: { dx: "2", dy: "2" } },
        { tag: "feGaussianBlur", attrs: { stdDeviation: "2" } },
        { tag: "feFlood", attrs: { "flood-color": "#00ff00", "flood-opacity": "0.5" } },
      ]),
    );

    expect(withoutIds(filtered.shadow)[0].color).toEqual({ color: "#00ff00", opacity: 0.5 });
  });

  it("derives from feDropShadow with its spec defaults", () => {
    const explicit = applySvgFilters(
      filterShape([
        {
          tag: "feDropShadow",
          attrs: { dx: "12", dy: "8", stdDeviation: "4", "flood-color": "#000", "flood-opacity": "0.3" },
        },
      ]),
    );
    expect(withoutIds(explicit.shadow)[0]).toMatchObject({
      "offset-x": 12,
      "offset-y": 8,
      blur: 8,
      color: { color: "#000000", opacity: 0.3 },
    });
    expect(explicit.blur).toBeUndefined();

    const defaults = applySvgFilters(filterShape([{ tag: "feDropShadow", attrs: {} }]));
    expect(withoutIds(defaults.shadow)[0]).toMatchObject({
      "offset-x": 2,
      "offset-y": 2,
      blur: 4,
      color: { color: "#000000", opacity: 1 },
    });
  });

  it("keeps existing native filters", () => {
    const blur = { id: "existing", type: "layer-blur", value: 1 };
    const shadow: Shadow[] = [{ id: "shadow", style: "drop-shadow" }];
    const filtered = applySvgFilters({
      ...filterShape([{ tag: "feOffset", attrs: { dx: "10" } }]),
      blur,
      shadow,
    });

    expect(filtered.blur).toBe(blur);
    expect(filtered.shadow).toBe(shadow);
  });

  it("returns the shape untouched when no filter definition resolves", () => {
    const source = shape({ "svg-attrs": { fill: "#fff" } });
    expect(applySvgFilters(source)).toBe(source);
  });
});

describe("applySvgDerived", () => {
  it("always sets fills, blur and shadow without touching the input", () => {
    const source = shape();
    const derived = applySvgDerived(source);

    expect(derived).not.toBe(source);
    expect(derived.fills).toEqual([]);
    expect(derived.blur).toBeNull();
    expect(derived.shadow).toBeNull();
    expect(source.fills).toBeUndefined();
  });

  it("combines the derived fills and filters", () => {
    const source = shape({
      "svg-attrs": { fill: "#ff0000", filter: "url(#f)" },
      "svg-defs": {
        f: {
          tag: "filter",
          content: [{ tag: "feGaussianBlur", attrs: { stdDeviation: "2" } }],
        },
      },
    });

    const derived = applySvgDerived(source);
    expect(derived.fills).toEqual([{ "fill-color": "#ff0000" }]);
    expect(derived.blur).toMatchObject({ type: "layer-blur", value: 2 });
    expect(derived["svg-attrs"]).toBe(source["svg-attrs"]);
  });

  it("maps user-space coordinates through svg-transform and the viewBox", () => {
    const transformed = shape({
      selrect: { x: 0, y: 0, width: 100, height: 100 },
      "svg-viewbox": { x: 0, y: 0, width: 200, height: 200 },
      "svg-transform": "translate(20, 0)",
      "svg-attrs": { fill: "url(#g)" },
      "svg-defs": {
        g: {
          tag: "radialGradient",
          attrs: { gradientUnits: "userSpaceOnUse", cx: "100", cy: "100", r: "50" },
          content: [{ tag: "stop", attrs: { offset: "0", "stop-color": "#000" } }],
        },
      },
    });

    expect(svgFillToFills(transformed)?.[0]["fill-color-gradient"]).toMatchObject({
      "start-x": 0.6,
      "start-y": 0.5,
      "end-x": 0.6,
      "end-y": 0.75,
    });
  });
});