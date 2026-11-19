import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markContextInitialized,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  IMAGE_HEADER_U8_SIZE,
  isImageCached,
  loadImage,
  loadShapeImages,
  loadTextImages,
  shapeImageIds,
  storeImage,
  storeImageUrl,
  textImageIds,
} from "./image";
import type { Shape } from "./upload";
import { uuidToU32 } from "./uuid";

interface Recorded {
  name: string;
  args: unknown[];
}

const SHAPE = "12345678-9abc-def0-1122-334455667788";
const IMAGE = "aaaaaaaa-0000-0000-0000-000000000001";
const OTHER = "bbbbbbbb-0000-0000-0000-000000000002";

function makeModule(recorded: Recorded[], cached = false): RenderWasmModule {
  const heap = new Uint8Array(1 << 16);
  let next = 8;

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
    _store_image: (...args: unknown[]) => {
      recorded.push({ name: "_store_image", args });
      return 0;
    },
    _store_image_url: (...args: unknown[]) => {
      recorded.push({ name: "_store_image_url", args });
      return 0;
    },
    _is_image_cached: (...args: unknown[]) => {
      recorded.push({ name: "_is_image_cached", args });
      return cached ? 1 : 0;
    },
  };
}

let recorded: Recorded[];
let module: RenderWasmModule;

function boot(cached = false): void {
  resetModule();
  recorded = [];
  module = makeModule(recorded, cached);
  setModule(module);
  markContextInitialized();
}

beforeEach(() => {
  boot();
});

afterEach(() => {
  resetModule();
  vi.restoreAllMocks();
});

function shape(overrides: Partial<Shape> = {}): Shape {
  return { id: SHAPE, type: "rect", ...overrides };
}

describe("shapeImageIds", () => {
  it("reads the fills, then the visible strokes only", () => {
    const ids = shapeImageIds(
      shape({
        fills: [{ "fill-image": { id: IMAGE } }, { "fill-color": "#fff" }],
        strokes: [
          { "stroke-image": { id: OTHER } },
          { "stroke-image": { id: IMAGE }, hidden: true },
        ],
      }),
    );
    expect(ids).toEqual([IMAGE, OTHER]);
  });

  it("ignores the strokes of a group", () => {
    expect(
      shapeImageIds(shape({ type: "group", strokes: [{ "stroke-image": { id: IMAGE } }] })),
    ).toEqual([]);
  });
});

describe("textImageIds", () => {
  it("reads the span fills of every paragraph in the first set", () => {
    const content = {
      children: [
        {
          children: [
            { children: [{ fills: [{ "fill-image": { id: IMAGE } }] }, { text: "x" }] },
            { children: [{ fills: [{ "fill-image": { id: OTHER } }] }] },
          ],
        },
        { children: [{ children: [{ fills: [{ "fill-image": { id: "ignored" } }] }] }] },
      ],
    };
    expect(textImageIds(content)).toEqual([IMAGE, OTHER]);
  });

  it("answers nothing for an empty content", () => {
    expect(textImageIds(undefined)).toEqual([]);
    expect(textImageIds({})).toEqual([]);
  });
});

describe("isImageCached", () => {
  it("passes the uuid quartet and the thumbnail flag", () => {
    expect(isImageCached(module, IMAGE, true)).toBe(false);
    const call = recorded.find((entry) => entry.name === "_is_image_cached");
    expect(call?.args).toEqual([...uuidToU32(IMAGE), true]);
  });

  it("answers true when the renderer holds the image", () => {
    boot(true);
    expect(isImageCached(module, IMAGE)).toBe(true);
  });
});

describe("storeImage", () => {
  it("writes the header and the payload, then hands the buffer over", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    storeImage(module, SHAPE, IMAGE, bytes, true);

    expect(recorded[0]).toEqual({
      name: "_alloc_bytes",
      args: [IMAGE_HEADER_U8_SIZE + bytes.byteLength],
    });

    const view = new DataView(module.HEAPU8.buffer);
    const at = 8;
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(at + index * 4, true)).toBe(uuidToU32(SHAPE)[index]);
      expect(view.getUint32(at + 16 + index * 4, true)).toBe(uuidToU32(IMAGE)[index]);
    }
    expect(view.getUint32(at + 32, true)).toBe(1);
    expect(Array.from(module.HEAPU8.slice(at + IMAGE_HEADER_U8_SIZE, at + 40))).toEqual([
      1, 2, 3, 4,
    ]);
    expect(recorded[1]).toEqual({ name: "_store_image", args: [] });
  });
});

describe("storeImageUrl", () => {
  it("writes the url bytes and passes the uuid quartet", () => {
    expect(storeImageUrl(module, IMAGE, "https://example.test/a.png")).toBe(true);

    const encoded = new TextEncoder().encode("https://example.test/a.png");
    expect(recorded[0]).toEqual({ name: "_alloc_bytes", args: [encoded.byteLength] });
    expect(Array.from(module.HEAPU8.slice(8, 8 + encoded.byteLength))).toEqual(
      Array.from(encoded),
    );
    expect(recorded[1]).toEqual({
      name: "_store_image_url",
      args: Array.from(uuidToU32(IMAGE)),
    });
  });

  it("ignores a blank url", () => {
    expect(storeImageUrl(module, IMAGE, "  ")).toBe(false);
    expect(storeImageUrl(module, IMAGE, undefined)).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("loadImage", () => {
  it("registers the url and fetches on a miss", async () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([9, 8, 7]));

    const pending = loadImage(module, SHAPE, IMAGE, false, {
      resolveUrl: () => "https://example.test/a.png",
      fetchBytes,
    });

    expect(pending).toBeInstanceOf(Promise);
    await pending;

    expect(fetchBytes).toHaveBeenCalledWith("https://example.test/a.png");
    const names = recorded.map((entry) => entry.name);
    expect(names).toContain("_is_image_cached");
    expect(names).toContain("_store_image_url");
    expect(names).toContain("_store_image");
    const store = recorded.find((entry) => entry.name === "_alloc_bytes" && entry.args[0] === 39);
    expect(store).toBeDefined();
  });

  it("skips the fetch on a cache hit but still registers the url", () => {
    boot(true);
    const fetchBytes = vi.fn(async () => new Uint8Array([1]));

    expect(
      loadImage(module, SHAPE, IMAGE, true, {
        resolveUrl: () => "https://example.test/a.png",
        fetchBytes,
      }),
    ).toBeUndefined();

    expect(fetchBytes).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.name)).toEqual([
      "_alloc_bytes",
      "_store_image_url",
      "_is_image_cached",
    ]);
  });

  it("skips the work when the model has no url", () => {
    const fetchBytes = vi.fn(async () => new Uint8Array([1]));
    expect(loadImage(module, SHAPE, IMAGE, false, { fetchBytes })).toBeUndefined();
    expect(fetchBytes).not.toHaveBeenCalled();
    expect(recorded.map((entry) => entry.name)).toEqual(["_is_image_cached"]);
  });

  it("reports a failing fetch and resolves", async () => {
    const cause = new Error("boom");
    const onError = vi.fn();

    await loadImage(module, SHAPE, IMAGE, false, {
      resolveUrl: () => "https://example.test/a.png",
      fetchBytes: async () => {
        throw cause;
      },
      onError,
    });

    expect(onError).toHaveBeenCalledWith(cause, IMAGE);
    expect(recorded.map((entry) => entry.name)).not.toContain("_store_image");
  });

  it("skips an id that is not a uuid", () => {
    expect(loadImage(module, SHAPE, "not-a-uuid", false, {})).toBeUndefined();
    expect(recorded).toEqual([]);
  });
});

describe("loadShapeImages", () => {
  it("collects one promise per image id", () => {
    const pending = loadShapeImages(
      module,
      shape({
        fills: [{ "fill-image": { id: IMAGE } }],
        strokes: [{ "stroke-image": { id: OTHER } }],
      }),
      false,
      {
        resolveUrl: () => "https://example.test/a.png",
        fetchBytes: async () => new Uint8Array([1]),
      },
    );
    expect(pending).toHaveLength(2);
  });
});

describe("loadTextImages", () => {
  it("collects one promise per span image", async () => {
    const content = {
      children: [{ children: [{ children: [{ fills: [{ "fill-image": { id: IMAGE } }] }] }] }],
    };
    const pending = loadTextImages(module, SHAPE, content, false, {
      resolveUrl: () => "https://example.test/a.png",
      fetchBytes: async () => new Uint8Array([1]),
    });
    expect(pending).toHaveLength(1);
    await Promise.all(pending);
  });
});