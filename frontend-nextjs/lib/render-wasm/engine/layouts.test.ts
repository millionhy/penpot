import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markContextInitialized,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  GRID_CELL_U8_SIZE,
  GRID_TRACK_U8_SIZE,
  clearLayout,
  isFlexLayout,
  isGridLayout,
  setFlexLayoutData,
  setGridCells,
  setGridColumns,
  setGridLayout,
  setGridLayoutData,
  setGridRows,
  setLayoutData,
  setShapeLayout,
} from "./layouts";
import type { Shape } from "./upload";
import { uuidToU32 } from "./uuid";

interface Recorded {
  name: string;
  args: unknown[];
}

const ID = "12345678-9abc-def0-1122-334455667788";
const CELL_SHAPE = "aaaaaaaa-0000-0000-0000-000000000001";

function makeModule(recorded: Recorded[], heapSize = 1 << 16): RenderWasmModule {
  const heap = new Uint8Array(heapSize);
  let next = 8;

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
    ...Object.fromEntries(
      [
        "_clear_shape_layout",
        "_set_flex_layout_data",
        "_set_grid_layout_data",
        "_set_grid_rows",
        "_set_grid_columns",
        "_set_grid_cells",
        "_set_layout_data",
      ].map((name) => [
        name,
        (...args: unknown[]) => {
          recorded.push({ name, args });
          return 0;
        },
      ]),
    ),
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

function argsOf(name: string): unknown[] {
  const entry = recorded.find((candidate) => candidate.name === name);
  if (entry === undefined) throw new Error(`no call to ${name}`);
  return entry.args;
}

function shape(overrides: Partial<Shape> = {}): Shape {
  return { id: ID, type: "frame", ...overrides };
}

describe("layout kinds", () => {
  it("only frames with the matching layout answer", () => {
    expect(isFlexLayout(shape({ layout: "flex" }))).toBe(true);
    expect(isFlexLayout(shape({ layout: "grid" }))).toBe(false);
    expect(isFlexLayout(shape({ type: "rect", layout: "flex" }))).toBe(false);
    expect(isGridLayout(shape({ layout: "grid" }))).toBe(true);
    expect(isGridLayout(shape({ type: "rect", layout: "grid" }))).toBe(false);
    expect(isGridLayout(shape({}))).toBe(false);
  });
});

describe("setFlexLayoutData", () => {
  it("passes dir, gaps, alignments and padding in the ABI order", () => {
    setFlexLayoutData(
      module,
      shape({
        layout: "flex",
        "layout-flex-dir": "column",
        "layout-gap": { "row-gap": 5, "column-gap": 6 },
        "layout-align-items": "center",
        "layout-align-content": "space-between",
        "layout-justify-items": "end",
        "layout-justify-content": "space-evenly",
        "layout-wrap-type": "wrap",
        "layout-padding": { p1: 1, p2: 2, p3: 3, p4: 4 },
      }),
    );

    expect(argsOf("_set_flex_layout_data")).toEqual([2, 5, 6, 2, 3, 1, 5, 0, 1, 2, 3, 4]);
  });

  it("falls back to the row layout and zero gaps", () => {
    setFlexLayoutData(module, shape({ layout: "flex" }));
    expect(argsOf("_set_flex_layout_data")).toEqual([0, 0, 0, 0, 6, 0, 6, 1, 0, 0, 0, 0]);
  });
});

describe("setGridLayoutData", () => {
  it("passes the direction and the shared alignment table", () => {
    setGridLayoutData(
      module,
      shape({
        layout: "grid",
        "layout-grid-dir": "column",
        "layout-gap": { "row-gap": 7, "column-gap": 8 },
        "layout-align-items": "stretch",
        "layout-align-content": "center",
        "layout-justify-items": "start",
        "layout-justify-content": "end",
        "layout-padding": { p1: 9, p2: 10, p3: 11, p4: 12 },
      }),
    );

    expect(argsOf("_set_grid_layout_data")).toEqual([1, 7, 8, 3, 2, 0, 1, 9, 10, 11, 12]);
  });
});

describe("grid tracks", () => {
  it("writes one eight-byte record per track", () => {
    setGridRows(module, [
      { type: "percent", value: 25 },
      { type: "fixed", value: 120 },
    ]);

    expect(argsOf("_alloc_bytes")).toEqual([2 * GRID_TRACK_U8_SIZE]);
    const view = new DataView(module.HEAPU8.buffer);

    // The test allocator starts at 8.
    const offset = 8;
    expect(module.HEAPU8[offset]).toBe(0);
    expect(view.getFloat32(offset + 4, true)).toBe(25);
    expect(module.HEAPU8[offset + GRID_TRACK_U8_SIZE]).toBe(3);
    expect(view.getFloat32(offset + GRID_TRACK_U8_SIZE + 4, true)).toBe(120);
    expect(names()).toEqual(["_alloc_bytes", "_set_grid_rows"]);
  });

  it("calls the setter without allocating for an empty list", () => {
    setGridColumns(module, []);
    expect(names()).toEqual(["_set_grid_columns"]);
  });
});

describe("grid cells", () => {
  it("writes the spans, the alignment bytes and the shape uuid", () => {
    setGridCells(module, {
      "cell-1": {
        row: 1,
        "row-span": 2,
        column: 3,
        "column-span": 4,
        "align-self": "center",
        "justify-self": "stretch",
        shapes: [CELL_SHAPE],
      },
    });

    expect(argsOf("_alloc_bytes")).toEqual([GRID_CELL_U8_SIZE]);
    const view = new DataView(module.HEAPU8.buffer);
    const at = 8;
    expect(view.getInt32(at, true)).toBe(1);
    expect(view.getInt32(at + 4, true)).toBe(2);
    expect(view.getInt32(at + 8, true)).toBe(3);
    expect(view.getInt32(at + 12, true)).toBe(4);
    expect(module.HEAPU8[at + 16]).toBe(4);
    expect(module.HEAPU8[at + 17]).toBe(5);
    expect(view.getUint32(at + 20, true)).toBe(uuidToU32(CELL_SHAPE)[0]);
    expect(view.getUint32(at + 32, true)).toBe(uuidToU32(CELL_SHAPE)[3]);
    expect(names()).toEqual(["_alloc_bytes", "_set_grid_cells"]);
  });

  it("answers the zero uuid for an empty cell", () => {
    setGridCells(module, { "cell-1": {} });
    const view = new DataView(module.HEAPU8.buffer);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(8 + 20 + index * 4, true)).toBe(0);
    }
  });
});

describe("setGridLayout", () => {
  it("writes the container data and the three lists", () => {
    setGridLayout(
      module,
      shape({
        layout: "grid",
        "layout-grid-rows": [{ type: "flex", value: 1 }],
        "layout-grid-columns": [{ type: "auto", value: 0 }],
        "layout-grid-cells": { c: { row: 0, column: 0 } },
      }),
    );

    expect(names()).toEqual([
      "_set_grid_layout_data",
      "_alloc_bytes",
      "_set_grid_rows",
      "_alloc_bytes",
      "_set_grid_columns",
      "_alloc_bytes",
      "_set_grid_cells",
    ]);
  });
});

describe("setShapeLayout", () => {
  it("clears first, then writes the matching container", () => {
    setShapeLayout(module, shape({ layout: "grid" }));
    expect(names()[0]).toBe("_clear_shape_layout");
    expect(names()).toContain("_set_grid_layout_data");
    expect(names()).not.toContain("_set_flex_layout_data");
  });

  it("only clears a shape without layout", () => {
    setShapeLayout(module, shape({}));
    expect(names()).toEqual(["_clear_shape_layout"]);
  });
});

describe("setLayoutData", () => {
  it("passes margins, sizing, bounds, alignment and z-index", () => {
    setLayoutData(
      module,
      shape({
        "layout-item-margin": { m1: 1, m2: 2, m3: 3, m4: 4 },
        "layout-item-h-sizing": "fill",
        "layout-item-v-sizing": "auto",
        "layout-item-max-h": 200,
        "layout-item-min-h": 10,
        "layout-item-min-w": 20,
        "layout-item-align-self": "center",
        "layout-item-absolute": true,
        "layout-item-z-index": 3,
      }),
    );

    expect(argsOf("_set_layout_data")).toEqual([
      1,
      2,
      3,
      4,
      0,
      2,
      true,
      200,
      true,
      10,
      false,
      0,
      true,
      20,
      4,
      true,
      3,
    ]);
  });

  it("answers the zero margins for a plain shape", () => {
    setLayoutData(module, shape({}));
    expect(argsOf("_set_layout_data")).toEqual([
      0, 0, 0, 0, 1, 1, false, 0, false, 0, false, 0, false, 0, 0, false, 0,
    ]);
  });
});

describe("clearLayout", () => {
  it("calls the wasm setter", () => {
    clearLayout(module);
    expect(names()).toEqual(["_clear_shape_layout"]);
  });
});