import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markContextInitialized,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  MAX_BUFFER_CHUNK_SIZE,
  setShapeBackgroundBlur,
  setShapeBlur,
  setShapePathContent,
  setShapeShadows,
  setShapeSvgAttrs,
  setShapeSvgRawContent,
  setMasked,
  writeShapeFills,
  writeShapeStrokes,
  writeStrokeData,
} from "./props";
import { FILL_U8_SIZE } from "./fills";

interface Recorded {
  name: string;
  args: unknown[];
}

const ID = "12345678-9abc-def0-1122-334455667788";

function makeModule(recorded: Recorded[], heapSize = 1 << 20): RenderWasmModule {
  const heap = new Uint8Array(heapSize);
  let next = 8;
  const record = (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  return {
    HEAPU8: heap,
    HEAPU32: new Uint32Array(heap.buffer),
    HEAP32: new Int32Array(heap.buffer),
    HEAPF32: new Float32Array(heap.buffer),
    UTF8ToString: () => "",
    _alloc_bytes: (size: number) => {
      recorded.push({ name: "_alloc_bytes", args: [size] });
      const at = next;
      next += (size + 7) & ~3;
      return at;
    },
    _free_bytes: record("_free_bytes"),
    _clear_shape_fills: record("_clear_shape_fills"),
    _set_shape_fills: record("_set_shape_fills"),
    _clear_shape_strokes: record("_clear_shape_strokes"),
    _add_shape_center_stroke: record("_add_shape_center_stroke"),
    _add_shape_inner_stroke: record("_add_shape_inner_stroke"),
    _add_shape_outer_stroke: record("_add_shape_outer_stroke"),
    _add_shape_stroke_fill: record("_add_shape_stroke_fill"),
    _set_shape_stroke_sides: record("_set_shape_stroke_sides"),
    _set_shape_blur: record("_set_shape_blur"),
    _clear_shape_blur: record("_clear_shape_blur"),
    _clear_shape_shadows: record("_clear_shape_shadows"),
    _add_shape_shadow: record("_add_shape_shadow"),
    _set_shape_masked_group: record("_set_shape_masked_group"),
    _set_shape_svg_attrs: record("_set_shape_svg_attrs"),
    _set_shape_svg_raw_content: record("_set_shape_svg_raw_content"),
    _start_shape_path_buffer: record("_start_shape_path_buffer"),
    _set_shape_path_chunk_buffer: record("_set_shape_path_chunk_buffer"),
    _set_shape_path_buffer: record("_set_shape_path_buffer"),
    stringToUTF8: (text: string, ptr: number, size: number) => {
      recorded.push({ name: "stringToUTF8", args: [text, ptr, size] });
      heap.set(new TextEncoder().encode(text), ptr);
    },
  };
}

let recorded: Recorded[];
let module: RenderWasmModule;

beforeEach(() => {
  resetModule();
  recorded = [];
  module = makeModule(recorded);
  setModule(module);
  markContextInitialized();
});

afterEach(() => {
  resetModule();
});

function names(): string[] {
  return recorded.map((entry) => entry.name);
}

describe("writeShapeFills", () => {
  it("clears the fills when there is nothing to write", () => {
    expect(writeShapeFills(module, [])).toBeNull();
    expect(names()).toEqual(["_clear_shape_fills"]);
  });

  it("allocates the block, writes it and commits", () => {
    const fills = writeShapeFills(module, [{ "fill-color": "#ff0000" }]);
    expect(fills).toHaveLength(1);
    expect(names()).toEqual(["_alloc_bytes", "_set_shape_fills"]);
    expect(recorded[0].args).toEqual([4 + FILL_U8_SIZE]);
    expect(module.HEAPU8[8]).toBe(1); // fill count
    expect(new DataView(module.HEAPU8.buffer).getUint8(12)).toBe(0); // solid
  });
});

describe("writeShapeStrokes", () => {
  it("clears, adds one stroke per visible entry and returns image ids", () => {
    const imageIds = writeShapeStrokes(module, [
      {
        "stroke-width": 2,
        "stroke-alignment": "inner",
        "stroke-color": "#000000",
      },
      { hidden: true, "stroke-color": "#ffffff" },
      { "stroke-alignment": "outer", "stroke-image": { id: ID } },
    ]);

    expect(imageIds).toEqual([ID]);
    expect(names()).toEqual([
      "_clear_shape_strokes",
      "_alloc_bytes",
      "_add_shape_inner_stroke",
      "_add_shape_stroke_fill",
      "_alloc_bytes",
      "_add_shape_outer_stroke",
      "_add_shape_stroke_fill",
    ]);
    expect(recorded[2].args).toEqual([2, 0, 0, 0, -1, -1]);
  });

  it("pushes per-side widths only when they differ", () => {
    writeShapeStrokes(module, [
      { "stroke-width": 2, "stroke-width-top": 4, "stroke-color": "#000000" },
    ]);
    expect(names()).toContain("_set_shape_stroke_sides");
    expect(recorded.find((e) => e.name === "_set_shape_stroke_sides")?.args).toEqual([
      4, 2, 2, 2,
    ]);
  });

  it("releases the pending record when a stroke has no paint", () => {
    writeShapeStrokes(module, [{ "stroke-width": 1 }]);
    expect(names()).toEqual([
      "_clear_shape_strokes",
      "_alloc_bytes",
      "_add_shape_center_stroke",
      "_free_bytes",
    ]);
  });
});

describe("writeStrokeData", () => {
  it("writes the 36-byte header plus the fill record", () => {
    const buffer = new ArrayBuffer(256);
    const view = new DataView(buffer);
    const end = writeStrokeData(view, 0, {
      "stroke-width": 3,
      "stroke-style": "dashed",
      "stroke-cap-start": "round",
      "stroke-color": "#0000ff",
    });
    expect(end).toBe(36 + FILL_U8_SIZE);
    expect(view.getFloat32(0, true)).toBe(3);
    expect(view.getUint8(4)).toBe(2); // dashed
    expect(view.getUint8(6)).toBe(6); // round cap
    expect(view.getFloat32(8, true)).toBe(-1); // dash sentinel
    expect(view.getUint8(36)).toBe(0); // solid fill
  });
});

describe("effects", () => {
  it("sets and clears each blur slot by type", () => {
    setShapeBlur(module, { hidden: true, value: 4 });
    setShapeBlur(module, null);
    setShapeBackgroundBlur(module, { value: 2 });
    expect(recorded.map((e) => e.args)).toEqual([
      [0, true, 4],
      [0],
      [1, false, 2],
    ]);
  });

  it("recreates the shadow list every time", () => {
    setShapeShadows(module, [
      {
        color: { color: "#000000", opacity: 0.5 },
        blur: 4,
        spread: 1,
        "offset-x": 2,
        "offset-y": 3,
        style: "inner-shadow",
        hidden: false,
      },
    ]);
    expect(names()).toEqual(["_clear_shape_shadows", "_add_shape_shadow"]);
    expect(recorded[1].args).toEqual([0x7f000000, 4, 1, 2, 3, 1, false]);
  });

  it("forwards the masked flag", () => {
    setMasked(module, true);
    expect(recorded[0]).toMatchObject({ name: "_set_shape_masked_group", args: [true] });
  });
});

describe("svg and path", () => {
  it("summarizes the svg style into four values", () => {
    setShapeSvgAttrs(module, {
      style: { fillRule: "evenodd", strokeLinecap: "round", strokeLinejoin: "bevel", fill: "none" },
    });
    expect(recorded[0].args).toEqual([1, 1, 2, true]);
  });

  it("copies the static markup nul-terminated", () => {
    setShapeSvgRawContent(module, "<svg/>");
    expect(recorded[0]).toMatchObject({ name: "_alloc_bytes", args: [7] });
    expect(recorded[1].name).toBe("stringToUTF8");
    expect(recorded[2].name).toBe("_set_shape_svg_raw_content");
  });

  it("pads the path bytes to four and uses one chunk when small", () => {
    setShapePathContent(module, new Uint8Array([1, 2, 3, 4, 5]));
    expect(recorded[0].name).toBe("_start_shape_path_buffer");
    expect(recorded[1]).toMatchObject({ name: "_alloc_bytes", args: [8] });
    expect(names()).toEqual([
      "_start_shape_path_buffer",
      "_alloc_bytes",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
  });

  it("splits a large path into 256 KiB chunks", () => {
    const bytes = new Uint8Array(MAX_BUFFER_CHUNK_SIZE + 4);
    setShapePathContent(module, bytes);
    const allocs = recorded.filter((e) => e.name === "_alloc_bytes");
    expect(allocs.map((e) => e.args[0])).toEqual([MAX_BUFFER_CHUNK_SIZE, 4]);
  });
});