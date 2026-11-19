import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  markContextInitialized,
  markContextLost,
  resetModule,
  setModule,
  type RenderWasmModule,
} from "./module";
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_LINE_HEIGHT,
  MAX_TEXT_FILLS,
  PARAGRAPH_ATTR_U8_SIZE,
  SPAN_ATTR_U8_SIZE,
  paragraphByteSize,
  paragraphText,
  parseDouble,
  serializeFontSize,
  serializeFontWeight,
  serializeLetterSpacing,
  serializeLineHeight,
  setShapeTextContent,
  textParagraphs,
  writeShapeText,
  writeTextContent,
  type TextContent,
} from "./text";
import { FILL_U8_SIZE } from "./fills";
import { uuidToU32 } from "./uuid";

const SHAPE_ID = "12345678-9abc-def0-1122-334455667788";
const FONT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const VARIANT_ID = "bbbbbbbb-cccc-dddd-eeee-ffffffffffff";

interface Recorded {
  name: string;
  args: unknown[];
}

function makeModule(recorded: Recorded[], heapSize = 1 << 16): RenderWasmModule {
  const heap = new Uint8Array(heapSize);
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
    _free_bytes: record("_free_bytes"),
    _clear_shape_text: record("_clear_shape_text"),
    _set_shape_text_content: record("_set_shape_text_content"),
    _set_shape_vertical_align: record("_set_shape_vertical_align"),
    _update_shape_text_layout: record("_update_shape_text_layout"),
  };
}

let recorded: Recorded[];
let module: RenderWasmModule;

beforeEach(() => {
  resetModule();
  recorded = [];
  module = makeModule(recorded);
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

function view(): DataView {
  return new DataView(module.HEAPU8.buffer);
}

function utf8Bytes(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

describe("the text attribute serializers", () => {
  it("reads a font size from numbers, strings and nothing", () => {
    expect(serializeFontSize(18)).toBe(18);
    expect(serializeFontSize("16px")).toBe(16);
    expect(serializeFontSize("abc")).toBe(DEFAULT_FONT_SIZE);
    expect(serializeFontSize(undefined)).toBe(DEFAULT_FONT_SIZE);
    expect(parseDouble("1.5")).toBe(1.5);
    expect(parseDouble("nope")).toBeUndefined();
  });

  it("reads a font weight, keeping the original token order", () => {
    expect(serializeFontWeight(700)).toBe(700);
    expect(serializeFontWeight("700")).toBe(700);
    expect(serializeFontWeight("bold")).toBe(700);
    expect(serializeFontWeight("black")).toBe(900);
    expect(serializeFontWeight("extralight")).toBe(200);
    expect(serializeFontWeight("light")).toBe(300);
    expect(serializeFontWeight("medium")).toBe(500);
    expect(serializeFontWeight("thin")).toBe(100);
    expect(serializeFontWeight(undefined)).toBe(400);
    // The CLJS checks "bold" first, so these two answer 700, not 800/600.
    expect(serializeFontWeight("extrabold")).toBe(700);
    expect(serializeFontWeight("semibold")).toBe(700);
  });

  it("reads a line height and a letter spacing", () => {
    expect(serializeLineHeight(2)).toBe(2);
    expect(serializeLineHeight("1.5")).toBe(1.5);
    expect(serializeLineHeight(undefined)).toBe(DEFAULT_LINE_HEIGHT);
    expect(serializeLineHeight(undefined, 3)).toBe(3);
    expect(serializeLetterSpacing("2px")).toBe(2);
    expect(serializeLetterSpacing(undefined)).toBe(0);
  });

  it("sizes a paragraph from the span count and the text bytes", () => {
    expect(paragraphByteSize(0, 0)).toBe(4 + PARAGRAPH_ATTR_U8_SIZE);
    expect(paragraphByteSize(1, 2)).toBe(
      4 + PARAGRAPH_ATTR_U8_SIZE + SPAN_ATTR_U8_SIZE + MAX_TEXT_FILLS * FILL_U8_SIZE + 2,
    );
  });
});

describe("writeShapeText", () => {
  it("writes the count, the attrs, the text slot and the text", () => {
    expect(writeShapeText(module, [{ text: "hi" }], {}, "hi")).toBe(true);

    expect(names()).toEqual(["_alloc_bytes", "_set_shape_text_content"]);
    expect(recorded[0].args).toEqual([paragraphByteSize(1, 2)]);

    const data = view();
    expect(data.getUint32(8, true)).toBe(1); // span count
    expect(data.getUint8(12)).toBe(0); // align left
    expect(data.getUint8(13)).toBe(0); // direction ltr
    expect(data.getUint8(14)).toBe(0); // decoration none
    expect(data.getUint8(15)).toBe(0); // transform none
    expect(data.getFloat32(16, true)).toBeCloseTo(DEFAULT_LINE_HEIGHT);
    expect(data.getFloat32(20, true)).toBe(0); // letter spacing

    expect(data.getUint8(24)).toBe(0); // font style normal
    expect(data.getUint8(25)).toBe(0);
    expect(data.getUint8(26)).toBe(0);
    expect(data.getUint8(27)).toBe(0);
    expect(data.getFloat32(28, true)).toBe(DEFAULT_FONT_SIZE);
    expect(data.getFloat32(32, true)).toBeCloseTo(DEFAULT_LINE_HEIGHT);
    expect(data.getFloat32(36, true)).toBe(0);
    expect(data.getUint32(40, true)).toBe(400);
    expect(data.getUint32(44, true)).toBe(0); // the zero font uuid
    expect(data.getInt32(60, true)).toBe(0); // unused font-family slot
    expect(data.getUint32(64, true)).toBe(0); // zero variant uuid
    expect(data.getUint32(80, true)).toBe(2); // text length
    expect(data.getUint32(84, true)).toBe(0); // fill count

    const textAt = 8 + 4 + PARAGRAPH_ATTR_U8_SIZE + SPAN_ATTR_U8_SIZE + MAX_TEXT_FILLS * FILL_U8_SIZE;
    expect([...module.HEAPU8.slice(textAt, textAt + 2)]).toEqual(utf8Bytes("hi"));
  });

  it("inherits the paragraph attrs and writes the span overrides", () => {
    writeShapeText(
      module,
      [
        {
          text: "é",
          "font-size": "20",
          "font-style": "italic",
          "font-id": `custom-${FONT_ID}`,
          "font-variant-id": VARIANT_ID,
          "letter-spacing": "1.5",
          fills: [{ "fill-color": "#ff0000" }],
        },
      ],
      {
        "font-weight": "bold",
        "line-height": 2,
        "text-align": "center",
        "text-decoration": "underline",
        "text-transform": "uppercase",
        "text-direction": "rtl",
      },
      "é",
      { normalizeFontId: () => FONT_ID },
    );

    const data = view();
    expect(data.getUint8(12)).toBe(1); // center
    expect(data.getUint8(13)).toBe(1); // rtl
    expect(data.getUint8(14)).toBe(1); // underline
    expect(data.getUint8(15)).toBe(1); // uppercase
    expect(data.getFloat32(16, true)).toBe(2);
    expect(data.getFloat32(20, true)).toBe(0);

    expect(data.getUint8(24)).toBe(1); // italic
    // The paragraph attrs (12..15) carry the decoration, the transform and
    // the direction; a span that omits them answers 0, like the CLJS writer
    // whose `or` chain never reaches the paragraph half.
    expect(data.getUint8(25)).toBe(0);
    expect(data.getUint8(26)).toBe(0);
    expect(data.getUint8(27)).toBe(0);
    expect(data.getFloat32(28, true)).toBe(20);
    expect(data.getFloat32(32, true)).toBe(2); // inherited line height
    expect(data.getFloat32(36, true)).toBe(1.5);
    expect(data.getUint32(40, true)).toBe(700); // inherited weight
    expect(data.getUint32(44, true)).toBe(uuidToU32(FONT_ID)[0]);
    expect(data.getUint32(64, true)).toBe(uuidToU32(VARIANT_ID)[0]);
    expect(data.getUint32(80, true)).toBe(2); // "é" is two utf-8 bytes
    expect(data.getUint32(84, true)).toBe(1);

    expect(data.getUint8(88)).toBe(0); // a solid fill record
    expect(data.getUint32(92, true)).toBe(0xffff0000);
    expect(data.getUint32(88 + FILL_U8_SIZE, true)).toBe(0); // padded slot
  });

  it("runs the injected normalizers before writing", () => {
    writeShapeText(module, [{ text: "a" }], {}, "a", {
      normalizeParagraph: (paragraph) => ({ ...paragraph, "text-align": "right" }),
      normalizeSpan: (span) => ({ ...span, "font-weight": "900" }),
      normalizeFontId: (fontId) => (fontId === "sourcesanspro" ? FONT_ID : "bad"),
    });

    const data = view();
    expect(data.getUint8(12)).toBe(2); // right
    expect(data.getUint32(40, true)).toBe(900);
    expect(data.getUint32(44, true)).toBe(uuidToU32(FONT_ID)[0]);
  });

  it("allocates nothing while the context is dead", () => {
    markContextLost(true);
    expect(writeShapeText(module, [{ text: "a" }], {}, "a")).toBe(false);
    expect(recorded).toEqual([]);
  });
});

describe("writeTextContent", () => {
  const content: TextContent = {
    "vertical-align": "center",
    children: [
      {
        children: [
          { children: [{ text: "one" }] },
          { children: [] },
          { children: [{ text: "two" }, { text: " three" }] },
        ],
      },
    ],
  };

  it("writes every non-empty paragraph in order", () => {
    expect(writeTextContent(module, content)).toBe(2);
    expect(names()).toEqual([
      "_alloc_bytes",
      "_set_shape_text_content",
      "_alloc_bytes",
      "_set_shape_text_content",
    ]);
    expect(recorded[0].args).toEqual([paragraphByteSize(1, 3)]);
    expect(recorded[2].args).toEqual([paragraphByteSize(2, 9)]);
  });

  it("reads the paragraph tree and joins the span texts", () => {
    expect(textParagraphs(content)).toHaveLength(3);
    expect(paragraphText({ children: [{ text: "a" }, {}, { text: "b" }] })).toBe("ab");
    expect(textParagraphs({})).toEqual([]);
  });

  it("does nothing while the context is dead", () => {
    markContextLost(true);
    expect(writeTextContent(module, content)).toBe(0);
    expect(recorded).toEqual([]);
  });
});

describe("setShapeTextContent", () => {
  it("clears, aligns, writes and relayouts around the host hooks", () => {
    const order: string[] = [];
    const content: TextContent = {
      "vertical-align": "bottom",
      children: [{ children: [{ children: [{ text: "hi" }] }] }],
    };

    const result = setShapeTextContent(module, content, {
      prepareFonts: () => {
        order.push("fonts");
        return "pending";
      },
      afterWrite: () => order.push("fallback"),
      writeOptions: { normalizeFontId: () => FONT_ID },
    });

    expect(result).toBe("pending");
    expect(order).toEqual(["fonts", "fallback"]);
    expect(names()).toEqual([
      "_clear_shape_text",
      "_set_shape_vertical_align",
      "_alloc_bytes",
      "_set_shape_text_content",
      "_update_shape_text_layout",
    ]);
    expect(recorded[1].args).toEqual([2]); // bottom
    expect(view().getUint32(44, true)).toBe(uuidToU32(FONT_ID)[0]);
  });

  it("skips everything while the context is dead", () => {
    markContextLost(true);
    expect(setShapeTextContent(module, { children: [] })).toBeUndefined();
    expect(recorded).toEqual([]);
  });
});