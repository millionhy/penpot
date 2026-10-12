// Unit tests for the one-shot frame render (lib/render-wasm/frame-render.ts).
//
// The flow tests drive a fake $APP: every primitive records its call, the
// fake initialize-viewport hands back the on-render callback the pass
// registered (like set-objects-sync does on process-pending completion),
// and the DOM globals the blit needs (OffscreenCanvas, createImageBitmap,
// requestAnimationFrame) are stubbed. The real wasm end-to-end pass runs
// under headless Chrome (see .git/f64r6-verify.mjs), not here.

import { afterEach, describe, expect, it, vi } from "vitest";
import { renderFrameToCanvas, uuidToU32 } from "@/lib/render-wasm/frame-render";
import { KEY } from "@/lib/render-wasm/interop";

const FRAME_ID = "ce2c7122-e68e-80f8-8008-70ba4384966f";

describe("uuidToU32", () => {
  it("reads the uuid string as four big-endian u32 words", () => {
    expect(uuidToU32("d8cf69c1-e3c8-8159-8008-6f934d0e82aa")).toEqual([
      0xd8cf69c1, 0xe3c88159, 0x80086f93, 0x4d0e82aa,
    ]);
  });

  it("keeps the high bit unsigned (no int32 wrap)", () => {
    expect(uuidToU32("ffffffff-ffff-ffff-ffff-ffffffffffff")).toEqual([
      4294967295, 4294967295, 4294967295, 4294967295,
    ]);
  });

  it("maps the zero uuid to four zeros", () => {
    expect(uuidToU32("00000000-0000-0000-0000-000000000000")).toEqual([0, 0, 0, 0]);
  });
});

// --- fake $APP --------------------------------------------------------------

interface FakeAppOptions {
  initOk?: boolean;
  // autoFire: trigger the registered on-render synchronously, like
  // set-objects-sync's process-pending completion callback. When false the
  // callbacks queue on pendingOnRenders for manual control.
  autoFire?: boolean;
}

function lookupOption(pam: unknown, name: string): unknown {
  const arr = (pam as { arr: unknown[] }).arr;
  for (let i = 0; i < arr.length; i += 2) {
    if ((arr[i] as { kw?: string })?.kw === name) return arr[i + 1];
  }
  return undefined;
}

function makeFakeApp({ initOk = true, autoFire = true }: FakeAppOptions = {}) {
  const calls: Array<{ name: string; args: unknown[] }> = [];
  const pendingOnRenders: Array<() => void> = [];
  const internalSyncShape = vi.fn();

  // The shape arrayMap() builds; the keyword fn returns plain markers the
  // lookupOption helper understands.
  class FakePAM {
    arr: unknown[];
    constructor(_meta: unknown, _cnt: number, arr: unknown[]) {
      this.arr = arr;
    }
  }

  const app: Record<string, unknown> = {
    [KEY.persistentArrayMap]: FakePAM,
    [KEY.keyword]: (name: string) => ({ kw: name }),
    [KEY.internalModule]: { _render_sync_shape: internalSyncShape },
    [KEY.internalFrameId]: "stale-frame-handle",
    [KEY.initCanvasContext]: (osCanvas: unknown) => {
      calls.push({ name: "init-canvas-context", args: [osCanvas] });
      return initOk;
    },
    [KEY.initializeViewport]: (...args: unknown[]) => {
      calls.push({ name: "initialize-viewport", args });
      const onRender = lookupOption(args[3], "on-render") as () => void;
      if (autoFire) onRender();
      else pendingOnRenders.push(onRender);
    },
    [KEY.setRulersFrameVisible]: (value: unknown) => {
      calls.push({ name: "set-rulers-frame-visible", args: [value] });
    },
    [KEY.setRulersVisible]: (value: unknown) => {
      calls.push({ name: "set-rulers-visible", args: [value] });
    },
    [KEY.clearCanvas]: (options: unknown) => {
      calls.push({ name: "clear-canvas", args: [options] });
    },
  };

  return { app, calls, pendingOnRenders, internalSyncShape };
}

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

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- the pass ---------------------------------------------------------------

describe("renderFrameToCanvas", () => {
  it("runs the one-shot pass and blits the bitmap", async () => {
    const dom = stubDom();
    const fake = makeFakeApp();

    await renderFrameToCanvas(fake.app, { "objects-map": true }, FRAME_ID, dom.canvas, { x: 10, y: 20 }, 2);

    // The compiled order: init (offscreen) → initialize-viewport, then the
    // on-render work (rulers off, sync shape, blit, clear).
    expect(fake.calls.map((call) => call.name)).toEqual([
      "init-canvas-context",
      "initialize-viewport",
      "set-rulers-frame-visible",
      "set-rulers-visible",
      "clear-canvas",
    ]);

    // The offscreen canvas carries the physical size of the target canvas.
    const osCanvas = fake.calls[0].args[0] as { width: number; height: number };
    expect([osCanvas.width, osCanvas.height]).toEqual([168, 264]);

    // initialize-viewport(objects, scale, bounds, opts).
    const viewport = fake.calls[1].args;
    expect(viewport[0]).toEqual({ "objects-map": true });
    expect(viewport[1]).toBe(2);
    expect(lookupOption(viewport[2], "x")).toBe(10);
    expect(lookupOption(viewport[2], "y")).toBe(20);
    expect(lookupOption(viewport[3], "background-opacity")).toBe(0);
    expect(lookupOption(viewport[3], "force-sync")).toBe(true);

    // The final render: the frame id as wasm u32 words, handle cleared.
    expect(fake.internalSyncShape).toHaveBeenCalledWith(
      0xce2c7122, 0xe68e80f8, 0x800870ba, 0x4384966f,
    );
    expect(fake.app[KEY.internalFrameId]).toBeNull();

    // The blit reads the offscreen canvas and paints the target canvas.
    expect(dom.ctx.clearRect).toHaveBeenCalledWith(0, 0, 168, 264);
    expect(dom.ctx.drawImage).toHaveBeenCalledWith(dom.bitmap, 0, 0, 168, 264);
    expect(dom.bitmap.close).toHaveBeenCalled();
    expect(dom.canvas.id).toBe(`screenshot-${FRAME_ID}`);

    // clear-canvas hands the shared context back (lose-browser-context? false).
    expect(lookupOption(fake.calls[4].args[0], "lose-browser-context?")).toBe(false);
  });

  it("fails when the GL context cannot be created", async () => {
    const dom = stubDom();
    const fake = makeFakeApp({ initOk: false });

    await expect(
      renderFrameToCanvas(fake.app, {}, FRAME_ID, dom.canvas, { x: 0, y: 0 }, 1),
    ).rejects.toThrow(/GL context/);
    expect(fake.internalSyncShape).not.toHaveBeenCalled();
  });

  it("serializes concurrent renders through the queue", async () => {
    const dom = stubDom();
    const fake = makeFakeApp({ autoFire: false });

    const first = renderFrameToCanvas(
      fake.app, {}, "11111111-1111-1111-1111-111111111111", dom.canvas, { x: 0, y: 0 }, 1,
    );
    const second = renderFrameToCanvas(
      fake.app, {}, "22222222-2222-2222-2222-222222222222", dom.canvas, { x: 0, y: 0 }, 1,
    );

    await flush();
    // Only the first render started; the second waits on the queue.
    expect(fake.calls.filter((c) => c.name === "init-canvas-context")).toHaveLength(1);

    fake.pendingOnRenders.shift()?.();
    await first;
    await flush();
    // The second may start only now that the first finished.
    expect(fake.calls.filter((c) => c.name === "init-canvas-context")).toHaveLength(2);

    fake.pendingOnRenders.shift()?.();
    await second;
    expect(fake.internalSyncShape).toHaveBeenCalledTimes(2);
  });
});
