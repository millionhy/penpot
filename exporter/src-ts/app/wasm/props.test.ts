import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSerializers } from "./enums.js";
import {
  setShapeSvgAttrs,
  writeShapeFills,
  writeShapeStrokes,
  type Stroke,
} from "./props.js";
import { fakeWasm, record, viewOf, type FakeWasm } from "../../test/fake-wasm.js";
import { testSerializers } from "../../test/enums.js";

const imageId = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  setSerializers(testSerializers);
});

afterEach(() => {
  setSerializers(undefined);
});

function harness(): FakeWasm {
  const target = fakeWasm();
  record(target, "_clear_shape_fills");
  record(target, "_set_shape_fills");
  record(target, "_clear_shape_strokes");
  record(target, "_add_shape_center_stroke");
  record(target, "_add_shape_inner_stroke");
  record(target, "_add_shape_outer_stroke");
  record(target, "_set_shape_stroke_sides");
  record(target, "_add_shape_stroke_fill");
  record(target, "_set_shape_svg_attrs");
  return target;
}

describe("props", () => {
  it("clears the fills when there is nothing to write", () => {
    const target = harness();
    expect(writeShapeFills([], target)).toBeNull();
    expect(writeShapeFills(null, target)).toBeNull();
    expect(target.calls.map((call) => call.name)).toEqual([
      "_clear_shape_fills",
      "_clear_shape_fills",
    ]);
    expect(target.allocs).toEqual([]);
  });

  it("writes the fill count and records, and caps the list at MAX_FILLS", () => {
    const target = harness();
    const fills = Array.from({ length: 10 }, () => ({
      "fill-color": "#112233",
      "fill-opacity": 0.5,
    }));

    const coerced = writeShapeFills(fills, target);

    expect(coerced).toHaveLength(8);
    expect(target.allocs).toEqual([256]);
    expect(target.calls.map((call) => call.name)).toEqual(["_set_shape_fills"]);

    const view = viewOf(target);
    expect(view.getUint8(256)).toBe(8);
    expect(view.getUint8(260)).toBe(0x00);
    expect(view.getUint32(264, true)).toBe(0x7f112233);
  });

  it("only emits clear when every stroke is hidden", () => {
    const target = harness();
    expect(writeShapeStrokes([], target)).toEqual([]);
    expect(writeShapeStrokes([{ hidden: true }], target)).toEqual([]);
    expect(target.calls.map((call) => call.name)).toEqual([
      "_clear_shape_strokes",
      "_clear_shape_strokes",
    ]);
    expect(target.allocs).toEqual([]);
  });

  it("adds one stroke and one fill record per painted stroke", () => {
    const target = harness();
    const stroke: Stroke = {
      "stroke-width": 2,
      "stroke-style": "dashed",
      "stroke-alignment": "inner",
      "stroke-color": "#ff0000",
      "stroke-cap-start": "round",
    };

    expect(writeShapeStrokes([stroke], target)).toEqual([]);
    expect(target.calls.map((call) => call.name)).toEqual([
      "_clear_shape_strokes",
      "_add_shape_inner_stroke",
      "_add_shape_stroke_fill",
    ]);
    expect(target.calls[1].args).toEqual([2, 1, 1, 0, -1, -1]);

    // The fill record is the whole buffer: no stroke header goes to the Rust
    // reader, which expects exactly one RawFillData.
    expect(target.allocs).toEqual([256]);
    const view = viewOf(target);
    expect(view.getUint8(256)).toBe(0x00);
    expect(view.getUint32(260, true)).toBe(0xffff0000);
  });

  it("adds the per-side widths only when they differ", () => {
    const target = harness();
    writeShapeStrokes([{ "stroke-width": 2, "stroke-width-top": 3 }], target);

    expect(target.calls.map((call) => call.name)).toEqual([
      "_clear_shape_strokes",
      "_add_shape_center_stroke",
      "_set_shape_stroke_sides",
    ]);
    expect(target.calls[2].args).toEqual([3, 2, 2, 2]);
    // A stroke with no paint allocates nothing.
    expect(target.allocs).toEqual([]);
  });

  it("prefers the gradient over the color and returns image ids", () => {
    const target = harness();
    const ids = writeShapeStrokes(
      [
        {
          "stroke-color": "#ff0000",
          "stroke-color-gradient": { type: "linear", stops: [] },
        },
        { "stroke-image": { id: imageId } },
      ],
      target,
    );

    expect(ids).toEqual([imageId]);
    expect(target.allocs).toEqual([256, 416]);
    const view = viewOf(target);
    expect(view.getUint8(256)).toBe(0x01);
    expect(view.getUint8(416)).toBe(0x03);
  });

  it("translates the SVG attributes with the style block taking precedence", () => {
    const target = harness();
    setShapeSvgAttrs(
      {
        fill: "red",
        style: { fill: "none", fillRule: "evenodd", strokeLinecap: "round" },
      },
      target,
    );

    expect(target.calls.map((call) => call.name)).toEqual(["_set_shape_svg_attrs"]);
    expect(target.calls[0].args).toEqual([1, 1, 0, true]);
  });
});
