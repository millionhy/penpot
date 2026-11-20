// Unit tests for the viewer's shared offscreen pass
// (lib/render-wasm/viewer-render.ts).
//
// The engine barrel is mocked: the pass only orchestrates the engine calls
// (init -> initializeViewport -> setObjects -> render -> paint) and the
// snapshot reuse, and the real wasm pass runs under headless Chrome. The
// DOM globals the blit needs are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderWasmModule } from "@/lib/render-wasm/engine";
import {
  acquireViewerContext,
  releaseViewerContext,
  renderViewerFrame,
  resetViewerSnapshot,
} from "@/lib/render-wasm/viewer-render";

const FRAME_ID = "ce2c7122-e68e-80f8-8008-70ba4384966f";

interface EngineState {
  calls: Array<{ name: string; args: unknown[] }>;
  ready: boolean;
  initOk: boolean;
  autoRender: boolean;
  pendingRenders: Array<() => void>;
}

const { state, engineMock } = vi.hoisted(() => {
  const state: EngineState = {
    calls: [],
    ready: true,
    initOk: true,
    autoRender: true,
    pendingRenders: [],
  };
  const record = (name: string, args: unknown[]): void => {
    state.calls.push({ name, args });
  };

  const engineMock = {
    ready: () => state.ready,
    readDpr: () => 1,
    clearCanvas: (_module: unknown, options: unknown) => record("clear-canvas", [options]),
    initCanvasContext: (_module: unknown, canvas: unknown) => {
      record("init-canvas-context", [canvas]);
      return state.initOk ? {} : undefined;
    },
    initializeViewport: (
      _module: unknown,
      objects: unknown,
      scale: number,
      vbox: unknown,
      options: { setObjects: (objects: unknown) => void },
    ) => {
      record("initialize-viewport", [objects, scale, vbox]);
      options.setObjects(objects);
      return true;
    },
    setObjects: (
      _module: unknown,
      objects: Record<string, { id?: string }>,
      options: { onShape?: (shape: { id?: string }) => void; render?: () => void },
    ) => {
      record("set-objects", [objects]);
      for (const shape of Object.values(objects)) {
        if (shape.id !== undefined) options.onShape?.(shape);
      }
      if (state.autoRender) options.render?.();
      else if (options.render !== undefined) state.pendingRenders.push(options.render);
      return undefined;
    },
    resizeOffscreenCanvas: (_module: unknown, _canvas: unknown, width: number, height: number) =>
      record("resize-offscreen-canvas", [width, height]),
    setRulersFrameVisible: (_module: unknown, value: boolean) =>
      record("set-rulers-frame-visible", [value]),
    setRulersVisible: (_module: unknown, value: boolean) => record("set-rulers-visible", [value]),
    setViewerViewport: (_module: unknown, scale: number, vbox: unknown) =>
      record("set-viewer-viewport", [scale, vbox]),
    renderSyncShape: (_module: unknown, id: string) => record("render-sync-shape", [id]),
  };

  return { state, engineMock };
});

vi.mock("@/lib/render-wasm/engine", () => engineMock);

// --- stubbed DOM globals ----------------------------------------------------

function stubDom(width = 168, height = 264) {
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(w: number, h: number) {
        this.width = w;
        this.height = h;
      }
    },
  );
  const bitmap = { close: vi.fn() };
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
  const canvas = {
    width,
    height,
    id: "",
    getContext: vi.fn(() => ctx),
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx, bitmap };
}

const module = {} as RenderWasmModule;
const objects = {
  [FRAME_ID]: { id: FRAME_ID, type: "frame" },
  "11111111-1111-1111-1111-111111111111": { id: "11111111-1111-1111-1111-111111111111", type: "rect" },
};
const host = { hostAttrs: vi.fn(), settle: vi.fn(async () => undefined) };

beforeEach(() => {
  state.calls = [];
  state.ready = true;
  state.initOk = true;
  state.autoRender = true;
  state.pendingRenders = [];
  host.hostAttrs.mockClear();
  host.settle.mockClear();
  resetViewerSnapshot();
  // Drop the holders a previous case left behind.
  while (!releaseViewerContext()) {
    // keep releasing until the count reaches zero
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("renderViewerFrame", () => {
  it("builds the context, settles the host and paints the frame", async () => {
    const dom = stubDom();

    await renderViewerFrame(module, dom.canvas, {
      pageKey: "page-1",
      pageObjects: objects,
      size: { x: 10, y: 20 },
      scale: 2,
      frameId: FRAME_ID,
      host,
    });

    // The snapshot was reset but the mock context is still live, so the
    // fresh path hands the old context back first (CLJS initialized?).
    expect(state.calls.map((call) => call.name)).toEqual([
      "clear-canvas",
      "init-canvas-context",
      "initialize-viewport",
      "set-objects",
      "set-rulers-frame-visible",
      "set-rulers-visible",
      "set-viewer-viewport",
      "render-sync-shape",
    ]);

    // The host hosted every uploaded shape before the paint.
    expect(host.hostAttrs).toHaveBeenCalledTimes(Object.keys(objects).length);
    expect(host.settle).toHaveBeenCalledTimes(1);

    expect(state.calls[6].args).toEqual([2, { x: 10, y: 20 }]);
    expect(state.calls[7].args).toEqual([FRAME_ID]);
    expect(dom.ctx.drawImage).toHaveBeenCalledWith(dom.bitmap, 0, 0, 168, 264);
    expect(dom.canvas.id).toBe(`screenshot-${FRAME_ID}`);
  });

  it("reuses the snapshot for the same page and rebuilds on a size change", async () => {
    const first = stubDom();
    const options = {
      pageKey: "page-1",
      pageObjects: objects,
      size: { x: 0, y: 0 },
      scale: 1,
      frameId: FRAME_ID,
      host,
    };

    await renderViewerFrame(module, first.canvas, options);
    const inits = () => state.calls.filter((call) => call.name === "init-canvas-context").length;
    expect(inits()).toBe(1);

    // Same page, same size: the snapshot answers and nothing re-uploads.
    state.calls = [];
    await renderViewerFrame(module, first.canvas, { ...options, scale: 2 });
    expect(inits()).toBe(0);
    expect(state.calls.some((call) => call.name === "initialize-viewport")).toBe(false);
    expect(state.calls.map((call) => call.name)).toEqual([
      "set-rulers-frame-visible",
      "set-rulers-visible",
      "set-viewer-viewport",
      "render-sync-shape",
    ]);

    // A different page rebuilds, and so does a resized canvas.
    state.calls = [];
    await renderViewerFrame(module, first.canvas, { ...options, pageKey: "page-2" });
    expect(inits()).toBe(1);

    state.calls = [];
    const bigger = stubDom(336, 528);
    await renderViewerFrame(module, bigger.canvas, { ...options, pageKey: "page-2" });
    expect(inits()).toBe(0);
    expect(state.calls[0]).toEqual({ name: "resize-offscreen-canvas", args: [336, 528] });
  });

  it("finishes the pass when the context cannot be created", async () => {
    const dom = stubDom();
    state.initOk = false;

    const onRender = vi.fn();
    await renderViewerFrame(module, dom.canvas, {
      pageKey: "page-1",
      pageObjects: objects,
      size: { x: 0, y: 0 },
      scale: 1,
      frameId: FRAME_ID,
      host,
      onRender,
    });

    expect(onRender).toHaveBeenCalledTimes(1);
    expect(state.calls.map((call) => call.name)).toEqual([
      "clear-canvas",
      "init-canvas-context",
    ]);
    expect(host.settle).not.toHaveBeenCalled();
  });
});

describe("viewer context holders", () => {
  it("hands the shared context back only with the last holder", () => {
    // The main viewport and one overlay, both on the same context.
    acquireViewerContext();
    acquireViewerContext();

    // Closing the overlay keeps the context for the viewport behind it.
    expect(releaseViewerContext()).toBe(false);
    // Leaving the viewer releases it.
    expect(releaseViewerContext()).toBe(true);

    // A late release must not go negative.
    expect(releaseViewerContext()).toBe(true);
    expect(releaseViewerContext()).toBe(true);
  });
});
