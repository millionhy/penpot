import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  markContextInitialized,
  markContextLost,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  POSITION_DATA_U32_SIZE,
  calculatePositionData,
  defaultTextAttrs,
  readPositionEntries,
  translateDirection,
} from "./position-data";
import type { TextContent } from "./text";
import { ZERO_UUID } from "./uuid";

const A = "aaaaaaaa-0000-0000-0000-000000000001";

interface Recorded {
  name: string;
  args: unknown[];
}

interface ModuleState {
  module: RenderWasmModule;
  heap: Uint8Array;
  view32: Uint32Array;
  viewF32: Float32Array;
}

// The panel lands at byte 8: the count in the first slot, the entries after
// it. `_calculate_position_data` answers the byte offset, as the wasm export
// does.
const PANEL_BYTE_OFFSET = 8;
const PANEL_SLOT = PANEL_BYTE_OFFSET / 4;

function makeModule(recorded: Recorded[]): ModuleState {
  const heap = new Uint8Array(4096);
  const view32 = new Uint32Array(heap.buffer);
  const viewF32 = new Float32Array(heap.buffer);
  const record = (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  const module: RenderWasmModule = {
    HEAPU8: heap,
    HEAPU32: view32,
    HEAP32: new Int32Array(heap.buffer),
    HEAPF32: viewF32,
    UTF8ToString: () => "",
    _use_shape: record("_use_shape"),
    _calculate_position_data: () => {
      recorded.push({ name: "_calculate_position_data", args: [] });
      return PANEL_BYTE_OFFSET;
    },
    _free_bytes: record("_free_bytes"),
  };
  return { module, heap, view32, viewF32 };
}

function writeEntry(
  state: ModuleState,
  index: number,
  entry: {
    paragraph: number;
    span: number;
    start: number;
    end: number;
    x: number;
    y: number;
    width: number;
    height: number;
    direction: number;
  },
): void {
  const at = PANEL_SLOT + 1 + index * POSITION_DATA_U32_SIZE;
  state.view32[at] = entry.paragraph;
  state.view32[at + 1] = entry.span;
  state.view32[at + 2] = entry.start;
  state.view32[at + 3] = entry.end;
  state.viewF32[at + 4] = entry.x;
  state.viewF32[at + 5] = entry.y;
  state.viewF32[at + 6] = entry.width;
  state.viewF32[at + 7] = entry.height;
  state.view32[at + 8] = entry.direction;
}

function content(spans: readonly Record<string, unknown>[]): TextContent {
  return {
    "vertical-align": "top",
    children: [{ children: [{ children: spans }] }],
  };
}

let recorded: Recorded[];
let state: ModuleState;

beforeEach(() => {
  resetModule();
  recorded = [];
  state = makeModule(recorded);
  setModule(state.module);
  markContextInitialized();
});

afterEach(() => {
  resetModule();
});

describe("translateDirection", () => {
  it("maps the renderer code to the model keyword", () => {
    expect(translateDirection(0)).toBe("rtl");
    expect(translateDirection(1)).toBe("ltr");
    expect(translateDirection(undefined)).toBe("ltr");
  });
});

describe("readPositionEntries", () => {
  it("reads the 36-byte records in slot units", () => {
    state.view32[PANEL_SLOT] = 2;
    writeEntry(state, 0, {
      paragraph: 1,
      span: 2,
      start: 3,
      end: 7,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      direction: 0,
    });
    writeEntry(state, 1, {
      paragraph: 4,
      span: 5,
      start: 6,
      end: 9,
      x: 1.5,
      y: 2.5,
      width: 3.5,
      height: 4.5,
      direction: 1,
    });

    const entries = readPositionEntries(state.view32, state.viewF32, PANEL_SLOT + 1, 2);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      paragraph: 1,
      span: 2,
      startPos: 3,
      endPos: 7,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      direction: 0,
    });
    expect(entries[1].x).toBeCloseTo(1.5);
    expect(entries[1].direction).toBe(1);
  });
});

describe("defaultTextAttrs", () => {
  it("matches the editor defaults", () => {
    const attrs = defaultTextAttrs();
    expect(attrs["font-id"]).toBe("sourcesanspro");
    expect(attrs["font-size"]).toBe("14");
    expect(attrs["text-direction"]).toBe("ltr");
    expect(attrs.fills).toEqual([{ "fill-color": "#000000", "fill-opacity": 1 }]);
  });
});

describe("calculatePositionData", () => {
  it("is a no-op without a ready context", () => {
    markContextLost(true);

    expect(calculatePositionData(state.module, { id: A })).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("selects the shape, reads the panel and frees it", () => {
    state.view32[PANEL_SLOT] = 1;
    writeEntry(state, 0, {
      paragraph: 0,
      span: 0,
      start: 0,
      end: 5,
      x: 12,
      y: 30,
      width: 80,
      height: 18,
      direction: 0,
    });

    const result = calculatePositionData(state.module, {
      id: A,
      content: content([
        {
          text: "hello world",
          "font-id": "sourcesanspro",
          "font-family": "Source Sans Pro",
          "font-size": 18,
          "font-weight": 700,
          "letter-spacing": 2,
        },
      ]),
    });

    expect(recorded.map((entry) => entry.name)).toEqual([
      "_use_shape",
      "_calculate_position_data",
      "_free_bytes",
    ]);
    expect(recorded[0].args).toEqual([0xaaaaaaaa, 0, 0, 1]);
    expect(result).toHaveLength(1);
    expect(result?.[0]).toMatchObject({
      text: "hello",
      x: 12,
      y: 48,
      width: 80,
      height: 18,
      direction: "rtl",
      "font-id": "sourcesanspro",
      "font-family": "Source Sans Pro",
      "font-size": "18px",
      "font-weight": 700,
      "letter-spacing": "2px",
    });
    // The renderer said nothing about these, so the defaults survive.
    expect(result?.[0]?.["text-transform"]).toBe("none");
    expect(result?.[0]?.["font-style"]).toBe("normal");
  });

  it("skips a run whose span the model no longer holds", () => {
    state.view32[PANEL_SLOT] = 1;
    writeEntry(state, 0, {
      paragraph: 0,
      span: 3,
      start: 0,
      end: 2,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      direction: 1,
    });

    expect(
      calculatePositionData(state.module, { id: A, content: content([{ text: "ab" }]) }),
    ).toEqual([]);
    expect(recorded.map((entry) => entry.name)).toContain("_free_bytes");
  });

  it("reads a right-to-left run whose start is past its end", () => {
    state.view32[PANEL_SLOT] = 1;
    writeEntry(state, 0, {
      paragraph: 0,
      span: 0,
      start: 5,
      end: 0,
      x: 0,
      y: 0,
      width: 10,
      height: 10,
      direction: 0,
    });

    const result = calculatePositionData(state.module, {
      id: A,
      content: content([{ text: "hello" }]),
    });
    expect(result?.[0]?.text).toBe("hello");
  });

  it("keeps the compiled px string when the span has no size", () => {
    state.view32[PANEL_SLOT] = 1;
    writeEntry(state, 0, {
      paragraph: 0,
      span: 0,
      start: 0,
      end: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      direction: 1,
    });

    const result = calculatePositionData(state.module, {
      id: A,
      content: content([{ text: "x" }]),
    });
    expect(result?.[0]?.["font-size"]).toBe("px");
    expect(result?.[0]?.["letter-spacing"]).toBe("px");
  });

  it("answers nothing when the content is empty", () => {
    state.view32[PANEL_SLOT] = 1;
    writeEntry(state, 0, {
      paragraph: 0,
      span: 0,
      start: 0,
      end: 1,
      x: 0,
      y: 0,
      width: 1,
      height: 1,
      direction: 1,
    });

    expect(calculatePositionData(state.module, { id: ZERO_UUID })).toEqual([]);
  });
});