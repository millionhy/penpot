import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  applyRouteParams,
  debugFlags,
  initializeViewport,
  numericValue,
  objectCount,
  readNumericParam,
  renderSync,
  renderSyncShape,
  setCanvasBackground,
  setView,
  setViewerViewport,
} from "./viewport";
import {
  markContextInitialized,
  markContextLost,
  markReloading,
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
    _set_view: record("_set_view"),
    _set_view_end: record("_set_view_end"),
    _render_sync: record("_render_sync"),
    _render_sync_shape: record("_render_sync_shape"),
    _resize_viewbox: record("_resize_viewbox"),
    _set_render_options: record("_set_render_options"),
    _set_canvas_background: record("_set_canvas_background"),
    _init_shapes_pool: record("_init_shapes_pool"),
    _set_antialias_threshold: record("_set_antialias_threshold"),
    _set_viewport_interest_area_threshold: record("_set_viewport_interest_area_threshold"),
    _set_max_blocking_time_ms: record("_set_max_blocking_time_ms"),
    _set_node_batch_threshold: record("_set_node_batch_threshold"),
    _set_blur_downscale_threshold: record("_set_blur_downscale_threshold"),
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

describe("debugFlags", () => {
  it("maps the three debug switches to their bits", () => {
    expect(debugFlags()).toBe(0);
    expect(debugFlags({ viewbox: true })).toBe(0b0001);
    expect(debugFlags({ textEditorWasm: true })).toBe(0b0100);
    expect(debugFlags({ renderInfo: true })).toBe(0b1000);
    expect(debugFlags({ viewbox: true, textEditorWasm: true, renderInfo: true })).toBe(
      0b1101,
    );
  });
});

describe("numericValue", () => {
  it("accepts positive finite numbers and numeric strings", () => {
    expect(numericValue(2)).toBe(2);
    expect(numericValue("2.5")).toBe(2.5);
    expect(numericValue(" 3 ")).toBe(3);
  });

  it("rejects everything the compiled helper rejects", () => {
    expect(numericValue(0)).toBeUndefined();
    expect(numericValue(-1)).toBeUndefined();
    expect(numericValue("0")).toBeUndefined();
    expect(numericValue("abc")).toBeUndefined();
    expect(numericValue(Number.NaN)).toBeUndefined();
    expect(numericValue(Number.POSITIVE_INFINITY)).toBeUndefined();
    expect(numericValue(true)).toBeUndefined();
    expect(numericValue(undefined)).toBeUndefined();
  });
});

describe("readNumericParam", () => {
  it("reads plain route maps and URLSearchParams", () => {
    expect(readNumericParam({ dpr: "2" }, "dpr")).toBe(2);
    expect(readNumericParam(new URLSearchParams("dpr=3&x=0"), "dpr")).toBe(3);
    expect(readNumericParam(new URLSearchParams("dpr=3"), "x")).toBeUndefined();
  });
});

describe("applyRouteParams", () => {
  it("calls the matching setter only for the params the route carries", () => {
    const applied = applyRouteParams(module, {
      antialias_threshold: "0.5",
      node_batch_threshold: 12,
      max_blocking_time_ms: 0,
      unknown_param: 5,
    });

    expect(applied).toEqual(["antialias_threshold", "node_batch_threshold"]);
    expect(recorded).toEqual([
      { name: "_set_antialias_threshold", args: [0.5] },
      { name: "_set_node_batch_threshold", args: [12] },
    ]);
  });

  it("is a no-op without params", () => {
    expect(applyRouteParams(module, undefined)).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("setView", () => {
  it("negates the viewbox, which is what the view matrix expects", () => {
    setView(module, 2, { x: 100, y: -50 });
    expect(recorded).toEqual([{ name: "_set_view", args: [2, -100, 50] }]);
  });
});

describe("setViewerViewport", () => {
  it("pushes the view and ends the interaction", () => {
    expect(setViewerViewport(module, 1.5, { x: 10, y: 20 })).toBe(true);
    expect(recorded).toEqual([
      { name: "_set_view", args: [1.5, -10, -20] },
      { name: "_set_view_end", args: [] },
    ]);
  });

  it("is blocked while a reload is in progress", () => {
    markReloading();
    expect(setViewerViewport(module, 1, { x: 0, y: 0 })).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("renderSync", () => {
  it("paints the whole view synchronously", () => {
    expect(renderSync(module)).toBe(true);
    expect(recorded).toEqual([{ name: "_render_sync", args: [] }]);
  });

  it("is blocked while a reload is in progress", () => {
    markReloading();
    expect(renderSync(module)).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("renderSyncShape", () => {
  it("passes the four uuid words of the shape", () => {
    expect(renderSyncShape(module, "d8cf69c1-e3c8-8159-8008-6f934d0e82aa")).toBe(true);
    expect(recorded).toEqual([
      {
        name: "_render_sync_shape",
        args: [0xd8cf69c1, 0xe3c88159, 0x80086f93, 0x4d0e82aa],
      },
    ]);
  });

  it("is skipped when the context is lost", () => {
    markContextLost();
    expect(renderSyncShape(module, "d8cf69c1-e3c8-8159-8008-6f934d0e82aa")).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("setCanvasBackground", () => {
  it("sends the ARGB word and honours the opacity", () => {
    expect(setCanvasBackground(module, "#fff")).toBe(true);
    expect(setCanvasBackground(module, "#ff0000", 0.5)).toBe(true);
    expect(recorded).toEqual([
      { name: "_set_canvas_background", args: [0xffffffff] },
      { name: "_set_canvas_background", args: [0x7fff0000] },
    ]);
  });

  it("is skipped when the context is lost", () => {
    markContextLost();
    expect(setCanvasBackground(module, "#000")).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("objectCount", () => {
  it("counts the values of the page objects map", () => {
    expect(objectCount({ a: 1, b: 2 })).toBe(2);
    expect(objectCount(new Map([["a", 1]]))).toBe(1);
    expect(objectCount({})).toBe(0);
  });
});

describe("initializeViewport", () => {
  const objects = { a: {}, b: {} };

  it("runs the bootstrap in the compiled order", () => {
    const order: string[] = [];
    const setObjects = (value: unknown): void => {
      order.push("setObjects");
      expect(value).toBe(objects);
    };

    const result = initializeViewport(module, objects, 2, { x: 5, y: 6 }, {
      background: "#123456",
      setObjects,
      stopProgressiveRender: () => order.push("stop"),
    });

    expect(result).toBe(true);
    expect(order).toEqual(["stop", "setObjects"]);
    expect(recorded).toEqual([
      { name: "_set_canvas_background", args: [0xff123456] },
      { name: "_set_view", args: [2, -5, -6] },
      { name: "_init_shapes_pool", args: [2] },
    ]);
  });

  it("skips the background when none was given but still sizes the pool", () => {
    initializeViewport(module, objects, 1, { x: 1, y: 2 }, { setObjects: () => undefined });

    expect(recorded).toEqual([
      { name: "_set_view", args: [1, -1, -2] },
      { name: "_init_shapes_pool", args: [2] },
    ]);
  });

  it("does nothing while the context is lost", () => {
    markContextLost();
    let uploaded = false;
    expect(
      initializeViewport(module, objects, 1, { x: 0, y: 0 }, {
        setObjects: () => (uploaded = true),
      }),
    ).toBe(false);
    expect(uploaded).toBe(false);
    expect(recorded).toEqual([]);
  });
});