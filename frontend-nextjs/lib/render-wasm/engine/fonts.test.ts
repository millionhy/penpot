import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markContextInitialized,
  markContextLost,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  CUSTOM_PREFIX,
  DEFAULT_FONT_WEIGHT,
  fontIdBackend,
  fontIdToUuid,
  forceUpdateTextLayout,
  isFontUploaded,
  serializeFontStyle,
  storeFont,
  storeFontUrl,
  updateTextLayout,
  type FontFace,
} from "./fonts";
import { ZERO_UUID, uuidToU32 } from "./uuid";

const FONT_ID = "12345678-9abc-def0-1122-334455667788";
const SHAPE_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

interface Recorded {
  name: string;
  args: unknown[];
}

function makeModule(recorded: Recorded[], state: { uploaded: number }): RenderWasmModule {
  const heap = new Uint8Array(1 << 16);
  let next = 8;
  const record = (name: string) =>
    (...args: unknown[]) => {
      recorded.push({ name, args });
      return 0;
    };

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
    _store_font: record("_store_font"),
    _store_font_url: record("_store_font_url"),
    _is_font_uploaded: (...args: unknown[]) => {
      recorded.push({ name: "_is_font_uploaded", args });
      return state.uploaded;
    },
    _update_shape_text_layout_for: record("_update_shape_text_layout_for"),
    _force_update_shape_text_layout_for: record("_force_update_shape_text_layout_for"),
  };
}

let recorded: Recorded[];
let module: RenderWasmModule;
let state: { uploaded: number };

beforeEach(() => {
  resetModule();
  recorded = [];
  state = { uploaded: 0 };
  module = makeModule(recorded, state);
  setModule(module);
  markContextInitialized();
});

afterEach(() => {
  resetModule();
  vi.restoreAllMocks();
});

function names(): string[] {
  return recorded.map((entry) => entry.name);
}

function callArgs(name: string): unknown[] {
  return recorded.find((entry) => entry.name === name)?.args ?? [];
}

function lastArgs(name: string): unknown[] {
  return [...recorded].reverse().find((entry) => entry.name === name)?.args ?? [];
}

function quartetOf(id: string): number[] {
  return [...uuidToU32(id)];
}

const face: FontFace = { id: FONT_ID, weight: 700, style: "italic" };

describe("the font-id mapping", () => {
  it("names the backend from the id prefix", () => {
    expect(fontIdBackend("gfont-roboto")).toBe("google");
    expect(fontIdBackend(`${CUSTOM_PREFIX}${FONT_ID}`)).toBe("custom");
    expect(fontIdBackend("sourcesanspro")).toBe("builtin");
    expect(fontIdBackend(undefined)).toBe("builtin");
    expect(fontIdBackend(42)).toBe("builtin");
  });

  it("maps custom ids to their uuid and the rest to zero", () => {
    expect(fontIdToUuid(`${CUSTOM_PREFIX}${FONT_ID}`)).toBe(FONT_ID);
    expect(fontIdToUuid("sourcesanspro")).toBe(ZERO_UUID);
    expect(fontIdToUuid(undefined)).toBe(ZERO_UUID);
    expect(fontIdToUuid(`${CUSTOM_PREFIX}not-a-uuid`)).toBe(ZERO_UUID);
  });

  it("resolves a google id through the injected catalog", () => {
    expect(fontIdToUuid("gfont-roboto", () => FONT_ID)).toBe(FONT_ID);
    expect(fontIdToUuid("gfont-roboto")).toBe(ZERO_UUID);
    expect(fontIdToUuid("gfont-roboto", () => "nope")).toBe(ZERO_UUID);
  });

  it("serializes the font style", () => {
    expect(serializeFontStyle("italic")).toBe(1);
    expect(serializeFontStyle("normal")).toBe(0);
    expect(serializeFontStyle("regular")).toBe(0);
    expect(serializeFontStyle(1)).toBe(1);
    expect(serializeFontStyle(undefined)).toBe(0);
  });
});

describe("storeFont", () => {
  it("copies the bytes and calls the renderer with the face quartet", () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    expect(storeFont(module, face, bytes, { emoji: true, fallback: true })).toBe(true);

    expect(names()).toEqual(["_alloc_bytes", "_store_font"]);
    expect(recorded[0].args).toEqual([4]);
    expect([...module.HEAPU8.slice(8, 12)]).toEqual([1, 2, 3, 4]);
    expect(callArgs("_store_font")).toEqual([
      ...quartetOf(FONT_ID),
      700,
      1,
      true,
      true,
    ]);
  });

  it("defaults the weight and the two store flags", () => {
    storeFont(module, { id: FONT_ID }, new Uint8Array([0]));
    expect(callArgs("_store_font")).toEqual([
      ...quartetOf(FONT_ID),
      DEFAULT_FONT_WEIGHT,
      0,
      false,
      false,
    ]);
  });

  it("accepts an ArrayBuffer", () => {
    storeFont(module, face, new Uint8Array([9, 8]).buffer);
    expect([...module.HEAPU8.slice(8, 10)]).toEqual([9, 8]);
  });

  it("skips everything while the context is dead", () => {
    markContextLost(true);
    expect(storeFont(module, face, new Uint8Array([1]))).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("storeFontUrl", () => {
  it("writes the utf-8 url and calls the renderer", () => {
    const url = "https://example.test/f.ttf";
    expect(storeFontUrl(module, face, url)).toBe(true);

    expect(names()).toEqual(["_alloc_bytes", "_store_font_url"]);
    expect(recorded[0].args).toEqual([url.length]);
    expect(new TextDecoder().decode(module.HEAPU8.slice(8, 8 + url.length))).toBe(url);
    expect(callArgs("_store_font_url")).toEqual([...quartetOf(FONT_ID), 700, 1]);
  });

  it("treats a missing or blank url as a no-op", () => {
    expect(storeFontUrl(module, face, "   ")).toBe(false);
    expect(storeFontUrl(module, face, null)).toBe(false);
    expect(storeFontUrl(module, face, undefined)).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("isFontUploaded and the layout calls", () => {
  it("reads the renderer answer as a boolean", () => {
    expect(isFontUploaded(module, face)).toBe(false);
    state.uploaded = 1;
    expect(isFontUploaded(module, face, true)).toBe(true);
    expect(lastArgs("_is_font_uploaded")).toEqual([
      ...quartetOf(FONT_ID),
      700,
      1,
      true,
    ]);
  });

  it("re-measures one shape with both layout exports", () => {
    updateTextLayout(module, SHAPE_ID);
    forceUpdateTextLayout(module, SHAPE_ID);
    expect(names()).toEqual([
      "_update_shape_text_layout_for",
      "_force_update_shape_text_layout_for",
    ]);
    expect(callArgs("_update_shape_text_layout_for")).toEqual(quartetOf(SHAPE_ID));
  });

  it("asks nothing of the renderer while the context is dead", () => {
    markContextLost(true);
    expect(isFontUploaded(module, face)).toBe(false);
    updateTextLayout(module, SHAPE_ID);
    forceUpdateTextLayout(module, SHAPE_ID);
    expect(recorded).toEqual([]);
  });
});