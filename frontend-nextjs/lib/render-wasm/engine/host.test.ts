import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markContextInitialized,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import { writeHostAttrs } from "./host";
import type { Shape } from "./upload";

interface Recorded {
  name: string;
  args: unknown[];
}

const ID = "12345678-9abc-def0-1122-334455667788";
const IMAGE = "aaaaaaaa-0000-0000-0000-000000000001";

const SETTERS = [
  "_use_shape",
  "_clear_shape_text",
  "_set_shape_vertical_align",
  "_set_shape_text_content",
  "_update_shape_text_layout",
  "_clear_shape_layout",
  "_set_flex_layout_data",
  "_set_grid_layout_data",
  "_set_grid_rows",
  "_set_grid_columns",
  "_set_grid_cells",
  "_set_layout_data",
  "_clear_shape_fills",
  "_set_shape_fills",
  "_clear_shape_strokes",
  "_add_shape_center_stroke",
  "_add_shape_inner_stroke",
  "_add_shape_outer_stroke",
  "_add_shape_stroke_fill",
  "_set_shape_stroke_sides",
  "_set_shape_svg_raw_content",
  "_store_image",
  "_store_image_url",
] as const;

function makeModule(recorded: Recorded[]): RenderWasmModule {
  const heap = new Uint8Array(1 << 16);
  let next = 8;
  const record = (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  const module: RenderWasmModule = {
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
    _is_image_cached: () => 0,
    stringToUTF8: (text: string, ptr: number) => {
      recorded.push({ name: "stringToUTF8", args: [text, ptr] });
      heap.set(new TextEncoder().encode(text), ptr);
    },
  };
  for (const name of SETTERS) module[name] = record(name);
  return module;
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
  vi.restoreAllMocks();
});

function names(): string[] {
  return recorded.map((entry) => entry.name);
}

function shape(overrides: Partial<Shape> = {}): Shape {
  return { id: ID, type: "rect", ...overrides };
}

describe("writeHostAttrs", () => {
  it("selects the shape, replays the layout and writes the paint", () => {
    const result = writeHostAttrs(module, shape({ fills: [{ "fill-color": "#ff0000" }] }));

    expect(names()).toEqual([
      "_use_shape",
      "_clear_shape_layout",
      "_set_layout_data",
      "_alloc_bytes",
      "_set_shape_fills",
      "_clear_shape_strokes",
    ]);
    expect(result.thumbnails).toEqual([]);
    expect(result.full).toEqual([]);
  });

  it("writes nothing for a batch shape with no host work", () => {
    writeHostAttrs(module, shape({}), { skipLayout: true, skipFillsStrokes: true });
    expect(recorded).toEqual([]);
  });

  it("writes only the grid half when the batch carried the flex data", () => {
    writeHostAttrs(module, shape({ type: "frame", layout: "grid" }), {
      skipLayout: true,
      skipFillsStrokes: true,
    });

    const called = names();
    expect(called).toContain("_use_shape");
    expect(called).toContain("_set_grid_layout_data");
    expect(called).toContain("_set_grid_rows");
    expect(called).not.toContain("_clear_shape_layout");
    expect(called).not.toContain("_set_layout_data");
  });

  it("writes the text content and asks the host for the fonts", () => {
    const prepareFonts = vi.fn(() => "pending-faces");
    const content = {
      "vertical-align": "center",
      children: [{ children: [{ children: [{ text: "hi" }] }] }],
    };

    const result = writeHostAttrs(module, shape({ type: "text", content }), {
      text: { prepareFonts },
    });

    expect(result.fonts).toBe("pending-faces");
    expect(prepareFonts).toHaveBeenCalledWith(content);
    const called = names();
    expect(called.indexOf("_use_shape")).toBeLessThan(called.indexOf("_clear_shape_text"));
    expect(called).toContain("_set_shape_text_content");
    expect(called).toContain("_update_shape_text_layout");
  });

  it("writes the svg-raw markup the host renders", () => {
    writeHostAttrs(module, shape({ type: "svg-raw", content: "<svg/>" }), {
      getStaticMarkup: () => "<svg><rect/></svg>",
    });

    const call = recorded.find((entry) => entry.name === "stringToUTF8");
    expect(call?.args[0]).toBe("<svg><rect/></svg>");
    expect(names()).toContain("_set_shape_svg_raw_content");
  });

  it("skips the markup when the host answers nothing", () => {
    writeHostAttrs(module, shape({ type: "svg-raw", content: "<svg/>" }));
    expect(names()).not.toContain("_set_shape_svg_raw_content");
    expect(names()).not.toContain("stringToUTF8");
  });

  it("collects the thumbnail and full image work", () => {
    const result = writeHostAttrs(
      module,
      shape({ fills: [{ "fill-image": { id: IMAGE } }] }),
      {
        images: {
          resolveUrl: () => "https://example.test/a.png",
          fetchBytes: async () => new Uint8Array([1, 2]),
        },
      },
    );

    expect(result.thumbnails).toHaveLength(1);
    expect(result.full).toHaveLength(1);
  });

  it("collects the text image work too", () => {
    const content = {
      children: [{ children: [{ children: [{ text: "x", fills: [{ "fill-image": { id: IMAGE } }] }] }] }],
    };
    const result = writeHostAttrs(module, shape({ type: "text", content }), {
      images: {
        resolveUrl: () => "https://example.test/a.png",
        fetchBytes: async () => new Uint8Array([1]),
      },
    });

    expect(result.thumbnails).toHaveLength(1);
    expect(result.full).toHaveLength(1);
  });
});