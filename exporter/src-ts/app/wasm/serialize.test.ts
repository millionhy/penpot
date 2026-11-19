import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AppError } from "../errors.js";
import { setSerializers } from "./enums.js";
import {
  needsShapeTail,
  serializeScene,
  serializeShape,
  setShape,
} from "./serialize.js";
import { SECTION_BLUR_LAYER, type Shape } from "./upload.js";
import { fakeWasm, record, viewOf, type FakeWasm } from "../../test/fake-wasm.js";
import { testSerializers } from "../../test/enums.js";

const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const other = "11111111-2222-3333-4444-555555555555";

beforeEach(() => {
  setSerializers(testSerializers);
});

afterEach(() => {
  setSerializers(undefined);
});

function shape(overrides: Partial<Shape> = {}): Shape {
  return { id, type: "rect", ...overrides };
}

function harness(): FakeWasm {
  const target = fakeWasm();
  for (const name of [
    "_init_shapes_pool",
    "_set_shapes_batch",
    "_clear_shape_fills",
    "_set_shape_fills",
    "_clear_shape_strokes",
    "_add_shape_center_stroke",
    "_set_shape_svg_attrs",
    "_start_shape_path_buffer",
    "_set_shape_path_chunk_buffer",
    "_set_shape_path_buffer",
    "_clear_shape_text",
    "_set_shape_vertical_align",
    "_set_shape_text_content",
    "_update_shape_text_layout",
  ]) {
    record(target, name);
  }
  return target;
}

function names(target: FakeWasm): string[] {
  return target.calls.map((call) => call.name);
}

// The mask of the single record inside the batch allocation at `base`.
function uploadedMask(target: FakeWasm, index = 0): number {
  const view = viewOf(target);
  const base = target.allocs[index];
  const lengthAt = base + 4;
  return view.getUint32(lengthAt + 4 + 104, true);
}

describe("serialize", () => {
  it("detects when a shape needs the svg-attrs/path tail", () => {
    expect(needsShapeTail(shape())).toBe(false);
    expect(needsShapeTail(shape({ "svg-attrs": {} }))).toBe(true);
    expect(needsShapeTail(shape({ type: "path", content: new Uint8Array(4) }))).toBe(true);
    expect(needsShapeTail(shape({ type: "path" }))).toBe(false);
    expect(needsShapeTail(shape({ type: "bool", content: new Uint8Array(4) }))).toBe(true);
    expect(needsShapeTail(shape({ type: "text", content: {} }))).toBe(false);
  });

  it("uploads the structural record and returns the derived shape", () => {
    const target = harness();
    const original = shape();
    const prepared = serializeShape(original, {}, target);

    expect(prepared).not.toBe(original);
    expect(prepared).toMatchObject({ id, type: "rect", fills: [], blur: null, shadow: null });
    expect(names(target)).toEqual(["_set_shapes_batch"]);
    expect(target.frees).toBe(0);
  });

  it("serializes the derived shape", () => {
    const target = harness();
    const derived = shape({ blur: { value: 4 } });

    const prepared = serializeShape(shape(), { applySvgDerived: () => derived }, target);

    expect(prepared).toBe(derived);
    expect(uploadedMask(target) & SECTION_BLUR_LAYER).toBe(SECTION_BLUR_LAYER);
  });

  it("applies the svg-attrs and path tails after the upload", () => {
    const target = harness();
    const written = shape({
      type: "path",
      "svg-attrs": { style: { fill: "none" } },
      content: new Uint8Array([1, 2, 3, 4]),
    });

    serializeShape(written, {}, target);

    expect(names(target)).toEqual([
      "_set_shapes_batch",
      "_set_shape_svg_attrs",
      "_start_shape_path_buffer",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
    expect(target.calls[1].args).toEqual([0, 0, 0, true]);
  });

  it("refuses path content that is not the byte blob", () => {
    const target = harness();
    let cause: unknown;
    try {
      serializeShape(shape({ type: "path", content: { not: "bytes" } }), {}, target);
    } catch (error) {
      cause = error;
    }

    expect(cause).toBeInstanceOf(AppError);
    expect((cause as AppError).data).toMatchObject({
      type: "internal",
      code: "path-content-not-bytes",
    });
  });

  it("writes fills, strokes and text in the editor's order", () => {
    const target = harness();
    const written = shape({
      type: "text",
      fills: [{ "fill-color": "#112233" }],
      strokes: [{ "stroke-color": "#ff0000" }],
      content: {
        "vertical-align": "center",
        children: [{ children: [{ children: [{ text: "hi" }] }] }],
      },
    });

    setShape(written, {}, target);

    expect(names(target)).toEqual([
      "_set_shapes_batch",
      "_set_shape_fills",
      "_clear_shape_strokes",
      "_add_shape_center_stroke",
      "_clear_shape_text",
      "_set_shape_vertical_align",
      "_set_shape_text_content",
      "_update_shape_text_layout",
    ]);
    expect(target.calls[5].args).toEqual([1]);
  });

  it("never writes strokes for a group", () => {
    const target = harness();
    setShape(
      shape({ type: "group", strokes: [{ "stroke-color": "#ff0000" }] }),
      {},
      target,
    );

    expect(names(target)).toEqual(["_set_shapes_batch", "_clear_shape_fills"]);
  });

  it("resets the pool once and uploads every shape", () => {
    const target = harness();
    serializeScene(
      { [id]: shape(), [other]: shape({ id: other, type: "frame" }) },
      {},
      target,
    );

    expect(target.calls[0].name).toBe("_init_shapes_pool");
    expect(target.calls[0].args).toEqual([2]);
    expect(names(target).filter((name) => name === "_set_shapes_batch")).toHaveLength(2);
  });
});
