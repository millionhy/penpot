// app.wasm.render: the headless scene pipeline. The transport, the temp files
// and the wasm driver are injected or mocked, so these exercise the ordering,
// the wire format and the degradation paths without a backend or a worker.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config.js", () => ({
  get: (key: string, fallback?: unknown) =>
    key === "public-uri" ? "http://penpot.test" : fallback,
  getInternalUri: () => "http://backend:6060/",
  managementKey: () => "secret",
}));

vi.mock("../wasm.js", () => ({
  init: vi.fn(async () => ({ HEAPU8: new Uint8Array(), HEAPU32: new Uint32Array() })),
  reset: vi.fn(),
  clearFonts: vi.fn(),
  provisionFonts: vi.fn(async () => undefined),
  storeFont: vi.fn(),
  storeImage: vi.fn(),
  storeImageUrl: vi.fn(),
  imageCached: vi.fn(() => false),
  updateTextLayout: vi.fn(),
  renderShapeRaster: vi.fn(() => new Uint8Array([1, 2, 3])),
  renderShapePdf: vi.fn(() => new Uint8Array([4, 5])),
  renderShapeSvg: vi.fn(() => new Uint8Array([6, 7])),
  evictImages: vi.fn(() => 0),
  imageCacheSize: 1024,
}));

vi.mock("./serialize.js", () => ({ serializeScene: vi.fn() }));

vi.mock("./serializers.js", () => ({ translateRasterFormat: vi.fn(() => 7) }));

import type { RenderObject } from "../renderer.js";
import * as transit from "../transit.js";
import * as uuid from "../uuid.js";
import * as wasm from "../wasm.js";
import type { Shape } from "./upload.js";
import {
  clearFontCache,
  render,
  sceneFallbackFonts,
  setDeps,
  setModuleLoader,
  type FetchFn,
  type FetchInit,
  type FetchResponseLike,
  type HeadlessParams,
} from "./render.js";
import { serializeScene } from "./serialize.js";
import { translateRasterFormat } from "./serializers.js";

const FILE_ID = "11111111-1111-1111-1111-111111111111";
const PAGE_ID = "22222222-2222-2222-2222-222222222222";
const SHAPE_ID = "33333333-3333-3333-3333-333333333333";
const IMAGE_ID = "44444444-4444-4444-4444-444444444444";
const CUSTOM_FONT_ID = "55555555-5555-5555-5555-555555555555";
const TTF_FILE_ID = "66666666-6666-6666-6666-666666666666";

function reply(status: number, body: string): FetchResponseLike {
  const bytes = new TextEncoder().encode(body);
  return {
    status,
    text: async () => body,
    arrayBuffer: async () => bytes.slice().buffer,
  };
}

interface Call {
  uri: string;
  init: FetchInit;
}

interface BackendOptions {
  "font-variants"?: number;
  "font-variants-body"?: unknown;
}

function backend(
  scene: Record<string, Shape> = {},
  options: BackendOptions = {},
): { calls: Call[]; fetchFn: FetchFn } {
  const calls: Call[] = [];

  const fetchFn: FetchFn = async (uri, init) => {
    calls.push({ uri, init });

    if (uri.endsWith("/api/rpc/command/get-page")) {
      return reply(200, transit.encode({ objects: scene }));
    }
    if (uri.endsWith("/api/rpc/command/get-font-variants")) {
      const status = options["font-variants"] ?? 200;
      if (status !== 200) return reply(status, "boom");
      return reply(200, transit.encode(options["font-variants-body"] ?? []));
    }
    if (uri.includes("/assets/by-file-media-id/")) return reply(200, "image");
    if (uri.includes("/assets/by-id/")) return reply(200, "ttf");
    if (uri.includes("/fonts/")) return reply(200, "ttf");
    if (uri.includes("/internal/gfonts/font")) return reply(200, "ttf");

    return reply(404, "not found");
  };

  return { calls, fetchFn };
}

interface Output {
  path: string;
  bytes: Uint8Array;
}

function inject(fetchFn: FetchFn): Output[] {
  const outputs: Output[] = [];

  setDeps({
    fetch: fetchFn,
    tempfile: () => `tmp/out-${outputs.length}.bin`,
    writeFile: (path, bytes) => {
      outputs.push({ path, bytes });
    },
  });

  return outputs;
}

function object(id = SHAPE_ID, filename = "rect.png"): RenderObject {
  return { id, name: "Rect", suffix: "", filename };
}

function params(overrides: Partial<HeadlessParams> = {}): HeadlessParams {
  return {
    "file-id": FILE_ID,
    "page-id": PAGE_ID,
    "type": "png",
    scale: 2,
    token: "tok",
    objects: [object()],
    ...overrides,
  };
}

function shapes(entries: Record<string, Partial<Shape>>): Record<string, Shape> {
  return entries as Record<string, Shape>;
}

beforeEach(() => {
  clearFontCache();
  setModuleLoader();
  setDeps();

  vi.mocked(wasm.init).mockClear().mockResolvedValue({
    HEAPU8: new Uint8Array(),
    HEAPU32: new Uint32Array(),
  });
  vi.mocked(wasm.reset).mockClear();
  vi.mocked(wasm.clearFonts).mockClear();
  vi.mocked(wasm.provisionFonts).mockClear().mockResolvedValue(undefined);
  vi.mocked(wasm.storeFont).mockClear();
  vi.mocked(wasm.storeImage).mockClear();
  vi.mocked(wasm.storeImageUrl).mockClear();
  vi.mocked(wasm.imageCached).mockClear().mockReturnValue(false);
  vi.mocked(wasm.updateTextLayout).mockClear();
  vi.mocked(wasm.renderShapeRaster).mockClear().mockReturnValue(new Uint8Array([1, 2, 3]));
  vi.mocked(wasm.renderShapePdf).mockClear().mockReturnValue(new Uint8Array([4, 5]));
  vi.mocked(wasm.renderShapeSvg).mockClear().mockReturnValue(new Uint8Array([6, 7]));
  vi.mocked(wasm.evictImages).mockClear().mockReturnValue(0);
  vi.mocked(serializeScene).mockClear();
  vi.mocked(translateRasterFormat).mockClear().mockReturnValue(7);
});

afterEach(() => {
  clearFontCache();
  setModuleLoader();
  setDeps();
});

describe("scene fetch", () => {
  it("posts the get-page RPC with keyword keys and a uuid set", async () => {
    const { calls, fetchFn } = backend();
    inject(fetchFn);

    await render(params(), () => undefined);

    const page = calls.find((call) => call.uri.endsWith("/api/rpc/command/get-page"));
    expect(page).toBeDefined();
    expect(page?.uri).toBe("http://backend:6060/api/rpc/command/get-page");
    expect(page?.init.method).toBe("POST");
    expect(page?.init.headers).toEqual({
      "Content-Type": "application/transit+json",
      "X-Shared-Key": "exporter secret",
      Authorization: "Bearer tok",
    });

    expect(transit.decode(String(page?.init.body))).toEqual({
      "file-id": FILE_ID,
      "page-id": PAGE_ID,
      "object-id": [SHAPE_ID],
    });
  });

  it("sends the share id only when the params carry one", async () => {
    const { calls, fetchFn } = backend();
    inject(fetchFn);

    const shareId = "77777777-7777-7777-7777-777777777777";
    await render(params({ "share-id": shareId }), () => undefined);

    const page = calls.find((call) => call.uri.endsWith("/api/rpc/command/get-page"));
    expect(transit.decode(String(page?.init.body))).toMatchObject({ "share-id": shareId });
  });

  it("fails the export when get-page answers non-200", async () => {
    const fetchFn: FetchFn = async () => reply(500, "boom");
    inject(fetchFn);

    await expect(render(params(), () => undefined)).rejects.toThrow("get-page failed");
    expect(wasm.reset).toHaveBeenCalledTimes(1);
  });
});

describe("pipeline order", () => {
  it("serializes, provisions fonts, relayouts and only then renders", async () => {
    const order: string[] = [];
    const { fetchFn } = backend(shapes({ [SHAPE_ID]: { id: SHAPE_ID, type: "text" } }));
    const outputs = inject(fetchFn);

    vi.mocked(wasm.init).mockImplementation(async () => {
      order.push("init");
      return { HEAPU8: new Uint8Array(), HEAPU32: new Uint32Array() };
    });
    vi.mocked(serializeScene).mockImplementation(() => {
      order.push("serialize");
    });
    vi.mocked(wasm.clearFonts).mockImplementation(() => {
      order.push("clearFonts");
    });
    vi.mocked(wasm.provisionFonts).mockImplementation(async () => {
      order.push("provisionFonts");
    });
    vi.mocked(wasm.updateTextLayout).mockImplementation(() => {
      order.push("relayout");
    });
    vi.mocked(wasm.renderShapeRaster).mockImplementation(() => {
      order.push("render");
      return new Uint8Array([1]);
    });
    vi.mocked(wasm.evictImages).mockImplementation(() => {
      order.push("evict");
      return 0;
    });

    const onObject = vi.fn((object: RenderObject) => {
      order.push("object");
      expect(object.path).toBe(outputs[0].path);
    });

    await render(params(), onObject);

    expect(order).toEqual([
      "init",
      "serialize",
      "clearFonts",
      "provisionFonts",
      "relayout",
      "render",
      "object",
      "evict",
    ]);
  });

  it("writes each object and reports it with the temp path", async () => {
    const { fetchFn } = backend();
    const outputs = inject(fetchFn);
    const onObject = vi.fn();

    await render(params(), onObject);

    expect(outputs).toHaveLength(1);
    expect(onObject).toHaveBeenCalledWith({ ...object(), path: "tmp/out-0.bin" });
  });
});

describe("output format", () => {
  it("renders png through the raster call", async () => {
    const { fetchFn } = backend();
    const outputs = inject(fetchFn);

    await render(params({ type: "png" }), () => undefined);

    expect(wasm.renderShapeRaster).toHaveBeenCalledWith(SHAPE_ID, 2, 7);
    expect(translateRasterFormat).toHaveBeenCalledWith("png");
    expect(outputs[0].bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("renders pdf through the pdf call", async () => {
    const { fetchFn } = backend();
    const outputs = inject(fetchFn);

    await render(params({ type: "pdf" }), () => undefined);

    expect(wasm.renderShapePdf).toHaveBeenCalledWith(SHAPE_ID, 2);
    expect(wasm.renderShapeRaster).not.toHaveBeenCalled();
    expect(outputs[0].bytes).toEqual(new Uint8Array([4, 5]));
  });

  it("renders svg through the svg call", async () => {
    const { fetchFn } = backend();
    const outputs = inject(fetchFn);

    await render(params({ type: "svg" }), () => undefined);

    expect(wasm.renderShapeSvg).toHaveBeenCalledWith(SHAPE_ID, 2);
    expect(wasm.renderShapeRaster).not.toHaveBeenCalled();
    expect(outputs[0].bytes).toEqual(new Uint8Array([6, 7]));
  });
});

describe("fonts", () => {
  it("resolves the builtin family through the bundled ttf", async () => {
    const { calls, fetchFn } = backend();
    inject(fetchFn);

    let resolved: Uint8Array | ArrayBuffer | null | undefined;
    vi.mocked(wasm.provisionFonts).mockImplementation(async (_ids, resolveFont) => {
      resolved = await resolveFont({ id: uuid.getU32(uuid.zero), weight: 400, style: 0 });
    });

    await render(params(), () => undefined);

    const font = calls.find((call) => call.uri.endsWith("/fonts/sourcesanspro-regular.ttf"));
    expect(font).toBeDefined();
    expect(font?.init).toEqual({ method: "GET" });
    expect(resolved).toBeInstanceOf(Uint8Array);
  });

  it("reads a custom variant through the asset endpoint with a cookie", async () => {
    const { calls, fetchFn } = backend({}, {
      "font-variants-body": [
        {
          "font-id": CUSTOM_FONT_ID,
          "font-weight": 600,
          "font-style": "italic",
          "ttf-file-id": TTF_FILE_ID,
        },
      ],
    });
    inject(fetchFn);

    vi.mocked(wasm.provisionFonts).mockImplementation(async (_ids, resolveFont) => {
      await resolveFont({ id: uuid.getU32(CUSTOM_FONT_ID), weight: 600, style: 1 });
    });

    await render(params(), () => undefined);

    const asset = calls.find((call) => call.uri.endsWith(`/assets/by-id/${TTF_FILE_ID}`));
    expect(asset?.init).toEqual({
      method: "GET",
      headers: { "X-Shared-Key": "exporter secret", Cookie: "auth-token=tok" },
    });
  });

  it("degrades to fallbacks when the variants endpoint fails", async () => {
    const { fetchFn } = backend({}, { "font-variants": 500 });
    const outputs = inject(fetchFn);

    await render(params(), () => undefined);

    expect(outputs).toHaveLength(1);
    expect(wasm.provisionFonts).toHaveBeenCalled();
  });

  it("derives emoji and per-script fallback fonts from the text", () => {
    const fonts = sceneFallbackFonts(
      shapes({
        [SHAPE_ID]: {
          type: "text",
          content: { text: "hello \u{1F600} \u3053\u3093\u306B\u3061\u306F" },
        },
      }),
    );
    const ids = fonts.map((font) => font["font-id"]);

    expect(ids).toContain("gfont-noto-color-emoji");
    expect(ids).toContain("gfont-noto-sans-jp");
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("skips fallback families when the scene has no text", () => {
    expect(sceneFallbackFonts(shapes({ [SHAPE_ID]: { type: "rect" } }))).toEqual([]);
  });
});

describe("images", () => {
  const scene = shapes({
    [SHAPE_ID]: { type: "rect", fills: [{ "fill-image": { id: IMAGE_ID } }] },
  });

  it("downloads and stores the images the scene references", async () => {
    const { calls, fetchFn } = backend(scene);
    inject(fetchFn);

    await render(params(), () => undefined);

    const media = calls.find((call) => call.uri.endsWith(`/assets/by-file-media-id/${IMAGE_ID}`));
    expect(media?.init).toEqual({
      method: "GET",
      headers: { "X-Shared-Key": "exporter secret", Cookie: "auth-token=tok" },
    });
    expect(wasm.storeImage).toHaveBeenCalledWith(IMAGE_ID, expect.any(Uint8Array));
    expect(wasm.storeImageUrl).toHaveBeenCalledWith(
      IMAGE_ID,
      `http://penpot.test/assets/by-file-media-id/${IMAGE_ID}`,
    );
  });

  it("skips a cached image but still registers its public url", async () => {
    const { calls, fetchFn } = backend(scene);
    inject(fetchFn);
    vi.mocked(wasm.imageCached).mockReturnValue(true);

    await render(params(), () => undefined);

    expect(calls.some((call) => call.uri.includes("/assets/by-file-media-id/"))).toBe(false);
    expect(wasm.storeImage).not.toHaveBeenCalled();
    expect(wasm.storeImageUrl).toHaveBeenCalledWith(
      IMAGE_ID,
      `http://penpot.test/assets/by-file-media-id/${IMAGE_ID}`,
    );
  });

  it("keeps rendering when the image cannot be fetched", async () => {
    const fetchFn: FetchFn = async (uri, init) => {
      if (uri.endsWith("/api/rpc/command/get-page")) {
        return reply(200, transit.encode({ objects: scene }));
      }
      if (uri.includes("/assets/by-file-media-id/")) return reply(404, "gone");
      return reply(200, transit.encode([]));
    };
    const outputs = inject(fetchFn);

    await render(params(), () => undefined);

    expect(outputs).toHaveLength(1);
    expect(wasm.storeImage).not.toHaveBeenCalled();
  });
});

describe("cancellation", () => {
  it("stops between objects and reports job-cancelled", async () => {
    const { fetchFn } = backend();
    inject(fetchFn);

    let calls = 0;
    const cancelled = () => {
      calls += 1;
      return calls > 1;
    };

    await expect(
      render(params({ objects: [object(), object()], "cancelled?": cancelled }), () => undefined),
    ).rejects.toMatchObject({ data: { code: "job-cancelled" } });

    expect(wasm.renderShapeRaster).toHaveBeenCalledTimes(1);
    expect(wasm.reset).toHaveBeenCalledTimes(1);
  });
});

describe("module lifecycle", () => {
  it("drops the module after a failure so the next request rebuilds it", async () => {
    let fail = true;
    const fetchFn: FetchFn = async () => (fail ? reply(500, "boom") : reply(200, transit.encode({ objects: {} })));

    setDeps({ fetch: fetchFn, tempfile: () => "tmp/out.bin", writeFile: () => undefined });

    await expect(render(params(), () => undefined)).rejects.toThrow("get-page failed");

    fail = false;
    await render(params(), () => undefined);

    expect(wasm.init).toHaveBeenCalledTimes(2);
  });
});
