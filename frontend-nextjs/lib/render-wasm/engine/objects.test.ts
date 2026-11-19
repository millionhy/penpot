import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markContextInitialized,
  markContextLost,
  markReloading,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  BATCH_MAX_SHAPES,
  needsShapeTail,
  serializeShape,
  serializeShapesBatch,
  setObject,
  setObjects,
  shapesInTreeOrder,
  type ShapesLoadingSink,
} from "./objects";
import type { Shape } from "./upload";
import { initializeViewport } from "./viewport";
import { ZERO_UUID } from "./uuid";

const ROOT = ZERO_UUID;
const A = "aaaaaaaa-0000-0000-0000-000000000001";
const B = "bbbbbbbb-0000-0000-0000-000000000002";
const C = "cccccccc-0000-0000-0000-000000000003";
const D = "dddddddd-0000-0000-0000-000000000004";

interface Recorded {
  name: string;
  args: unknown[];
}

function makeModule(recorded: Recorded[], heapSize = 1 << 16): RenderWasmModule {
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
    _set_shapes_batch: record("_set_shapes_batch"),
    _begin_loading: record("_begin_loading"),
    _end_loading: record("_end_loading"),
    _set_view: record("_set_view"),
    _init_shapes_pool: record("_init_shapes_pool"),
    _set_view_end: record("_set_view_end"),
    _use_shape: record("_use_shape"),
    _set_shape_svg_attrs: record("_set_shape_svg_attrs"),
    _start_shape_path_buffer: record("_start_shape_path_buffer"),
    _set_shape_path_chunk_buffer: record("_set_shape_path_chunk_buffer"),
    _set_shape_path_buffer: record("_set_shape_path_buffer"),
  };
}

function shape(id: string, overrides: Partial<Shape> = {}): Shape {
  return { id, type: "rect", ...overrides };
}

function tree(): Record<string, Shape> {
  return {
    [ROOT]: shape(ROOT, { type: "frame", shapes: [A, B] }),
    [A]: shape(A, { "parent-id": ROOT, shapes: [C] }),
    [B]: shape(B, { "parent-id": ROOT }),
    [C]: shape(C, { "parent-id": A }),
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
  vi.restoreAllMocks();
});

function names(): string[] {
  return recorded.map((entry) => entry.name);
}

describe("shapesInTreeOrder", () => {
  it("walks from the root, parents before children, in children order", () => {
    expect(shapesInTreeOrder(tree()).map((s) => s.id)).toEqual([ROOT, A, C, B]);
  });

  it("falls back to the top-level shapes when the map has no root", () => {
    const objects = {
      [A]: shape(A, { "parent-id": ROOT, shapes: [B] }),
      [B]: shape(B, { "parent-id": A }),
      [D]: shape(D, { "parent-id": "outside" }),
    };
    expect(shapesInTreeOrder(objects).map((s) => s.id)).toEqual([A, B, D]);
  });

  it("accepts a Map", () => {
    const objects = new Map(Object.entries(tree()));
    expect(shapesInTreeOrder(objects).map((s) => s.id)).toEqual([ROOT, A, C, B]);
  });

  it("skips ids that the map does not hold and survives a cycle", () => {
    const objects = {
      [ROOT]: shape(ROOT, { type: "frame", shapes: [A, D] }),
      [A]: shape(A, { "parent-id": ROOT, shapes: [ROOT] }),
    };
    expect(shapesInTreeOrder(objects).map((s) => s.id)).toEqual([ROOT, A]);
  });
});

describe("needsShapeTail", () => {
  it("is true for svg attrs on any type", () => {
    expect(needsShapeTail(shape(A, { "svg-attrs": { fill: "none" } }))).toBe(true);
  });

  it("is true for path and bool content only", () => {
    expect(needsShapeTail(shape(A, { type: "path", content: new Uint8Array(28) }))).toBe(true);
    expect(needsShapeTail(shape(A, { type: "bool", content: new Uint8Array(28) }))).toBe(true);
    expect(needsShapeTail(shape(A, { type: "path", content: "not bytes" }))).toBe(false);
    expect(needsShapeTail(shape(A, { type: "rect", content: new Uint8Array(4) }))).toBe(false);
  });
});

describe("serializeShapesBatch", () => {
  it("uploads once and selects each shape that needs the tail", () => {
    const tailed = shape(A, {
      type: "path",
      content: new Uint8Array([1, 2, 3, 4]),
      "svg-attrs": { style: { fill: "none" } },
    });
    serializeShapesBatch(module, [tailed, shape(B)]);

    expect(names()).toEqual([
      "_alloc_bytes",
      "_set_shapes_batch",
      "_use_shape",
      "_set_shape_svg_attrs",
      "_start_shape_path_buffer",
      "_alloc_bytes",
      "_set_shape_path_chunk_buffer",
      "_set_shape_path_buffer",
    ]);
    expect(recorded[2].args).toEqual([0xaaaaaaaa, 0, 0, 1]);
  });

  it("does nothing for an empty list", () => {
    expect(serializeShapesBatch(module, [])).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

describe("svg-derived attrs", () => {
  it("derives the fills of a raw svg shape before the upload", () => {
    const derived = serializeShape(
      module,
      shape(A, { type: "svg-raw", "svg-attrs": { fill: "red" } }),
    );
    expect(derived.id).toBe(A);
    expect(derived.fills).toEqual([{ "fill-color": "#ff0000" }]);
    expect(derived).not.toBe(
      shape(A, { type: "svg-raw", "svg-attrs": { fill: "red" } }),
    );
  });

  it("keeps the model fills when the shape has them", () => {
    const fills = [{ "fill-color": "#123456" }];
    const derived = serializeShapesBatch(module, [
      shape(A, { "svg-attrs": { fill: "red" }, fills }),
    ])[0];
    expect(derived.fills).toEqual(fills);
  });
});

describe("setObject", () => {
  it("does nothing without a live context", () => {
    markContextLost(true);
    expect(setObject(module, shape(A))).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("uploads the single shape and hands it to the host hook", () => {
    const onShape = vi.fn();
    expect(setObject(module, shape(A), { onShape })?.id).toBe(A);
    expect(names()).toEqual(["_alloc_bytes", "_set_shapes_batch"]);
    expect(onShape).toHaveBeenCalledTimes(1);
  });

  it("runs under reloading, which only blocks application callers", () => {
    markReloading(true);
    expect(setObject(module, shape(A))?.id).toBe(A);
  });
});

describe("setObjects", () => {
  function sink(): ShapesLoadingSink & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      beginShapesLoading: () => calls.push("begin"),
      endShapesLoading: () => calls.push("end"),
      resetViewInteraction: () => calls.push("reset"),
      requestRender: (reason: string) => {
        calls.push(`render:${reason}`);
        return true;
      },
    };
  }

  it("does nothing without a live context", () => {
    markContextLost(true);
    expect(setObjects(module, tree())).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("takes the sync path below the threshold and closes with a render", () => {
    const loop = sink();
    const onShapesReady = vi.fn();
    const onShape = vi.fn();

    expect(setObjects(module, tree(), { loop, onShapesReady, onShape })).toBeUndefined();

    expect(names().filter((name) => name === "_set_shapes_batch")).toHaveLength(1);
    expect(names()).not.toContain("_begin_loading");
    expect(names()).not.toContain("_end_loading");
    expect(names()).toContain("_set_view_end");
    expect(loop.calls).toEqual(["reset", "render:set-objects-complete"]);
    expect(onShapesReady).toHaveBeenCalledTimes(1);
    expect(onShape).toHaveBeenCalledTimes(4);
  });

  it("honours an explicit render callback instead of the loop", () => {
    const loop = sink();
    const render = vi.fn();
    setObjects(module, tree(), { loop, render, forceSync: true });
    expect(render).toHaveBeenCalledTimes(1);
    expect(loop.calls).toEqual(["reset"]);
  });

  it("takes the async path from the threshold on, one chunk at a time", async () => {
    const loop = sink();
    const events: string[] = [];
    const yieldToBrowser = vi.fn(async () => {
      events.push("yield");
    });
    const onShapesReady = vi.fn(() => events.push("ready"));

    const pending = setObjects(module, tree(), {
      loop,
      asyncThreshold: 2,
      batchMaxShapes: 2,
      yieldToBrowser,
      onShapesReady,
    });
    expect(pending).toBeInstanceOf(Promise);
    await pending;

    expect(yieldToBrowser).toHaveBeenCalledTimes(2); // 4 shapes, 2 per chunk
    expect(names().filter((name) => name === "_set_shapes_batch")).toHaveLength(2);
    expect(names().indexOf("_begin_loading")).toBeLessThan(names().indexOf("_end_loading"));
    expect(names()).toContain("_set_view_end");
    expect(events).toEqual(["yield", "yield", "ready"]);
    expect(loop.calls).toEqual(["begin", "end", "reset", "render:set-objects-complete"]);
  });

  it("stops before ending the loading overlay when the context died", async () => {
    const loop = sink();
    const pending = setObjects(module, tree(), {
      loop,
      asyncThreshold: 2,
      yieldToBrowser: async () => markContextLost(true),
    });
    await pending;

    expect(names()).not.toContain("_end_loading");
    expect(names()).not.toContain("_set_view_end");
    expect(loop.calls).toEqual(["begin", "end"]);
  });

  it("clears the loading state and logs when a chunk throws", async () => {
    const loop = sink();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    (module as Record<string, unknown>)._set_shapes_batch = () => {
      throw new Error("trap");
    };

    await setObjects(module, tree(), {
      loop,
      asyncThreshold: 2,
      yieldToBrowser: async () => {},
    });

    expect(loop.calls).toEqual(["begin", "end"]);
    expect(consoleError).toHaveBeenCalledTimes(1);
  });

  it("caps a chunk at BATCH_MAX_SHAPES by default", async () => {
    const objects: Record<string, Shape> = {
      [ROOT]: shape(ROOT, { type: "frame", shapes: [] }),
    };
    for (let index = 1; index <= BATCH_MAX_SHAPES + 1; index += 1) {
      const id = `00000000-0000-0000-0000-${String(index).padStart(12, "0")}`;
      objects[id] = shape(id, { "parent-id": ROOT });
      (objects[ROOT].shapes as string[]).push(id);
    }

    // 513 shapes need more room than the default fake heap.
    const big = makeModule(recorded, 1 << 20);
    setModule(big);
    await setObjects(big, objects, { loop: sink(), asyncThreshold: 1, yieldToBrowser: async () => {} });
    expect(names().filter((name) => name === "_set_shapes_batch")).toHaveLength(2);
  });

  it("plugs into initializeViewport's upload hook after the pool is sized", () => {
    const loop = sink();
    const seen: string[] = [];

    initializeViewport(module, tree(), 2, { x: 10, y: 20 }, {
      setObjects: (objects) => {
        seen.push("upload");
        setObjects(module, objects as Parameters<typeof setObjects>[1], { loop });
      },
    });

    expect(seen).toEqual(["upload"]);
    expect(names().indexOf("_set_view")).toBeLessThan(names().indexOf("_init_shapes_pool"));
    expect(names().indexOf("_init_shapes_pool")).toBeLessThan(
      names().indexOf("_set_shapes_batch"),
    );
    expect(loop.calls).toEqual(["reset", "render:set-objects-complete"]);
  });
});