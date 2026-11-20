// Unit tests for the worker-side thumbnail render (lib/thumbnail-render.ts).
//
// The engine barrel is mocked: the pass only orchestrates the engine calls
// (init -> initializeViewport -> setObjects -> render -> renderSync -> clear)
// and the view-box math, and the real wasm pass runs in the browser worker.
// The DOM globals the composite needs (OffscreenCanvas, createImageBitmap)
// are stubbed.

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Shape } from "@/lib/render-wasm/engine";
import {
  collectRootBounds,
  computeViewBox,
  decodeThumbnailPage,
  renderThumbnail,
  renderThumbnailFromRaw,
  type ThumbnailObjects,
  type ThumbnailPage,
} from "@/lib/thumbnail-render";

const FRAME_ID = "ce2c7122-e68e-80f8-8008-70ba4384966f";
const CHILD_ID = "11111111-1111-1111-1111-111111111111";
const GROUP_ID = "22222222-2222-2222-2222-222222222222";
const GROUP_CHILD_ID = "33333333-3333-3333-3333-333333333333";
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

interface EngineState {
  calls: Array<{ name: string; args: unknown[] }>;
  initOk: boolean;
  hostAttrs: Array<{ id: string; options: unknown }>;
}

const { state, engineMock } = vi.hoisted(() => {
  const state: EngineState = { calls: [], initOk: true, hostAttrs: [] };
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
      objects: unknown,
      zoom: number,
      vbox: unknown,
      options: { setObjects: (objects: unknown) => void },
    ) => {
      record("initialize-viewport", [objects, zoom, vbox]);
      options.setObjects(objects);
      return true;
    },
    setObjects: (
      _module: unknown,
      objects: Record<string, Shape>,
      options: { onShape?: (shape: Shape) => void; render?: () => void },
    ) => {
      record("set-objects", [objects]);
      for (const shape of Object.values(objects)) options.onShape?.(shape);
      options.render?.();
      return undefined;
    },
    writeHostAttrs: (_module: unknown, shape: Shape, options: unknown) => {
      state.hostAttrs.push({ id: shape.id, options });
      return { thumbnails: [], full: [] };
    },
    updateTextLayout: (_module: unknown, id: string) => record("update-text-layout", [id]),
    renderSyncShape: (_module: unknown, id: string) => record("render-sync-shape", [id]),
    renderSync: () => record("render-sync", []),
    clearCanvas: (_module: unknown, options: unknown) => record("clear-canvas", [options]),
    objectBounds: (_objects: unknown, shape: Shape) =>
      (shape as unknown as { bounds: { x: number; y: number; width: number; height: number } })
        .bounds,
    fontIdToUuid: (fontId: unknown) => String(fontId),
  };

  return { state, engineMock };
});

vi.mock("@/lib/render-wasm/engine", () => engineMock);

afterEach(() => {
  state.calls.length = 0;
  state.hostAttrs.length = 0;
  state.initOk = true;
  vi.unstubAllGlobals();
});

// --- fixtures ---------------------------------------------------------------

function shape(fields: Record<string, unknown>): Shape {
  return fields as unknown as Shape;
}

function objectsFixture(): ThumbnailObjects {
  const objects: Record<string, unknown> = {
    [ZERO_UUID]: shape({ id: ZERO_UUID, type: "root", shapes: [FRAME_ID, GROUP_ID] }),
    [FRAME_ID]: shape({
      id: FRAME_ID,
      type: "frame",
      shapes: [CHILD_ID],
      bounds: { x: 0, y: 0, width: 300, height: 100 },
    }),
    [CHILD_ID]: shape({
      id: CHILD_ID,
      bounds: { x: 10, y: 10, width: 10, height: 10 },
    }),
    [GROUP_ID]: shape({
      id: GROUP_ID,
      type: "group",
      shapes: [GROUP_CHILD_ID],
      bounds: { x: 0, y: 0, width: 50, height: 50 },
    }),
    [GROUP_CHILD_ID]: shape({
      id: GROUP_CHILD_ID,
      bounds: { x: 20, y: 20, width: 20, height: 20 },
    }),
  };
  return objects as unknown as ThumbnailObjects;
}

function pageFixture(options: { frame?: boolean } = {}): ThumbnailPage {
  const page: Record<string, unknown> = {
    objects: objectsFixture(),
    background: "#fafafa",
  };
  page["frame-id"] = (options.frame ?? true) ? FRAME_ID : null;
  return {
    objects: page.objects as ThumbnailObjects,
    frameId: page["frame-id"] as string | null,
    background: page.background as string,
  };
}

function rawFixture(options: { frame?: boolean } = {}): string {
  const page: Record<string, unknown> = {
    objects: objectsFixture(),
    background: "#fafafa",
  };
  if (options.frame ?? true) page["thumbnail-frame-id"] = FRAME_ID;
  return JSON.stringify({ "file-id": "file-1", revn: 7, page });
}

function stubDom() {
  const fillStyles: unknown[] = [];
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
        return new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" });
      }
    },
  );
  const bitmap = { close: vi.fn() };
  vi.stubGlobal("createImageBitmap", vi.fn(async () => bitmap));
  return { fillStyles, bitmap };
}

const module = {} as never;

// --- tests ------------------------------------------------------------------

describe("decodeThumbnailPage", () => {
  it("reads the page objects, the marked frame and the background", () => {
    const page = decodeThumbnailPage(rawFixture());

    expect(page.frameId).toBe(FRAME_ID);
    expect(page.background).toBe("#fafafa");
    expect(page.objects[FRAME_ID]).toBeDefined();
  });

  it("falls back to the canvas color and a null frame", () => {
    const raw = JSON.stringify({
      page: { objects: { [ZERO_UUID]: { id: ZERO_UUID } } },
    });

    const page = decodeThumbnailPage(raw);

    expect(page.frameId).toBeNull();
    expect(page.background).toBe("#E8E9EA");
  });

  it("rejects an answer without a page", () => {
    expect(() => decodeThumbnailPage(JSON.stringify({}))).toThrow(/without a page/);
  });
});

describe("collectRootBounds", () => {
  it("collects frames once, without entering them, and walks groups", () => {
    const bounds = collectRootBounds(objectsFixture());

    // frame + group + group child; the frame's own child is not a root object.
    expect(bounds).toHaveLength(3);
    expect(bounds).toContainEqual({ x: 0, y: 0, width: 300, height: 100 });
    expect(bounds).toContainEqual({ x: 0, y: 0, width: 50, height: 50 });
    expect(bounds).toContainEqual({ x: 20, y: 20, width: 20, height: 20 });
  });

  it("answers no bounds for a page without a root shape", () => {
    expect(collectRootBounds({} as ThumbnailObjects)).toEqual([]);
  });
});

describe("computeViewBox", () => {
  it("uses the marked frame bounds and fixes the 2:3 ratio", () => {
    expect(computeViewBox(pageFixture())).toEqual({ x: 0, y: -50, width: 300, height: 200 });
  });

  it("joins the root bounds when no frame is marked", () => {
    const vbox = computeViewBox(pageFixture({ frame: false }));

    // The union is 300x100 at the origin (the group adds nothing), then the
    // ratio grows the height to 200 around the center.
    expect(vbox).toEqual({ x: 0, y: -50, width: 300, height: 200 });
  });
});

describe("renderThumbnail", () => {
  it("runs the frame pass, composites the background and tears down", async () => {
    const dom = stubDom();
    const page = pageFixture();

    const blob = await renderThumbnail(module, page, 252);

    expect(blob).toBeInstanceOf(Blob);
    expect(state.calls.map((entry) => entry.name)).toEqual([
      "init-canvas-context",
      "initialize-viewport",
      "set-objects",
      "render-sync-shape",
      "clear-canvas",
    ]);

    const canvas = state.calls[0].args[0] as { width: number; height: number };
    expect([canvas.width, canvas.height]).toEqual([252, 168]);

    const viewport = state.calls[1].args;
    expect(viewport[0]).toBe(page.objects);
    expect(viewport[1]).toBeCloseTo(252 / 300);
    expect(viewport[2]).toEqual({ x: 0, y: -50, width: 300, height: 200 });

    expect(state.calls[3].args[0]).toBe(FRAME_ID);

    // The composite paints the page background under the rendered bitmap.
    expect(dom.fillStyles).toEqual(["#fafafa"]);
    expect(dom.bitmap.close).toHaveBeenCalledTimes(1);

    // clear-canvas uses the reference defaults (lose-browser-context? true).
    expect(state.calls[4].args[0]).toBeUndefined();
  });

  it("renders the whole viewport when no frame is marked", async () => {
    stubDom();

    await renderThumbnail(module, pageFixture({ frame: false }), 252);

    expect(state.calls.map((entry) => entry.name)).toContain("render-sync");
    expect(state.calls.map((entry) => entry.name)).not.toContain("render-sync-shape");
  });

  it("writes the host attrs of every shape with the builtin font fallback", async () => {
    stubDom();

    await renderThumbnail(module, pageFixture(), 252);

    expect(state.hostAttrs.map((entry) => entry.id)).toEqual([
      ZERO_UUID,
      FRAME_ID,
      CHILD_ID,
      GROUP_ID,
      GROUP_CHILD_ID,
    ]);
    const options = state.hostAttrs[0].options as {
      text: { writeOptions: { normalizeFontId: (id: string) => string } };
      skipLayout: boolean;
      skipFillsStrokes: boolean;
    };
    expect(options.skipLayout).toBe(true);
    expect(options.skipFillsStrokes).toBe(true);
    expect(options.text.writeOptions.normalizeFontId("sourcesanspro")).toBe("sourcesanspro");
  });

  it("renders a raw RPC answer end to end", async () => {
    stubDom();

    const blob = await renderThumbnailFromRaw(module, rawFixture());

    expect(blob).toBeInstanceOf(Blob);
    expect(state.calls.map((entry) => entry.name)).toContain("render-sync-shape");
  });

  it("fails when the GL context cannot be created", async () => {
    stubDom();
    state.initOk = false;

    await expect(renderThumbnail(module, pageFixture())).rejects.toThrow(/GL context/);
    expect(state.calls.map((entry) => entry.name)).toEqual(["init-canvas-context"]);
  });
});