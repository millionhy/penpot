import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setSerializers } from "./enums.js";
import { FILL_U8_SIZE } from "./fills.js";
import {
  MAX_TEXT_FILLS,
  PARAGRAPH_ATTR_U8_SIZE,
  SPAN_ATTR_U8_SIZE,
  serializeFontSize,
  serializeFontWeight,
  serializeLineHeight,
  writeShapeText,
  type TextParagraph,
  type TextSpan,
} from "./text-content.js";
import { setShapeText, type TextContent } from "./text.js";
import { fakeWasm, record, viewOf, type FakeWasm } from "../../test/fake-wasm.js";
import { getU32, zero } from "../uuid.js";

const table = {
  "vertical-align": { top: 0, center: 1, bottom: 2 },
  "text-align": { left: 0, center: 1, right: 2, justify: 3 },
  "text-direction": { ltr: 0, rtl: 1 },
  "text-decoration": { none: 0, underline: 1, strikethrough: 2 },
  "text-transform": { none: 0, uppercase: 1, lowercase: 2, capitalize: 3 },
  "font-style": { normal: 0, italic: 1 },
};

const custom = "11111111-2222-3333-4444-555555555555";
const decoder = new TextDecoder();

beforeEach(() => {
  setSerializers(table);
});

afterEach(() => {
  setSerializers(undefined);
});

function harness(): FakeWasm {
  const target = fakeWasm();
  record(target, "_clear_shape_text");
  record(target, "_set_shape_vertical_align");
  record(target, "_set_shape_text_content");
  record(target, "_update_shape_text_layout");
  return target;
}

// The paragraph metadata starts after the u32 span count; the text starts
// after the span attrs and the padded fill records of the first span.
function layouts(target: FakeWasm) {
  const base = target.allocs[0];
  const paragraph = base + 4;
  const span = paragraph + PARAGRAPH_ATTR_U8_SIZE;
  const text = span + SPAN_ATTR_U8_SIZE + FILL_U8_SIZE * MAX_TEXT_FILLS;
  return { base, paragraph, span, text };
}

describe("text", () => {
  it("clears, aligns, appends and lays out in the editor's order", () => {
    const target = harness();

    setShapeText(
      {
        "vertical-align": "center",
        children: [
          {
            children: [
              { children: [{ text: "a" }] },
              { children: [] },
              { children: [{ text: "b" }, { text: "c" }] },
            ],
          },
        ],
      },
      target,
    );

    expect(target.calls.map((call) => call.name)).toEqual([
      "_clear_shape_text",
      "_set_shape_vertical_align",
      "_set_shape_text_content",
      "_set_shape_text_content",
      "_update_shape_text_layout",
    ]);
    expect(target.calls[1].args).toEqual([1]);
    expect(target.frees).toBe(0);
  });

  it("does nothing without content", () => {
    const target = harness();
    setShapeText(null, target);
    setShapeText(undefined, target);
    expect(target.calls).toEqual([]);
    expect(target.allocs).toEqual([]);
  });

  it("writes the paragraph header, span attrs, fills and text", () => {
    const target = harness();

    writeShapeText(
      [
        {
          text: "Hi",
          "font-id": `custom-${custom}`,
          "font-size": 20,
          "font-weight": 700,
          fills: [{ "fill-color": "#112233", "fill-opacity": 1 }],
        },
      ],
      {},
      "Hi",
      {},
      target,
    );

    const view = viewOf(target);
    const at = layouts(target);
    expect(view.getUint32(at.base, true)).toBe(1);

    // Paragraph attrs: four u8 discriminants, then line-height and spacing.
    expect(view.getUint8(at.paragraph)).toBe(0);
    expect(view.getUint8(at.paragraph + 1)).toBe(0);
    expect(view.getUint8(at.paragraph + 2)).toBe(0);
    expect(view.getUint8(at.paragraph + 3)).toBe(0);
    expect(view.getFloat32(at.paragraph + 4, true)).toBeCloseTo(1.2);
    expect(view.getFloat32(at.paragraph + 8, true)).toBe(0);

    // Span attrs: style, decoration, transform, direction.
    expect(view.getUint8(at.span)).toBe(0);
    expect(view.getUint8(at.span + 1)).toBe(0);
    expect(view.getUint8(at.span + 2)).toBe(0);
    expect(view.getUint8(at.span + 3)).toBe(0);
    expect(view.getFloat32(at.span + 4, true)).toBe(20);
    expect(view.getFloat32(at.span + 8, true)).toBeCloseTo(1.2);
    expect(view.getFloat32(at.span + 12, true)).toBe(0);
    expect(view.getUint32(at.span + 16, true)).toBe(700);

    const font = getU32(custom);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(at.span + 20 + index * 4, true)).toBe(font[index]);
    }
    // The Rust reader ignores the family hash lane.
    expect(view.getInt32(at.span + 36, true)).toBe(0);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(at.span + 40 + index * 4, true)).toBe(0);
    }
    expect(view.getInt32(at.span + 56, true)).toBe(2);
    expect(view.getInt32(at.span + 60, true)).toBe(1);

    // One solid fill record, then zero padding up to MAX_TEXT_FILLS.
    expect(view.getUint8(at.span + SPAN_ATTR_U8_SIZE)).toBe(0x00);
    expect(view.getUint32(at.span + SPAN_ATTR_U8_SIZE + 4, true)).toBe(0xff112233);
    expect(view.getUint8(at.span + SPAN_ATTR_U8_SIZE + FILL_U8_SIZE)).toBe(0);

    expect(decoder.decode(target.HEAPU8.slice(at.text, at.text + 2))).toBe("Hi");
  });

  it("inherits paragraph font metrics and keeps the span enum defaults", () => {
    const target = harness();

    writeShapeText(
      [{ text: "a", "font-style": "italic", "font-variant-id": "not-a-uuid" }],
      {
        "font-size": "18",
        "text-align": "justify",
        "text-direction": "rtl",
        "text-decoration": "underline",
        "line-height": "1.5",
        "letter-spacing": "2",
      },
      "a",
      {},
      target,
    );

    const view = viewOf(target);
    const at = layouts(target);
    expect(view.getUint8(at.paragraph)).toBe(3);
    expect(view.getUint8(at.paragraph + 1)).toBe(1);
    expect(view.getUint8(at.paragraph + 2)).toBe(1);
    expect(view.getUint8(at.paragraph + 3)).toBe(0);
    expect(view.getFloat32(at.paragraph + 4, true)).toBe(1.5);
    expect(view.getFloat32(at.paragraph + 8, true)).toBe(2);

    // Only the font metrics inherit. The CLJS translator turns a missing enum
    // into its default, and Clojure's `or` treats 0 as truthy, so a span
    // without an explicit decoration/transform/direction keeps the default.
    expect(view.getUint8(at.span)).toBe(1);
    expect(view.getUint8(at.span + 1)).toBe(0);
    expect(view.getUint8(at.span + 2)).toBe(0);
    expect(view.getUint8(at.span + 3)).toBe(0);
    expect(view.getFloat32(at.span + 4, true)).toBe(18);
    expect(view.getFloat32(at.span + 8, true)).toBe(1.5);
    expect(view.getFloat32(at.span + 12, true)).toBe(0);
    expect(view.getUint32(at.span + 16, true)).toBe(400);
    expect(view.getInt32(at.span + 60, true)).toBe(0);

    // An unparsable variant id becomes uuid/zero.
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(at.span + 40 + index * 4, true)).toBe(0);
    }
  });

  it("uses the injected font-id mapping instead of the catalog", () => {
    const target = harness();

    writeShapeText(
      [{ text: "x", "font-id": `custom-${custom}` }],
      {},
      "x",
      { normalizeFontId: () => zero },
      target,
    );

    const view = viewOf(target);
    const at = layouts(target);
    for (let index = 0; index < 4; index += 1) {
      expect(view.getUint32(at.span + 20 + index * 4, true)).toBe(0);
    }
  });

  it("appends each paragraph's joined text", () => {
    const target = harness();
    const content: TextContent = {
      children: [
        {
          children: [
            { children: [{ text: "one" }, { text: " " }, { text: "two" }] },
            { children: [{ text: "three" }] },
          ],
        },
      ],
    };

    setShapeText(content, target);

    const textStart = (base: number, spans: number) =>
      base + 4 + PARAGRAPH_ATTR_U8_SIZE + spans * (SPAN_ATTR_U8_SIZE + FILL_U8_SIZE * MAX_TEXT_FILLS);
    const [first, second] = target.allocs;

    const firstText = textStart(first, 3);
    expect(decoder.decode(target.HEAPU8.slice(firstText, firstText + 7))).toBe("one two");

    const secondText = textStart(second, 1);
    expect(decoder.decode(target.HEAPU8.slice(secondText, secondText + 5))).toBe("three");
  });

  it("keeps the CLJS weight order and the documented defaults", () => {
    // "extrabold"/"semibold" hit the "bold" branch first, exactly as CLJS does.
    expect(serializeFontWeight("extrabold")).toBe(700);
    expect(serializeFontWeight("semibold")).toBe(700);
    expect(serializeFontWeight("extralight")).toBe(200);
    expect(serializeFontWeight("black")).toBe(900);
    expect(serializeFontWeight("600")).toBe(600);
    expect(serializeFontWeight(undefined)).toBe(400);

    expect(serializeFontSize(undefined)).toBe(14);
    expect(serializeFontSize("18")).toBe(18);
    expect(serializeFontSize("oops")).toBe(14);
    expect(serializeLineHeight(undefined)).toBeCloseTo(1.2);
    expect(serializeLineHeight("x", 2)).toBe(2);
  });

  it("writes a zero span count when the span list is empty", () => {
    const target = harness();
    const paragraph: TextParagraph = {};
    const spans: TextSpan[] = [];
    writeShapeText(spans, paragraph, "", {}, target);

    const view = viewOf(target);
    const at = layouts(target);
    expect(view.getUint32(at.base, true)).toBe(0);
    expect(target.calls.map((call) => call.name)).toEqual(["_set_shape_text_content"]);
  });
});
