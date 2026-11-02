// Unit tests for the worker-side thumbnail render (lib/thumbnail-render.ts).
//
// The flow tests drive a fake $APP with the same miniature CLJS runtime the
// values suite uses (values.test.ts): keywords intern as markers, maps are
// JS Maps, and seq/first/next/val walk arrays. The DOM globals the pass
// needs (OffscreenCanvas, createImageBitmap) are stubbed. The real wasm
// end-to-end pass runs in the browser worker, not here.

import { afterEach, describe, expect, it, vi } from "vitest";

import { KEY, call, type RendererApp } from "@/lib/render-wasm/interop";
import {
  collectRootBounds,
  computeViewBox,
  decodeObjectsMap,
  decodeThumbnailPage,
  registerObjectsMapHandler,
  renderThumbnail,
  renderThumbnailFromRaw,
  OBJECTS_MAP_TAG,
  type ThumbnailPage,
} from "@/lib/thumbnail-render";

// --- miniature CLJS runtime ------------------------------------------------

type Kw = { readonly kw: string };

const keywords = new Map<string, Kw>();
function kw(name: string): Kw {
  let k = keywords.get(name);
  if (k === undefined) {
    k = { kw: name };
    keywords.set(name, k);
  }
  return k;
}

// Fixture JSON marks CLJS keywords as "~kw:x"; everything else (uuids, ids,
// numbers) stays as it is. Objects are Maps with revived keys.
function revive(value: unknown): unknown {
  if (typeof value === "string") {
    return value.startsWith("~kw:") ? kw(value.slice(4)) : value;
  }
  if (Array.isArray(value)) return value.map(revive);
  if (value !== null && typeof value === "object") {
    const m = new Map<unknown, unknown>();
    for (const [k, v] of Object.entries(value)) m.set(revive(k), revive(v));
    return m;
  }
  return value;
}

function lookup(map: unknown, name: string): unknown {
  return map instanceof Map ? map.get(kw(name)) : undefined;
}

const FRAME_ID = "ce2c7122-e68e-80f8-8008-70ba4384966f";
const CHILD_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_CHILD_ID = "33333333-3333-3333-3333-333333333333";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

interface FakeApp {
  app: RendererApp;
  calls: Array<{ name: string; args: unknown[] }>;
  handlers: unknown[];
  syncSpy: ReturnType<typeof vi.fn>;
  syncShapeSpy: ReturnType<typeof vi.fn>;
  fillStyles: unknown[];
  blobs: Blob[];
}

function makeFakeApp(options: { initOk?: boolean } = {}): FakeApp {
  const calls: FakeApp["calls"] = [];
  const handlers: unknown[] = [];
  const syncSpy = vi.fn();
  const syncShapeSpy = vi.fn();
  const fillStyles: unknown[] = [];
  const blobs: Blob[] = [];

  class FakePAM {
    constructor(_meta: unknown, cnt: number, arr: unknown[]) {
      if (cnt * 2 !== arr.length) {
        throw new Error(`PersistentArrayMap: cnt ${cnt} does not match ${arr.length} slots`);
      }
      const m = new Map<unknown, unknown>();
      for (let i = 0; i < arr.length; i += 2) m.set(arr[i], arr[i + 1]);
      return m as unknown as FakePAM;
    }
  }

  const app: Record<string, unknown> = {
    [KEY.persistentArrayMap]: FakePAM,
    [KEY.keyword]: (name: unknown) => kw(String(name)),
    [KEY.uuidParse]: (id: unknown) => String(id),
    [KEY.str]: (v: unknown) => String(v),
    [KEY.get]: (coll: unknown, k: unknown) =>
      coll instanceof Map && coll.has(k) ? coll.get(k) : null,
    [KEY.assoc]: (coll: unknown, k: unknown, v: unknown) => {
      const m = new Map(coll instanceof Map ? coll : undefined);
      m.set(k, v);
      return m;
    },
    [KEY.seq]: (coll: unknown) => {
      if (coll instanceof Map) return coll.size > 0 ? Array.from(coll.entries()) : null;
      if (Array.isArray(coll)) return coll.length > 0 ? coll : null;
      return null;
    },
    [KEY.first]: (s: unknown) => (Array.isArray(s) && s.length > 0 ? s[0] : null),
    [KEY.next]: (s: unknown) => (Array.isArray(s) && s.length > 1 ? s.slice(1) : null),
    [KEY.val]: (entry: unknown) => (Array.isArray(entry) ? entry[1] : null),
    [KEY.decodeStr]: (raw: unknown) => revive(JSON.parse(String(raw))),
    [KEY.addHandlers]: (registered: unknown) => {
      handlers.push(...(registered as unknown[]));
    },
    [KEY.frameShapeQmark]: (shape: unknown) => lookup(shape, "frame") === true,
    [KEY.getObjectBounds]: (_objects: unknown, shape: unknown) => lookup(shape, "bounds"),
    [KEY.initCanvasContext]: (canvas: unknown) => {
      calls.push({ name: "init-canvas-context", args: [canvas] });
      return options.initOk ?? true;
    },
    [KEY.initializeViewport]: (...args: unknown[]) => {
      calls.push({ name: "initialize-viewport", args });
      const onRender = lookup(args[3], "on-render") as () => void;
      onRender();
    },
    [KEY.clearCanvas]: (optionsMap: unknown) => {
      calls.push({ name: "clear-canvas", args: [optionsMap] });
    },
    [KEY.internalFrameId]: "stale-frame-handle",
    [KEY.internalModule]: {
      _render_sync: syncSpy,
      _render_sync_shape: syncShapeSpy,
    },
  };

  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      width: number;
      height: number;
      constructor(width: number, height: number) {
        this.width = width;
        this.height = height;
      }
      getContext(kind: string) {
        return kind === "2d"
          ? {
              set fillStyle(value: unknown) {
                fillStyles.push(value);
              },
              fillRect: vi.fn(),
              drawImage: vi.fn(),
            }
          : null;
      }
      async convertToBlob() {
        const blob = new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
        blobs.push(blob);
        return blob;
      }
    },
  );
  const bitmap = { close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));

  return { app, calls, handlers, syncSpy, syncShapeSpy, fillStyles, blobs };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- fixtures ---------------------------------------------------------------

function shape(fields: Record<string, unknown>): unknown {
  return revive(fields);
}

function pageFixture(options: { frame?: boolean } = {}): string {
  const objects: Record<string, unknown> = {
    [ZERO_UUID]: { "~kw:id": ZERO_UUID, "~kw:shapes": [FRAME_ID, GROUP_ID] },
    [FRAME_ID]: {
      "~kw:id": FRAME_ID,
      "~kw:frame": true,
      "~kw:shapes": [CHILD_ID],
      "~kw:bounds": { "~kw:x": 0, "~kw:y": 0, "~kw:width": 300, "~kw:height": 100 },
    },
    [CHILD_ID]: {
      "~kw:id": CHILD_ID,
      "~kw:bounds": { "~kw:x": 10, "~kw:y": 10, "~kw:width": 10, "~kw:height": 10 },
    },
    [GROUP_ID]: {
      "~kw:id": GROUP_ID,
      "~kw:shapes": [GROUP_CHILD_ID],
      "~kw:bounds": { "~kw:x": 0, "~kw:y": 0, "~kw:width": 50, "~kw:height": 50 },
    },
    [GROUP_CHILD_ID]: {
      "~kw:id": GROUP_CHILD_ID,
      "~kw:bounds": { "~kw:x": 20, "~kw:y": 20, "~kw:width": 20, "~kw:height": 20 },
    },
  };
  const page: Record<string, unknown> = {
    "~kw:id": "page-1",
    "~kw:background": "#fafafa",
    "~kw:objects": objects,
  };
  if (options.frame ?? true) page["~kw:thumbnail-frame-id"] = FRAME_ID;
  return JSON.stringify({ "~kw:file-id": "file-1", "~kw:revn": 7, "~kw:page": page });
}

// --- tests ------------------------------------------------------------------

describe("decodeObjectsMap / registerObjectsMapHandler", () => {
  it("decodes every uuid -> encoded shape string eagerly", () => {
    const fake = makeFakeApp();
    const rep = new Map<unknown, unknown>([
      [FRAME_ID, JSON.stringify({ "~kw:id": FRAME_ID, "~kw:frame": true })],
    ]);

    const decoded = decodeObjectsMap(fake.app, rep) as Map<unknown, unknown>;

    expect(decoded.get(FRAME_ID)).toEqual(
      new Map<unknown, unknown>([
        [kw("id"), FRAME_ID],
        [kw("frame"), true],
      ]),
    );
  });

  it("registers a real CLJS handler map under penpot/objects-map/v2", () => {
    const fake = makeFakeApp();

    registerObjectsMapHandler(fake.app);

    expect(fake.handlers).toHaveLength(1);
    const handler = fake.handlers[0] as Map<unknown, unknown>;
    expect(handler.get(kw("id"))).toBe(OBJECTS_MAP_TAG);
    const rfn = handler.get(kw("rfn")) as (rep: unknown) => unknown;
    const decoded = rfn(new Map([[FRAME_ID, JSON.stringify({ "~kw:id": FRAME_ID })]]));
    expect((decoded as Map<unknown, unknown>).get(FRAME_ID)).toEqual(
      new Map<unknown, unknown>([[kw("id"), FRAME_ID]]),
    );
  });
});

describe("decodeThumbnailPage", () => {
  it("reads the page objects, the marked frame and the background", () => {
    const fake = makeFakeApp();

    const page = decodeThumbnailPage(fake.app, pageFixture());

    expect(page.frameId).toBe(FRAME_ID);
    expect(page.background).toBe("#fafafa");
    expect((page.objects as Map<unknown, unknown>).get(FRAME_ID)).toBeDefined();
  });

  it("falls back to the canvas color and a null frame", () => {
    const fake = makeFakeApp();
    const raw = JSON.stringify({
      "~kw:page": { "~kw:objects": { [ZERO_UUID]: { "~kw:id": ZERO_UUID } } },
    });

    const page = decodeThumbnailPage(fake.app, raw);

    expect(page.frameId).toBeNull();
    expect(page.background).toBe("#E8E9EA");
  });
});

describe("collectRootBounds", () => {
  it("collects frames once, without entering them, and walks groups", () => {
    const fake = makeFakeApp();
    const page = decodeThumbnailPage(fake.app, pageFixture());

    const bounds = collectRootBounds(fake.app, page.objects);

    // frame + group + group child; the frame's own child is not a root object.
    expect(bounds).toHaveLength(3);
    expect(bounds).toContainEqual({ x: 0, y: 0, width: 300, height: 100 });
    expect(bounds).toContainEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(bounds).toContainEqual({ x: 20, y: 20, width: 20, height: 20 });
  });

  it("answers no bounds for a page without a root shape", () => {
    const fake = makeFakeApp();
    expect(collectRootBounds(fake.app, new Map())).toEqual([]);
  });
});

describe("computeViewBox", () => {
  it("uses the marked frame bounds and fixes the 2:3 ratio", () => {
    const fake = makeFakeApp();
    const page = decodeThumbnailPage(fake.app, pageFixture());

    expect(computeViewBox(fake.app, page)).toEqual({ x: 0, y: -50, width: 300, height: 200 });
  });

  it("joins the root bounds when no frame is marked", () => {
    const fake = makeFakeApp();
    const page = decodeThumbnailPage(fake.app, pageFixture({ frame: false }));

    const vbox = computeViewBox(fake.app, page);

    // The union is 300x100 at the origin (the group adds nothing), then the
    // ratio grows the height to 200 around the center.
    expect(vbox).toEqual({ x: 0, y: -50, width: 300, height: 200 });
  });
});

describe("renderThumbnail", () => {
  it("runs the frame pass, composites the background and tears down", async () => {
    const fake = makeFakeApp();
    const page = decodeThumbnailPage(fake.app, pageFixture());

    const blob = await renderThumbnail(fake.app, page, 252);

    expect(blob).toBeInstanceOf(Blob);
    expect(fake.calls.map((entry) => entry.name)).toEqual([
      "init-canvas-context",
      "initialize-viewport",
      "clear-canvas",
    ]);

    const canvas = fake.calls[0].args[0] as { width: number; height: number };
    expect([canvas.width, canvas.height]).toEqual([252, 168]);

    const viewport = fake.calls[1].args;
    expect(viewport[0]).toBe(page.objects);
    expect(viewport[1]).toBeCloseTo(252 / 300);
    expect(lookup(viewport[2], "x")).toBe(0);
    expect(lookup(viewport[2], "y")).toBe(-50);
    expect(lookup(viewport[3], "background")).toBe("#fafafa");
    expect(lookup(viewport[3], "force-sync")).toBe(true);

    // render-sync-shape got the frame's four big-endian u32 words.
    expect(fake.syncShapeSpy).toHaveBeenCalledWith(
      0xce2c7122, 0xe68e80f8, 0x800870ba, 0x4384966f,
    );
    expect(fake.syncSpy).not.toHaveBeenCalled();
    expect(fake.app[KEY.internalFrameId]).toBeNull();

    // The composite paints the page background under the rendered bitmap.
    expect(fake.fillStyles).toEqual(["#fafafa"]);

    // clear-canvas uses the reference defaults: an empty options map.
    const options = fake.calls[2].args[0] as Map<unknown, unknown>;
    expect(options.size).toBe(0);
  });

  it("renders the whole viewport when no frame is marked", async () => {
    const fake = makeFakeApp();
    const page: ThumbnailPage = decodeThumbnailPage(fake.app, pageFixture({ frame: false }));

    await renderThumbnail(fake.app, page, 252);

    expect(fake.syncSpy).toHaveBeenCalledTimes(1);
    expect(fake.syncShapeSpy).not.toHaveBeenCalled();
  });

  it("renders a raw RPC answer end to end", async () => {
    const fake = makeFakeApp();

    const blob = await renderThumbnailFromRaw(fake.app, pageFixture());

    expect(blob).toBeInstanceOf(Blob);
    expect(fake.blobs).toHaveLength(2);
  });

  it("fails when the GL context cannot be created", async () => {
    const fake = makeFakeApp({ initOk: false });
    const page = decodeThumbnailPage(fake.app, pageFixture());

    await expect(renderThumbnail(fake.app, page)).rejects.toThrow(/GL context/);
    expect(fake.syncShapeSpy).not.toHaveBeenCalled();
    expect(fake.calls.map((entry) => entry.name)).toEqual(["init-canvas-context"]);
  });
});

// The helper call() is exercised through registerObjectsMapHandler above; a
// direct check keeps the variadic contract (rest as an array) explicit.
describe("add-handlers contract", () => {
  it("passes the handler as a one-element array", () => {
    const seen: unknown[] = [];
    const app: RendererApp = {
      [KEY.addHandlers]: (handlers: unknown) => seen.push(handlers),
    };

    call(app, KEY.addHandlers, ["handler"]);

    expect(seen).toEqual([["handler"]]);
  });
});

// collectRootBounds reads :shapes through the fake map above; this guard
// keeps the shape fixture honest when someone edits it.
describe("shape fixture", () => {
  it("keeps frames and groups distinguishable", () => {
    expect(lookup(shape({ "~kw:frame": true }), "frame")).toBe(true);
    expect(lookup(shape({}), "frame")).toBeUndefined();
  });
});