import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  setRulersColors,
  setRulersFrameVisible,
  setRulersOffsets,
  setRulersSelection,
  setRulersVisible,
  syncRulers,
} from "./rulers";
import {
  markContextInitialized,
  markContextLost,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";

interface Recorded {
  name: string;
  args: unknown[];
}

function makeModule(recorded: Recorded[]): RenderWasmModule {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  return {
    HEAPU8: new Uint8Array(8),
    HEAPU32: new Uint32Array(2),
    HEAP32: new Int32Array(2),
    HEAPF32: new Float32Array(2),
    UTF8ToString: () => "",
    _set_rulers_visible: record("_set_rulers_visible"),
    _set_rulers_frame_visible: record("_set_rulers_frame_visible"),
    _set_rulers_offsets: record("_set_rulers_offsets"),
    _set_rulers_selection: record("_set_rulers_selection"),
    _set_rulers_colors: record("_set_rulers_colors"),
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

describe("visibility setter", () => {
  it("sends 1 and 0, never booleans", () => {
    expect(setRulersVisible(module, true)).toBe(true);
    expect(setRulersVisible(module, false)).toBe(true);
    expect(setRulersFrameVisible(module, true)).toBe(true);
    expect(setRulersFrameVisible(module, false)).toBe(true);

    expect(recorded).toEqual([
      { name: "_set_rulers_visible", args: [1] },
      { name: "_set_rulers_visible", args: [0] },
      { name: "_set_rulers_frame_visible", args: [1] },
      { name: "_set_rulers_frame_visible", args: [0] },
    ]);
  });

  it("is skipped while the context is lost", () => {
    markContextLost();
    expect(setRulersVisible(module, true)).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("offsets", () => {
  it("replaces a missing offset with 0", () => {
    setRulersOffsets(module, 12, null);
    setRulersOffsets(module, undefined, -4);

    expect(recorded).toEqual([
      { name: "_set_rulers_offsets", args: [12, 0] },
      { name: "_set_rulers_offsets", args: [0, -4] },
    ]);
  });
});

describe("selection", () => {
  it("sends the enabled block with the rect", () => {
    setRulersSelection(module, { x: 1, y: 2, width: 30, height: 40 });
    expect(recorded).toEqual([
      { name: "_set_rulers_selection", args: [1, 1, 2, 30, 40] },
    ]);
  });

  it("sends the disabled block when there is no rect", () => {
    setRulersSelection(module, null);
    expect(recorded).toEqual([
      { name: "_set_rulers_selection", args: [0, 0, 0, 0, 0] },
    ]);
  });
});

describe("colors", () => {
  it("pushes the four palette words as ARGB", () => {
    setRulersColors(module, {
      bg: "#ffffff",
      border: "#eef0f2",
      label: "#495e74",
      accent: "#8c33eb",
    });

    expect(recorded).toEqual([
      {
        name: "_set_rulers_colors",
        args: [0xffffffff, 0xffeef0f2, 0xff495e74, 0xff8c33eb],
      },
    ]);
  });
});

describe("syncRulers", () => {
  const theme = { bg: "#000", border: "#111", label: "#222", accent: "#333" };

  it("pushes colors, visibility, offsets and selection in order", () => {
    syncRulers(
      module,
      {
        showRulers: true,
        frameVisible: true,
        offsetX: 10,
        offsetY: null,
        selection: { x: 0, y: 0, width: 5, height: 5 },
      },
      theme,
    );

    expect(recorded.map((entry) => entry.name)).toEqual([
      "_set_rulers_colors",
      "_set_rulers_frame_visible",
      "_set_rulers_visible",
      "_set_rulers_offsets",
      "_set_rulers_selection",
    ]);
  });

  it("skips the offsets and the selection when the rulers are hidden", () => {
    syncRulers(
      module,
      {
        showRulers: false,
        frameVisible: true,
        offsetX: 10,
        offsetY: 10,
        selection: null,
      },
      theme,
    );

    expect(recorded.map((entry) => entry.name)).toEqual([
      "_set_rulers_colors",
      "_set_rulers_frame_visible",
      "_set_rulers_visible",
    ]);
  });

  it("skips the color push when the palette is already current", () => {
    syncRulers(
      module,
      {
        showRulers: true,
        frameVisible: false,
        offsetX: null,
        offsetY: null,
        selection: null,
        pushColors: false,
      },
      theme,
    );

    expect(recorded.map((entry) => entry.name)).toEqual([
      "_set_rulers_frame_visible",
      "_set_rulers_visible",
      "_set_rulers_offsets",
      "_set_rulers_selection",
    ]);
  });
});