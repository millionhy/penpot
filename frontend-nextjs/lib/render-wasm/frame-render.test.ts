// Unit tests for the one-shot frame render (lib/render-wasm/frame-render.ts).
//
// The flow tests mock the engine barrel: the pass only orchestrates the
// engine calls (init -> initializeViewport -> setObjects -> render -> paint),
// and the real wasm end-to-end pass runs under headless Chrome, not here.
// The DOM globals the blit needs (OffscreenCanvas, createImageBitmap,
// requestAnimationFrame) are stubbed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderFrameToCanvas } from "@/lib/render-wasm/frame-render";
import type { RenderWasmModule } from "@/lib/render-wasm/engine";

const FRAME_ID = "ce2c7122-e68e-80f8-8008-70ba4384966f";

// --- mocked engine ----------------------------------------------------------

interface EngineState {
  calls: Array<{ name: string; args: unknown[] }>;
  autoRender: boolean;
  initOk: boolean;
  pendingRenders: Array<() => void>;
  shapedIds: string[];
}

const { state, engineMock } = vi.hoisted(() => {
  const state: EngineState = {
    calls: [],
    autoRender: true,
    initOk: true,
    pendingRenders: [],
    shapedIds: [],
  };
  const record = (name: string, args: unknown[]): void => {
    state.calls.push({ name, args });
  };

  const engineMock = {
    initCanvasContext: (_module: unknown, canvas: unknown) => {
      record("init-canvas-context", [canvas]);
      return state.initOk ? {} : undefined;
    },
    initializeViewport: (
      _module: unknown,
      objects: Record<string, { id?: string }>,
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
        if (shape.id !== undefined) {
          state.shapedIds.push(shape.id);
          options.onShape?.(shape);
        }
      }
      if (state.autoRender) options.render?.();
      else if (options.render !== undefined) state.pendingRenders.push(options.render);
      return undefined;
    },
    setRulersFrameVisible: (_module: unknown, value: boolean) =>
      record("set-rulers-frame-visible", [value]),
    setRulersVisible: (_module: unknown, value: boolean) => record("set-rulers-visible", [value]),
    renderSyncShape: (_module: unknown, id: string) => record("render-sync-shape", [id]),
    clearCanvas: (_module: unknown, options: unknown) => record("clear-canvas", [options]),
    // The viewer-render module the frame render imports also reads these.
    ready: () => true,
    readDpr: () => 1,
    resizeOffscreenCanvas: () => true,
    setViewerViewport: () => true,
  };

  return { state, engineMock };
});

vi.mock("@/lib/render-wasm/engine", () => engineMock);

// --- stubbed DOM globals ----------------------------------------------------

function stubDom() {
  const bitmap = { close: vi.fn() };
  const ctx = { clearRect: vi.fn(), drawImage: vi.fn() };
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
    },
  );
  vi.stubGlobal(
    "createImageBitmap",
    vi.fn(async () => bitmap),
  );
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  });
  const canvas = {
    width: 168,
    height: 264,
    id: "",
    getContext: vi.fn(() => ctx),
  } as unknown as HTMLCanvasElement;
  return { bitmap, ctx, canvas };
}

const module = {} as RenderWasmModule;
const objects = {
  [FRAME_ID]: { id: FRAME_ID, type: "frame" },
  "11111111-1111-1111-1111-111111111111": { id: "11111111-1111-1111-1111-111111111111", type: "rect" },
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  state.calls = [];
  state.autoRender = true;
  state.initOk = true;
  state.pendingRenders = [];
  state.shapedIds = [];
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the pass ---------------------------------------------------------------

describe("renderFrameToCanvas", () => {
  it("runs the one-shot pass and blits the bitmap", async () => {
    const dom = stubDom();
    const settle = vi.fn(async () => {
      state.calls.push({ name: "host-settle", args: [] });
    });

    await renderFrameToCanvas(module, objects, FRAME_ID, dom.canvas, { x: 10, y: 20 }, 2, {
      host: { hostAttrs: vi.fn(), settle },
    });

    // The compiled order: init (offscreen) -> initializeViewport, the
    // upload with the host work, then the render (rulers off, sync shape,
    // blit) and clear.
    expect(state.calls.map((call) => call.name)).toEqual([
      "init-canvas-context",
      "initialize-viewport",
      "set-objects",
      "host-settle",
      "set-rulers-frame-visible",
      "set-rulers-visible",
      "render-sync-shape",
      "clear-canvas",
    ]);

    // The offscreen canvas carries the physical size of the target canvas.
    const osCanvas = state.calls[0].args[0] as { width: number; height: number };
    expect([osCanvas.width, osCanvas.height]).toEqual([168, 264]);

    // initializeViewport(objects, scale, origin, {backgroundOpacity: 0}).
    const viewport = state.calls[1].args;
    expect(viewport[0]).toBe(objects);
    expect(viewport[1]).toBe(2);
    expect(viewport[2]).toEqual({ x: 10, y: 20 });

    // The host hosted every uploaded shape.
    expect(state.shapedIds).toEqual(Object.keys(objects));
    expect(settle).toHaveBeenCalledTimes(1);

    // The final render uses the frame id.
    expect(state.calls[6].args).toEqual([FRAME_ID]);

    // The blit reads the offscreen canvas and paints the target canvas.
    expect(dom.ctx.clearRect).toHaveBeenCalledWith(0, 0, 168, 264);
    expect(dom.ctx.drawImage).toHaveBeenCalledWith(dom.bitmap, 0, 0, 168, 264);
    expect(dom.bitmap.close).toHaveBeenCalled();
    expect(dom.canvas.id).toBe(`screenshot-${FRAME_ID}`);

    // clearCanvas hands the shared context back (loseBrowserContext false).
    expect(state.calls[7].args).toEqual([{ loseBrowserContext: false }]);
  });

  it("fails when the GL context cannot be created", async () => {
    const dom = stubDom();
    state.initOk = false;

    await expect(
      renderFrameToCanvas(module, objects, FRAME_ID, dom.canvas, { x: 0, y: 0 }, 1),
    ).rejects.toThrow(/GL context/);
    expect(state.calls.map((call) => call.name)).toEqual(["init-canvas-context"]);
  });

  it("serializes concurrent renders through the queue", async () => {
    const dom = stubDom();
    state.autoRender = false;

    const first = renderFrameToCanvas(
      module,
      objects,
      "11111111-1111-1111-1111-111111111111",
      dom.canvas,
      { x: 0, y: 0 },
      1,
    );
    const second = renderFrameToCanvas(
      module,
      objects,
      "22222222-2222-2222-2222-222222222222",
      dom.canvas,
      { x: 0, y: 0 },
      1,
    );

    await flush();
    // Only the first render started; the second waits on the queue.
    expect(state.calls.filter((call) => call.name === "init-canvas-context")).toHaveLength(1);

    state.pendingRenders.shift()?.();
    await first;
    await flush();
    // The second may start only now that the first finished.
    expect(state.calls.filter((call) => call.name === "init-canvas-context")).toHaveLength(2);

    state.pendingRenders.shift()?.();
    await second;
    expect(state.calls.filter((call) => call.name === "render-sync-shape")).toHaveLength(2);
  });
});
