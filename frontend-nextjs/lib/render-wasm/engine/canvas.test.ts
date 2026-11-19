import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canvasCssSize,
  clampPhysicalSize,
  clearCanvas,
  currentCanvasContext,
  initCanvasContext,
  readDpr,
  resizeCanvas,
  resizeOffscreenCanvas,
} from "./canvas";
import {
  live,
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

interface FakeGl {
  calls: string[];
  handles: number[];
}

function makeModule(recorded: Recorded[], overrides: Record<string, unknown> = {}): RenderWasmModule {
  const exported: Record<string, unknown> = {
    _init: (...args: unknown[]) => recorded.push({ name: "_init", args }),
    _set_render_options: (...args: unknown[]) =>
      recorded.push({ name: "_set_render_options", args }),
    _resize_viewbox: (...args: unknown[]) =>
      recorded.push({ name: "_resize_viewbox", args }),
    _set_browser: (...args: unknown[]) => recorded.push({ name: "_set_browser", args }),
    _set_canvas_background: (...args: unknown[]) =>
      recorded.push({ name: "_set_canvas_background", args }),
    _set_antialias_threshold: (...args: unknown[]) =>
      recorded.push({ name: "_set_antialias_threshold", args }),
    _set_viewport_interest_area_threshold: (...args: unknown[]) =>
      recorded.push({ name: "_set_viewport_interest_area_threshold", args }),
    _set_max_blocking_time_ms: (...args: unknown[]) =>
      recorded.push({ name: "_set_max_blocking_time_ms", args }),
    _set_node_batch_threshold: (...args: unknown[]) =>
      recorded.push({ name: "_set_node_batch_threshold", args }),
    _set_blur_downscale_threshold: (...args: unknown[]) =>
      recorded.push({ name: "_set_blur_downscale_threshold", args }),
    _free_gpu_resources: () => recorded.push({ name: "_free_gpu_resources", args: [] }),
    _clean_up: () => recorded.push({ name: "_clean_up", args: [] }),
    ...overrides,
  };

  return {
    HEAPU8: new Uint8Array(8),
    HEAPU32: new Uint32Array(2),
    HEAP32: new Int32Array(2),
    HEAPF32: new Float32Array(2),
    UTF8ToString: () => "",
    ...exported,
  };
}

function makeGl(): FakeGl {
  const calls: string[] = [];
  const handles: number[] = [];
  const gl = {
    calls,
    handles,
    registerContext: (_context: WebGLRenderingContext, attributes: { majorVersion: number }) => {
      calls.push(`registerContext:${attributes.majorVersion}`);
      handles.push(7);
      return 7;
    },
    makeContextCurrent: (handle: number | null) => calls.push(`makeContextCurrent:${handle}`),
    deleteContext: (handle: number) => calls.push(`deleteContext:${handle}`),
  };
  return gl;
}

interface FakeCanvas {
  width: number;
  height: number;
  clientWidth?: number;
  clientHeight?: number;
  getContext: (id: string, attributes?: unknown) => WebGLRenderingContext | null;
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  removeEventListener: (type: string, listener: (event: Event) => void) => void;
  listeners: Map<string, (event: Event) => void>;
  lostContext: number;
}

function makeCanvas(options: {
  width?: number;
  height?: number;
  clientWidth?: number;
  clientHeight?: number;
  context?: boolean;
} = {}): FakeCanvas {
  const listeners = new Map<string, (event: Event) => void>();
  const state = { lostContext: 0 };
  const webgl = {
    getExtension: (name: string) =>
      name === "WEBGL_lose_context"
        ? { loseContext: () => (state.lostContext += 1) }
        : {},
  } as unknown as WebGLRenderingContext;

  const canvas = {
    width: options.width ?? 0,
    height: options.height ?? 0,
    clientWidth: options.clientWidth,
    clientHeight: options.clientHeight,
    listeners,
    get lostContext() {
      return state.lostContext;
    },
    getContext: () => (options.context === false ? null : webgl),
    addEventListener: (type: string, listener: (event: Event) => void) => {
      listeners.set(type, listener);
    },
    removeEventListener: (type: string) => {
      listeners.delete(type);
    },
  };

  return canvas as unknown as FakeCanvas;
}

let recorded: Recorded[];

function asCanvas(canvas: FakeCanvas): HTMLCanvasElement {
  return canvas as unknown as HTMLCanvasElement;
}

beforeEach(() => {
  resetModule();
  recorded = [];
});

afterEach(() => {
  resetModule();
});

describe("clampPhysicalSize", () => {
  it("leaves sizes under the surface cap alone", () => {
    expect(clampPhysicalSize(300, 150)).toEqual([300, 150]);
  });

  it("scales the larger axis down to the cap and keeps the aspect", () => {
    expect(clampPhysicalSize(16384, 100)).toEqual([8192, 50]);
    expect(clampPhysicalSize(20000, 20000)).toEqual([8192, 8192]);
  });

  it("never returns a zero dimension", () => {
    expect(clampPhysicalSize(0, 0)).toEqual([1, 1]);
    expect(clampPhysicalSize(-10, 0.4)).toEqual([1, 1]);
  });
});

describe("canvasCssSize", () => {
  it("uses the layout size of a DOM canvas", () => {
    const canvas = makeCanvas({ width: 800, height: 600, clientWidth: 400, clientHeight: 300 });
    expect(canvasCssSize(canvas, 2)).toEqual([400, 300]);
  });

  it("falls back to the physical size for an OffscreenCanvas", () => {
    const canvas = makeCanvas({ width: 800, height: 600 });
    expect(canvasCssSize(canvas, 2)).toEqual([400, 300]);
  });
});

describe("readDpr", () => {
  it("prefers a positive route override", () => {
    expect(readDpr("2", 3)).toBe(2);
    expect(readDpr(2.5, 3)).toBe(2.5);
  });

  it("falls back to the device ratio, then to 1", () => {
    expect(readDpr(undefined, 3)).toBe(3);
    expect(readDpr(0, 3)).toBe(3);
    expect(readDpr(undefined, 0)).toBe(1);
    expect(readDpr(undefined, Number.NaN)).toBe(1);
  });
});

describe("resizeCanvas", () => {
  it("sizes the buffer, the render options and the viewbox from the CSS size", () => {
    const module = makeModule(recorded);
    markContextInitialized();

    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });
    const geometry = resizeCanvas(module, canvas, { dpr: 2, flags: 1 });

    expect(geometry).toEqual({
      dpr: 2,
      cssWidth: 400,
      cssHeight: 300,
      physicalWidth: 800,
      physicalHeight: 600,
    });
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
    expect(recorded).toEqual([
      { name: "_set_render_options", args: [1, 2] },
      { name: "_resize_viewbox", args: [400, 300] },
    ]);
  });

  it("clamps the buffer to the surface cap", () => {
    const module = makeModule(recorded);
    markContextInitialized();

    const canvas = makeCanvas({ clientWidth: 10000, clientHeight: 1000 });
    const geometry = resizeCanvas(module, canvas, { dpr: 1 });

    expect(geometry?.physicalWidth).toBe(8192);
    expect(canvas.width).toBe(8192);
  });

  it("does nothing before the context is live", () => {
    const module = makeModule(recorded);
    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });

    expect(resizeCanvas(module, canvas, { dpr: 2 })).toBeUndefined();
    expect(canvas.width).toBe(0);
    expect(recorded).toEqual([]);
  });
});

describe("resizeOffscreenCanvas", () => {
  it("clamps the buffer but keeps the unclamped viewbox", () => {
    const module = makeModule(recorded);
    markContextInitialized();

    const canvas = makeCanvas({ width: 100, height: 100 });
    expect(resizeOffscreenCanvas(module, canvas, 20000, 100, { dpr: 2 })).toBe(true);

    expect(canvas.width).toBe(8192);
    expect(canvas.height).toBe(40);
    expect(recorded).toEqual([
      { name: "_set_render_options", args: [0, 2] },
      { name: "_resize_viewbox", args: [10000, 50] },
    ]);
  });
});

describe("initCanvasContext", () => {
  it("registers the GL context, initializes the renderer and sizes the canvas", () => {
    const gl = makeGl();
    const module = makeModule(recorded, { GL: gl });
    setModule(module);

    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });
    const session = initCanvasContext(module, asCanvas(canvas), {
      browser: "chrome",
      flags: 8,
      dpr: 2,
      params: { antialias_threshold: "0.5", max_blocking_time_ms: 0 },
    });

    expect(session).toBeDefined();
    expect(currentCanvasContext()).toBe(session);
    expect(gl.calls).toEqual(["registerContext:2", "makeContextCurrent:7"]);
    expect(live()).toBe(true);

    expect(recorded.map((entry) => entry.name)).toEqual([
      "_init",
      "_set_render_options",
      "_set_antialias_threshold",
      "_set_browser",
      "_set_render_options",
      "_resize_viewbox",
    ]);
    expect(recorded[0].args).toEqual([400, 300]);
    expect(recorded[1].args).toEqual([8, 2]);
    expect(recorded[2].args).toEqual([0.5]);
    expect(recorded[3].args).toEqual([1]);
    expect(recorded[5].args).toEqual([400, 300]);
    expect(canvas.width).toBe(800);
    expect(canvas.height).toBe(600);
  });

  it("only syncs the viewbox for an OffscreenCanvas", () => {
    const module = makeModule(recorded, { GL: makeGl() });
    setModule(module);

    const canvas = makeCanvas({ width: 320, height: 200 });
    expect(initCanvasContext(module, asCanvas(canvas), { dpr: 2 })).toBeDefined();

    expect(canvas.width).toBe(320);
    expect(recorded.at(-1)).toEqual({ name: "_resize_viewbox", args: [160, 100] });
  });

  it("refuses to start without a module or a browser context", () => {
    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });
    expect(initCanvasContext(makeModule(recorded), asCanvas(canvas))).toBeUndefined();

    const module = makeModule(recorded, { GL: makeGl() });
    setModule(module);
    const refused = makeCanvas({ clientWidth: 400, clientHeight: 300, context: false });
    expect(initCanvasContext(module, asCanvas(refused))).toBeUndefined();
    expect(recorded).toEqual([]);
  });

  it("marks the context lost on webglcontextlost and reports the event", () => {
    const module = makeModule(recorded, { GL: makeGl() });
    setModule(module);

    const events: string[] = [];
    let prevented = false;
    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });
    initCanvasContext(module, asCanvas(canvas), {
      onContextLost: () => events.push("lost"),
      onContextRestored: () => events.push("restored"),
    });

    const lost = canvas.listeners.get("webglcontextlost");
    expect(lost).toBeDefined();
    lost?.({ preventDefault: () => (prevented = true) } as unknown as Event);

    expect(prevented).toBe(true);
    expect(live()).toBe(false);
    expect(events).toEqual(["lost"]);

    canvas.listeners.get("webglcontextrestored")?.({
      preventDefault: () => undefined,
    } as unknown as Event);
    expect(events).toEqual(["lost", "restored"]);
  });
});

describe("clearCanvas", () => {
  it("releases the GPU objects, the module and the browser context", () => {
    const gl = makeGl();
    const module = makeModule(recorded, { GL: gl });
    setModule(module);
    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });
    initCanvasContext(module, asCanvas(canvas));

    recorded.length = 0;
    expect(clearCanvas(module)).toBe(true);

    expect(recorded.map((entry) => entry.name)).toEqual([
      "_free_gpu_resources",
      "_clean_up",
    ]);
    expect(gl.calls.at(-1)).toBe("deleteContext:7");
    expect(canvas.lostContext).toBe(1);
    expect(canvas.listeners.size).toBe(0);
    expect(live()).toBe(false);
    expect(currentCanvasContext()).toBeUndefined();
  });

  it("keeps the browser context when asked to", () => {
    const module = makeModule(recorded, { GL: makeGl() });
    setModule(module);
    const canvas = makeCanvas({ clientWidth: 400, clientHeight: 300 });
    initCanvasContext(module, asCanvas(canvas));

    expect(clearCanvas(module, { loseBrowserContext: false })).toBe(true);
    expect(canvas.lostContext).toBe(0);
  });

  it("runs the pre-cleanup hook before deleting the context", () => {
    const gl = makeGl();
    const module = makeModule(recorded, { GL: gl });
    setModule(module);
    initCanvasContext(module, asCanvas(makeCanvas({ clientWidth: 10, clientHeight: 10 })));

    const order: string[] = [];
    clearCanvas(module, { onBeforeCleanup: () => order.push("hook") });
    order.push("after");

    expect(order).toEqual(["hook", "after"]);
    expect(gl.calls.at(-1)).toBe("deleteContext:7");
  });

  it("survives a module that can no longer clean up", () => {
    const module = makeModule(recorded, { GL: makeGl() });
    setModule(module);
    initCanvasContext(module, asCanvas(makeCanvas({ clientWidth: 10, clientHeight: 10 })));

    const broken = makeModule(recorded, {
      GL: makeGl(),
      _clean_up: () => {
        throw new Error("module is gone");
      },
    });
    markContextLost(false);

    expect(clearCanvas(broken)).toBe(false);
    expect(live()).toBe(false);
  });
});

describe("freeGpuResources through clearCanvas", () => {
  it("skips the free call when the context was never initialized", () => {
    const module = makeModule(recorded);
    expect(clearCanvas(module)).toBe(true);
    expect(recorded).toEqual([]);
  });
});