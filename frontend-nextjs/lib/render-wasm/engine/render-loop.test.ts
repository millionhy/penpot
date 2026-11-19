import { describe, expect, it } from "vitest";
import {
  FRAME_TYPE,
  RENDER_DEBOUNCE_MS,
  RENDER_FLAG_SYNC_TILES,
  RenderLoop,
  type RenderLoopHost,
} from "./render-loop";
import type { RenderWasmModule } from "./module";

interface Recorded {
  name: string;
  args: unknown[];
}

class FakeClock {
  private frames = new Map<number, (timestamp: number) => void>();
  private timers = new Map<number, { callback: () => void; delay: number }>();
  readonly cancelledFrames: number[] = [];
  readonly cancelledTimers: number[] = [];
  private nextId = 1;

  requestFrame = (callback: (timestamp: number) => void): number => {
    const id = this.nextId++;
    this.frames.set(id, callback);
    return id;
  };

  cancelFrame = (id: number): void => {
    this.cancelledFrames.push(id);
    this.frames.delete(id);
  };

  schedule = (callback: () => void, delay: number): number => {
    const id = this.nextId++;
    this.timers.set(id, { callback, delay });
    return id;
  };

  cancelScheduled = (id: number): void => {
    this.cancelledTimers.push(id);
    this.timers.delete(id);
  };

  get pendingFrames(): number {
    return this.frames.size;
  }

  get pendingTimers(): number {
    return this.timers.size;
  }

  get lastFrame(): ((timestamp: number) => void) | undefined {
    return [...this.frames.values()].at(-1);
  }

  get lastDelay(): number | undefined {
    return [...this.timers.values()].at(-1)?.delay;
  }

  flushFrames(timestamp = 0): void {
    const pending = [...this.frames.values()];
    this.frames.clear();
    for (const callback of pending) callback(timestamp);
  }

  runTimers(): void {
    const pending = [...this.timers.values()];
    this.timers.clear();
    for (const timer of pending) timer.callback();
  }
}

interface Harness {
  loop: RenderLoop;
  clock: FakeClock;
  module: RenderWasmModule;
  recorded: Recorded[];
  errors: unknown[];
  renders: number[];
  setLive: (value: boolean) => void;
  setRenderResult: (value: number | ((timestamp: number) => number)) => void;
  setPageTransition: (value: boolean) => void;
  setGestureActive: (value: boolean) => void;
}

function makeHarness(overrides: Partial<RenderLoopHost> = {}): Harness {
  const recorded: Recorded[] = [];
  const errors: unknown[] = [];
  const renders: number[] = [];
  const clock = new FakeClock();

  let isLive = true;
  let renderResult: number | ((timestamp: number) => number) = FRAME_TYPE.full;
  let pageTransition = false;
  let gestureActive = false;

  const record =
    (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

  const module: RenderWasmModule = {
    HEAPU8: new Uint8Array(8),
    HEAPU32: new Uint32Array(2),
    HEAP32: new Int32Array(2),
    HEAPF32: new Float32Array(2),
    UTF8ToString: () => "",
    _render: (timestamp: number, flags: number) => {
      recorded.push({ name: "_render", args: [timestamp, flags] });
      return typeof renderResult === "function" ? renderResult(timestamp) : renderResult;
    },
    _render_sync: record("_render_sync"),
    _render_from_cache: record("_render_from_cache"),
    _render_from_backbuffer: record("_render_from_backbuffer"),
    _render_ui_only: record("_render_ui_only"),
    _render_preview: record("_render_preview"),
    _render_blurred_snapshot: record("_render_blurred_snapshot"),
    _set_view: record("_set_view"),
    _set_view_start: record("_set_view_start"),
    _set_view_end: record("_set_view_end"),
  };

  const host: RenderLoopHost = {
    module: () => module,
    live: () => isLive,
    requestFrame: clock.requestFrame,
    cancelFrame: clock.cancelFrame,
    schedule: clock.schedule,
    cancelScheduled: clock.cancelScheduled,
    now: () => 500,
    onRender: (timestamp) => renders.push(timestamp),
    onError: (cause) => errors.push(cause),
    isPageTransition: () => pageTransition,
    isGestureActive: () => gestureActive,
    ...overrides,
  };

  return {
    loop: new RenderLoop(host),
    clock,
    module,
    recorded,
    errors,
    renders,
    setLive: (value: boolean) => (isLive = value),
    setRenderResult: (value) => (renderResult = value),
    setPageTransition: (value) => (pageTransition = value),
    setGestureActive: (value) => (gestureActive = value),
  };
}

function names(recorded: Recorded[]): string[] {
  return recorded.map((entry) => entry.name);
}

describe("requestRender", () => {
  it("schedules a single frame and runs the render on it", () => {
    const harness = makeHarness();

    expect(harness.loop.requestRender("test")).toBe(true);
    expect(harness.loop.isPending()).toBe(true);
    expect(harness.clock.pendingFrames).toBe(1);
    expect(harness.loop.frameId).toBeDefined();

    expect(harness.loop.requestRender("again")).toBe(false);
    expect(harness.clock.pendingFrames).toBe(1);

    harness.clock.flushFrames(42);

    expect(harness.loop.isPending()).toBe(false);
    expect(harness.loop.frameId).toBeUndefined();
    expect(harness.recorded).toEqual([{ name: "_render", args: [42, 0] }]);
    expect(harness.renders).toEqual([42]);
    expect(harness.loop.frameType).toBe(FRAME_TYPE.full);
  });

  it("asks for another frame while the tile pass is partial", () => {
    const harness = makeHarness();
    harness.setRenderResult(FRAME_TYPE.partial);

    harness.loop.requestRender("test");
    harness.clock.flushFrames(1);

    expect(harness.loop.frameType).toBe(FRAME_TYPE.partial);
    expect(harness.loop.isPending()).toBe(true);
    expect(harness.clock.pendingFrames).toBe(1);

    harness.setRenderResult(FRAME_TYPE.viewportReady);
    harness.clock.flushFrames(2);
    expect(harness.loop.isPending()).toBe(true);

    harness.setRenderResult(FRAME_TYPE.full);
    harness.clock.flushFrames(3);
    expect(harness.loop.isPending()).toBe(false);
    expect(names(harness.recorded)).toEqual(["_render", "_render", "_render"]);
  });

  it("drops a frame whose sequence was invalidated", () => {
    const harness = makeHarness();
    harness.loop.requestRender("test");
    const stale = harness.clock.lastFrame;
    expect(stale).toBeDefined();

    harness.loop.stopProgressiveRender();
    expect(harness.clock.cancelledFrames).toHaveLength(1);
    expect(harness.loop.isPending()).toBe(false);

    stale?.(9);
    expect(harness.recorded).toEqual([]);
  });

  it("reports a failing render and keeps the loop usable", () => {
    const harness = makeHarness();
    harness.setRenderResult(() => {
      throw new Error("wasm panic");
    });

    harness.loop.requestRender("test");
    expect(() => harness.clock.flushFrames(1)).not.toThrow();

    expect(harness.loop.isPending()).toBe(false);
    expect(harness.errors).toHaveLength(1);
    // `call` wraps the trap into an EngineError; the loop reports that, not
    // the raw throwable.
    expect(harness.errors[0]).toMatchObject({ code: "wasm-critical" });

    harness.setRenderResult(FRAME_TYPE.full);
    expect(harness.loop.requestRender("retry")).toBe(true);
  });

  it("stays off while request-render is disabled or the context is not live", () => {
    const harness = makeHarness();
    harness.loop.setDisableRequestRender(true);
    expect(harness.loop.requestRender("test")).toBe(false);

    harness.loop.setDisableRequestRender(false);
    harness.setLive(false);
    expect(harness.loop.requestRender("test")).toBe(false);
    expect(harness.clock.pendingFrames).toBe(0);
  });
});

describe("shapes loading", () => {
  it("defers a render requested while the shapes are loading", () => {
    const harness = makeHarness();

    harness.loop.beginShapesLoading();
    expect(harness.loop.isShapesLoading()).toBe(true);
    expect(harness.loop.requestRender("while-loading")).toBe(false);
    expect(harness.loop.isRenderDeferred()).toBe(true);

    harness.loop.endShapesLoading();
    expect(harness.loop.isRenderDeferred()).toBe(false);
    expect(harness.clock.pendingFrames).toBe(1);

    harness.clock.flushFrames(5);
    expect(harness.recorded).toEqual([{ name: "_render", args: [5, 0] }]);
  });

  it("cancels the in-flight pass and keeps its pending state", () => {
    const harness = makeHarness();

    harness.loop.requestRender("test");
    expect(harness.clock.pendingFrames).toBe(1);

    harness.loop.beginShapesLoading();
    expect(harness.clock.pendingFrames).toBe(0);
    expect(harness.loop.isRenderDeferred()).toBe(true);

    harness.loop.endShapesLoading();
    expect(harness.clock.pendingFrames).toBe(1);
  });
});

describe("preserve target", () => {
  it("applies the sync-tiles flag once", () => {
    const harness = makeHarness();

    harness.loop.requestRenderPreservingTarget("edit");
    harness.clock.flushFrames(1);
    expect(harness.recorded.at(-1)).toEqual({
      name: "_render",
      args: [1, RENDER_FLAG_SYNC_TILES],
    });

    harness.loop.requestRender("plain");
    harness.clock.flushFrames(2);
    // A plain render carries the last frame type as its flags, like the
    // compiled no-argument arity of `internal-render`.
    expect(harness.recorded.at(-1)).toEqual({ name: "_render", args: [2, 2] });
  });
});

describe("setViewBox", () => {
  it("pushes the view, blits the cache and finalizes after the debounce", () => {
    const harness = makeHarness();

    expect(harness.loop.setViewBox(2, { x: 10, y: 20 })).toBe(true);
    expect(harness.loop.isViewInteractionActive()).toBe(true);
    expect(names(harness.recorded)).toEqual(["_set_view_start", "_set_view", "_render_from_cache"]);
    expect(harness.recorded[1].args).toEqual([2, -10, -20]);
    expect(harness.recorded[2].args).toEqual([0]);
    expect(harness.clock.pendingTimers).toBe(1);
    expect(harness.clock.lastDelay).toBe(RENDER_DEBOUNCE_MS);

    harness.clock.runTimers();

    expect(names(harness.recorded).slice(-2)).toEqual(["_set_view_end", "_render"]);
    expect(harness.recorded.at(-1)?.args).toEqual([500, RENDER_FLAG_SYNC_TILES]);
    expect(harness.loop.isViewInteractionActive()).toBe(false);
  });

  it("keeps the gesture open while a pan or zoom is still active", () => {
    const harness = makeHarness();
    harness.setGestureActive(true);

    harness.loop.setViewBox(1, { x: 0, y: 0 });
    harness.recorded.length = 0;
    harness.clock.runTimers();

    expect(names(harness.recorded)).toEqual(["_render"]);
    expect(harness.recorded[0].args).toEqual([500, RENDER_FLAG_SYNC_TILES]);
    expect(harness.loop.isViewInteractionActive()).toBe(true);
  });

  it("freezes during a page transition and records the dirty viewport", () => {
    const harness = makeHarness();
    harness.setPageTransition(true);

    expect(harness.loop.setViewBox(1, { x: 0, y: 0 })).toBe(false);
    expect(harness.recorded).toEqual([]);
    expect(harness.loop.isViewportDirtyDuringTransition()).toBe(true);

    expect(harness.loop.consumeViewportDirty()).toBe(true);
    expect(harness.loop.consumeViewportDirty()).toBe(false);
  });

  it("does nothing when the context is not ready", () => {
    const harness = makeHarness();
    harness.setLive(false);

    expect(harness.loop.setViewBox(1, { x: 0, y: 0 })).toBe(false);
    expect(harness.clock.pendingTimers).toBe(0);
  });
});

describe("explicit renders", () => {
  it("clears the scheduled frame handle", () => {
    const harness = makeHarness();
    harness.loop.requestRender("test");

    expect(harness.loop.renderSync()).toBe(true);
    expect(harness.loop.frameId).toBeUndefined();

    harness.loop.stopProgressiveRender();
    expect(harness.clock.cancelledFrames).toEqual([]);
  });

  it("forwards the single-shot entries and their arguments", () => {
    const harness = makeHarness();

    expect(harness.loop.renderFromCache()).toBe(true);
    expect(harness.loop.renderFromBackbuffer()).toBe(true);
    expect(harness.loop.renderUiOnly()).toBe(true);
    expect(harness.loop.renderPreview()).toBe(true);
    expect(harness.loop.renderBlurredSnapshot(4)).toBe(true);

    expect(names(harness.recorded)).toEqual([
      "_render_from_cache",
      "_render_from_backbuffer",
      "_render_ui_only",
      "_render_preview",
      "_render_blurred_snapshot",
    ]);
    expect(harness.recorded.at(-1)?.args).toEqual([4]);
  });

  it("drops the timer and the pending frame on dispose", () => {
    const harness = makeHarness();
    harness.loop.setViewBox(1, { x: 0, y: 0 });

    harness.loop.dispose();

    expect(harness.clock.cancelledTimers).toHaveLength(1);
    expect(harness.loop.isViewInteractionActive()).toBe(false);
    expect(harness.loop.isPending()).toBe(false);
  });
});