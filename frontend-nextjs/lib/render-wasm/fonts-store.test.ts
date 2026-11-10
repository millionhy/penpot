import { describe, expect, it } from "vitest";

import { KEY } from "./interop";
import {
  forceUpdateTextLayout,
  isFontUploaded,
  storeFontFace,
  updateTextLayout,
} from "./fonts-store";
import type { ResolvedFontFace } from "./fonts";

// A regular builtin face: zero-uuid family, weight 400, style 0, /fonts URL.
const face: ResolvedFontFace = {
  backend: "builtin",
  familyUuid: "00000000-0000-0000-0000-000000000000",
  wasmIdWords: [0, 0, 0, 0],
  weight: 400,
  style: 0,
  ttfUrl: "/fonts/sourcesanspro-regular.ttf",
  isEmoji: false,
  isFallback: false,
};

type Call = [string, unknown];

// A fake emscripten module that models the implicit-buffer contract:
// _alloc_bytes hands back a fixed offset (0) and remembers the requested size;
// _store_font / _store_font_url read the bytes the writer placed there since
// the last alloc, exactly like the real mem::bytes().
function fakeModule(uploaded = 0) {
  const calls: Call[] = [];
  const buffer = new ArrayBuffer(4096);
  const heap = new Uint8Array(buffer);
  let lastSize = 0;
  const mod = {
    HEAPU8: heap,
    _alloc_bytes(len: number) {
      lastSize = len;
      calls.push(["alloc_bytes", len]);
      return 0;
    },
    _store_font(a: number, b: number, c: number, d: number, w: number, s: number, e: boolean, f: boolean) {
      calls.push(["store_font", { a, b, c, d, w, s, e, f }]);
      calls.push(["store_font_bytes", Array.from(heap.slice(0, lastSize))]);
    },
    _store_font_url(a: number, b: number, c: number, d: number, w: number, s: number) {
      calls.push(["store_font_url", { a, b, c, d, w, s }]);
      calls.push(["store_font_url_text", new TextDecoder().decode(heap.slice(0, lastSize))]);
    },
    _is_font_uploaded() {
      return uploaded;
    },
    _update_shape_text_layout_for(a: number, b: number, c: number, d: number) {
      calls.push(["update_layout", { a, b, c, d }]);
    },
    _force_update_shape_text_layout_for(a: number, b: number, c: number, d: number) {
      calls.push(["force_layout", { a, b, c, d }]);
    },
  };
  return { mod, calls };
}

function fakeApp(live: boolean, mod: unknown) {
  return {
    [KEY.wasmLive]: () => live,
    [KEY.internalModule]: mod,
  } as Record<string, unknown>;
}

describe("storeFontFace", () => {
  it("runs alloc -> write -> store_font -> alloc -> write -> store_font_url", () => {
    const { mod, calls } = fakeModule();
    const app = fakeApp(true, mod);
    const bytes = new Uint8Array([1, 2, 3, 4, 5]).buffer;

    const stored = storeFontFace(app, face, bytes);

    expect(stored).toBe(true);
    // alloc(font bytes) -> store_font -> alloc(url) -> store_font_url
    expect(calls.map(([name]) => name)).toEqual([
      "alloc_bytes",
      "store_font",
      "store_font_bytes",
      "alloc_bytes",
      "store_font_url",
      "store_font_url_text",
    ]);
    // The font bytes reached the heap before _store_font read them.
    expect(calls[2]).toEqual(["store_font_bytes", [1, 2, 3, 4, 5]]);
    // Family uuid words + integer weight/style, and the URL text.
    expect(calls[1]).toEqual([
      "store_font",
      { a: 0, b: 0, c: 0, d: 0, w: 400, s: 0, e: false, f: false },
    ]);
    expect(calls[5]).toEqual(["store_font_url_text", "/fonts/sourcesanspro-regular.ttf"]);
  });

  it("no-ops when the renderer is not live", () => {
    const { mod, calls } = fakeModule();
    const app = fakeApp(false, mod);
    const stored = storeFontFace(app, face, new Uint8Array([9]).buffer);
    expect(stored).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("isFontUploaded", () => {
  it("true only when the engine reports a non-zero upload", () => {
    const up = fakeModule(1);
    const down = fakeModule(0);
    expect(isFontUploaded(fakeApp(true, up.mod), face)).toBe(true);
    expect(isFontUploaded(fakeApp(true, down.mod), face)).toBe(false);
  });
});

describe("text layout re-run", () => {
  const shapeId = "ad9d5693-49bf-81be-8008-dde80b1438d6";

  it("updateTextLayout passes the shape uuid words to _update_shape_text_layout_for", () => {
    const { mod, calls } = fakeModule();
    updateTextLayout(fakeApp(true, mod), shapeId);
    // uuidToU32 of the shape id, big-endian, not the family zero uuid.
    expect(calls[0]).toEqual([
      "update_layout",
      { a: 0xad9d5693, b: 0x49bf81be, c: 0x8008dde8, d: 0x0b1438d6 },
    ]);
  });

  it("forceUpdateTextLayout uses the forced export and respects the live guard", () => {
    const { mod, calls } = fakeModule();
    forceUpdateTextLayout(fakeApp(true, mod), shapeId);
    expect(calls[0]?.[0]).toBe("force_layout");

    const guarded = fakeModule();
    forceUpdateTextLayout(fakeApp(false, guarded.mod), shapeId);
    expect(guarded.calls).toHaveLength(0);
  });
});
