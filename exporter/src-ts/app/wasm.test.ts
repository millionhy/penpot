// app.wasm: the headless driver against a fake module and a flat heap.

import { afterEach, describe, expect, it, vi } from "vitest";
import { AppError } from "./errors.js";
import * as uuid from "./uuid.js";
import * as wasm from "./wasm.js";

interface FakeModule {
  HEAPU8: Uint8Array;
  HEAPU32: Uint32Array;
  allocs: number[];
  frees: number;
  calls: Array<{ name: string; args: unknown[] }>;
  _alloc_bytes: (count: number) => number;
  _free_bytes: () => void;
  [key: string]: unknown;
}

function fakeModule(): FakeModule {
  const buffer = new ArrayBuffer(65536);
  const heapU8 = new Uint8Array(buffer);
  const heapU32 = new Uint32Array(buffer);
  let next = 256;

  const fake: FakeModule = {
    HEAPU8: heapU8,
    HEAPU32: heapU32,
    allocs: [],
    frees: 0,
    calls: [],
    _alloc_bytes: (count: number) => {
      const ptr = next;
      next += Math.ceil(count / 4) * 4;
      fake.allocs.push(ptr);
      return ptr;
    },
    _free_bytes: () => {
      fake.frees += 1;
    },
  };

  return fake;
}

function writeU32(heap: Uint32Array, offset: number, value: number): void {
  heap[offset >>> 2] = value >>> 0;
}

function writeFontEntry(
  heap: Uint32Array,
  base: number,
  id: readonly number[],
  weight: number,
  style: number,
): void {
  for (let index = 0; index < 4; index += 1) writeU32(heap, base + index * 4, id[index]);
  writeU32(heap, base + 16, weight);
  writeU32(heap, base + 20, style);
}

function writeFontsTable(
  module: FakeModule,
  offset: number,
  families: ReadonlyArray<{ id: number[]; weight: number; style: number }>,
): void {
  writeU32(module.HEAPU32, offset, families.length);
  families.forEach((family, index) => {
    writeFontEntry(module.HEAPU32, offset + 4 + index * wasm.fontEntryBytes, family.id, family.weight, family.style);
  });
}

const SHAPE = "11111111-2222-3333-4444-555555555555";
const IMAGE = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

afterEach(() => {
  wasm.reset();
});

describe("module", () => {
  it("raises until the artifact is booted", () => {
    try {
      wasm.module();
      expect.unreachable();
    } catch (cause) {
      expect(cause).toBeInstanceOf(AppError);
      expect((cause as AppError).data.code).toBe("wasm-not-ready");
    }
  });

  it("returns the module set by the driver", () => {
    const module = fakeModule();
    wasm.setModule(module);

    expect(wasm.module()).toBe(module);
  });
});

describe("fontsForShape", () => {
  it("reads the count and the 24-byte entries, then frees the buffer", () => {
    const module = fakeModule();
    const ptr = 512;
    writeFontsTable(module, ptr, [
      { id: [1, 2, 3, 4], weight: 400, style: 0 },
      { id: [5, 6, 7, 8], weight: 700, style: 1 },
    ]);

    const getFonts = vi.fn((..._args: unknown[]) => ptr);
    module._get_fonts_for_shape = getFonts;
    wasm.setModule(module);

    const families = wasm.fontsForShape(SHAPE);
    const quartet = uuid.getU32(SHAPE);

    expect(getFonts).toHaveBeenCalledWith(quartet[0], quartet[1], quartet[2], quartet[3]);
    expect(families).toEqual([
      { id: Uint32Array.from([1, 2, 3, 4]), weight: 400, style: 0 },
      { id: Uint32Array.from([5, 6, 7, 8]), weight: 700, style: 1 },
    ]);
    expect(module.frees).toBe(1);
  });
});

describe("fontsForShapes", () => {
  it("keeps first-seen order and drops repeated families", () => {
    const module = fakeModule();
    const first = 512;
    const second = 1024;
    writeFontsTable(module, first, [
      { id: [1, 1, 1, 1], weight: 400, style: 0 },
      { id: [2, 2, 2, 2], weight: 400, style: 0 },
    ]);
    writeFontsTable(module, second, [
      { id: [2, 2, 2, 2], weight: 400, style: 0 },
      { id: [3, 3, 3, 3], weight: 400, style: 0 },
    ]);

    let call = 0;
    module._get_fonts_for_shape = () => (call += 1) === 1 ? first : second;
    wasm.setModule(module);

    const families = wasm.fontsForShapes([SHAPE, IMAGE]);

    expect(families.map((family) => family.id[0])).toEqual([1, 2, 3]);
    expect(module.frees).toBe(2);
  });
});

describe("storeFont", () => {
  it("copies the bytes and passes the family key and flags", () => {
    const module = fakeModule();
    let seen: unknown[] = [];
    let stored: number[] = [];
    module._store_font = (...args: unknown[]) => {
      seen = args;
      const ptr = module.allocs[module.allocs.length - 1];
      stored = Array.from(module.HEAPU8.slice(ptr, ptr + 3));
    };
    wasm.setModule(module);

    wasm.storeFont(
      { id: Uint32Array.from([9, 8, 7, 6]), weight: 600, style: 1, emoji: true },
      Uint8Array.from([5, 6, 7]),
    );

    expect(seen).toEqual([9, 8, 7, 6, 600, 1, true, false]);
    expect(stored).toEqual([5, 6, 7]);
    // The store takes the wasm buffer itself.
    expect(module.frees).toBe(0);
  });
});

describe("storeFontUrl", () => {
  it("writes the utf-8 url and registers the family", () => {
    const module = fakeModule();
    let seen: unknown[] = [];
    const url = "https://fonts/x.ttf";
    let stored = "";
    module._store_font_url = (...args: unknown[]) => {
      seen = args;
      const ptr = module.allocs[module.allocs.length - 1];
      stored = Buffer.from(module.HEAPU8.slice(ptr, ptr + Buffer.byteLength(url))).toString("utf-8");
    };
    wasm.setModule(module);

    wasm.storeFontUrl({ id: Uint32Array.from([1, 2, 3, 4]), weight: 400, style: 0 }, url);

    expect(seen).toEqual([1, 2, 3, 4, 400, 0]);
    expect(stored).toBe(url);
    expect(module.frees).toBe(0);
  });
});

describe("imageCached", () => {
  it("passes the full-size flag and turns the answer into a boolean", () => {
    const module = fakeModule();
    const cached = vi.fn((..._args: unknown[]) => 1);
    module._is_image_cached = cached;
    wasm.setModule(module);

    const quartet = uuid.getU32(IMAGE);
    expect(wasm.imageCached(IMAGE)).toBe(true);
    expect(cached).toHaveBeenCalledWith(quartet[0], quartet[1], quartet[2], quartet[3], false);

    module._is_image_cached = () => 0;
    expect(wasm.imageCached(IMAGE)).toBe(false);
  });
});

describe("storeImageUrl", () => {
  it("ignores a blank url", () => {
    const module = fakeModule();
    const store = vi.fn();
    module._store_image_url = store;
    wasm.setModule(module);

    wasm.storeImageUrl(IMAGE, "   ");
    wasm.storeImageUrl(IMAGE, undefined);

    expect(store).not.toHaveBeenCalled();
    expect(module.allocs).toEqual([]);
  });

  it("writes the url and registers the image", () => {
    const module = fakeModule();
    let seen: unknown[] = [];
    module._store_image_url = (...args: unknown[]) => {
      seen = args;
    };
    wasm.setModule(module);

    wasm.storeImageUrl(IMAGE, "https://media/x.png");

    expect(seen).toEqual(Array.from(uuid.getU32(IMAGE)));
    expect(module.frees).toBe(0);
  });
});

describe("storeImage", () => {
  it("writes the 36-byte header and the encoded bytes", () => {
    const module = fakeModule();
    module._store_image = () => undefined;
    wasm.setModule(module);

    wasm.storeImage(IMAGE, Uint8Array.from([0xde, 0xad]));

    const ptr = module.allocs[module.allocs.length - 1];
    const view = new DataView(module.HEAPU8.buffer);
    const quartet = uuid.getU32(IMAGE);

    for (let delta = 0; delta < 16; delta += 4) expect(view.getUint32(ptr + delta, true)).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(ptr + 16 + index * 4, true)).toBe(quartet[index]);
    }
    expect(view.getUint32(ptr + 32, true)).toBe(0);
    expect(Array.from(module.HEAPU8.slice(ptr + 36, ptr + 38))).toEqual([0xde, 0xad]);
    expect(module.frees).toBe(0);
  });
});

describe("evictImages", () => {
  it("returns the number of evicted images", () => {
    const module = fakeModule();
    module._evict_images_to_budget = (maxBytes: number) => (maxBytes === 1000 ? 3 : 0);
    wasm.setModule(module);

    expect(wasm.evictImages(1000)).toBe(3);
  });
});

describe("renderShapeRaster", () => {
  it("reads the 12-byte header, copies the payload and frees it", () => {
    const module = fakeModule();
    const ptr = 4096;
    writeU32(module.HEAPU32, ptr, 3);
    writeU32(module.HEAPU32, ptr + 4, 10);
    writeU32(module.HEAPU32, ptr + 8, 20);
    module.HEAPU8.set([1, 2, 3], ptr + 12);

    const render = vi.fn((..._args: unknown[]) => ptr);
    module._render_shape_raster = render;
    wasm.setModule(module);

    const bytes = wasm.renderShapeRaster(SHAPE, 2, 0);
    const quartet = uuid.getU32(SHAPE);

    expect(render).toHaveBeenCalledWith(quartet[0], quartet[1], quartet[2], quartet[3], 2, 0);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
    expect(module.frees).toBe(1);
  });
});

describe("renderShapePdf/renderShapeSvg", () => {
  it("read the 4-byte length header", () => {
    const module = fakeModule();
    const pdfPtr = 4096;
    const svgPtr = 8192;
    writeU32(module.HEAPU32, pdfPtr, 2);
    module.HEAPU8.set([0x25, 0x50], pdfPtr + 4);
    writeU32(module.HEAPU32, svgPtr, 4);
    module.HEAPU8.set([0x3c, 0x73, 0x76, 0x67], svgPtr + 4);

    const pdf = vi.fn((..._args: unknown[]) => pdfPtr);
    const svg = vi.fn((..._args: unknown[]) => svgPtr);
    module._render_shape_pdf = pdf;
    module._render_shape_svg = svg;
    wasm.setModule(module);

    const quartet = uuid.getU32(SHAPE);
    expect(Array.from(wasm.renderShapePdf(SHAPE, 1.5))).toEqual([0x25, 0x50]);
    expect(pdf).toHaveBeenCalledWith(quartet[0], quartet[1], quartet[2], quartet[3], 1.5);

    expect(Array.from(wasm.renderShapeSvg(SHAPE, 1))).toEqual([0x3c, 0x73, 0x76, 0x67]);
    expect(svg).toHaveBeenCalledWith(quartet[0], quartet[1], quartet[2], quartet[3], 1);
    expect(module.frees).toBe(2);
  });
});

describe("updateTextLayout/clearFonts", () => {
  it("forwards the quartet and the clear call", () => {
    const module = fakeModule();
    const update = vi.fn();
    const clear = vi.fn();
    module._force_update_shape_text_layout_for = update;
    module._clear_fonts = clear;
    wasm.setModule(module);

    wasm.updateTextLayout(SHAPE);
    wasm.clearFonts();

    expect(update).toHaveBeenCalledWith(...Array.from(uuid.getU32(SHAPE)));
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

describe("provisionFonts", () => {
  it("downloads each family once and registers its url", async () => {
    const module = fakeModule();
    writeFontsTable(module, 512, [{ id: [1, 2, 3, 4], weight: 400, style: 0 }]);
    module._get_fonts_for_shape = () => 512;
    const store = vi.fn();
    const storeUrl = vi.fn();
    module._store_font = store;
    module._store_font_url = storeUrl;
    wasm.setModule(module);

    const resolveFont = vi.fn(async () => Uint8Array.from([1, 2]));
    const fontUrl = vi.fn(() => "https://fonts/x.woff2");

    await wasm.provisionFonts([SHAPE, IMAGE], resolveFont, { "font-url": fontUrl });

    expect(resolveFont).toHaveBeenCalledTimes(1);
    expect(store).toHaveBeenCalledTimes(1);
    expect(storeUrl).toHaveBeenCalledTimes(1);
  });

  it("skips a family the resolver could not fetch", async () => {
    const module = fakeModule();
    writeFontsTable(module, 512, [{ id: [1, 2, 3, 4], weight: 400, style: 0 }]);
    module._get_fonts_for_shape = () => 512;
    const store = vi.fn();
    const storeUrl = vi.fn();
    module._store_font = store;
    module._store_font_url = storeUrl;
    wasm.setModule(module);

    await wasm.provisionFonts([SHAPE], async () => null, { "font-url": () => "https://fonts/x.woff2" });

    expect(store).not.toHaveBeenCalled();
    expect(storeUrl).not.toHaveBeenCalled();
  });
});
