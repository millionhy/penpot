// The text-content writer of app.common.render-wasm.text-content.
//
// One paragraph per `_set_shape_text_content` call, appended to the current
// shape: a u32 span count, the 12-byte paragraph attrs, one 64-byte span
// header plus a fixed 8-slot fill block (1280 bytes) per span, then the UTF-8
// bytes of every span's text concatenated in span order. The renderer reads
// it back through `mem::bytes()` (render-wasm/src/wasm/text.rs), which takes
// the single pending allocation, so nothing is freed here.
//
// The CLJS original is shared with the headless exporter; only the font
// variant resolution differs, so the three hooks (font-id -> wasm uuid,
// paragraph and span normalizers) are injected. The defaults keep the
// exporter behaviour: builtin ids resolve to the zero uuid and no variant
// normalization runs.

import { call } from "./call";
import { FILL_U8_SIZE, MAX_FILLS, writeFill, type Fill } from "./fills";
import { alloc, dataView, heapU8, writeBuffer } from "./memory";
import { live, type RenderWasmModule } from "./module";
import {
  translateFontStyle,
  translateTextAlign,
  translateTextDecoration,
  translateTextDirection,
  translateTextTransform,
  translateVerticalAlign,
  type EnumValue,
} from "./serializers";
import { ZERO_UUID, isUuid, uuidToU32 } from "./uuid";

const encoder = new TextEncoder();

// RawParagraphData: the span count plus four enum bytes and two f32.
export const PARAGRAPH_ATTR_U8_SIZE = 12;

// RawTextSpan without its fills: four enum bytes, three f32, the weight, the
// two uuids, the font-family slot, the text length and the fill count.
export const SPAN_ATTR_U8_SIZE = 64;

// The renderer always reserves eight fill slots per span (MAX_TEXT_FILLS).
export const MAX_TEXT_FILLS = MAX_FILLS;

export const DEFAULT_FONT_SIZE = 14;
export const DEFAULT_LINE_HEIGHT = 1.2;
export const DEFAULT_LETTER_SPACING = 0;
export const DEFAULT_FONT_WEIGHT = 400;
export const DEFAULT_FONT_ID = "sourcesanspro";

export interface TextSpan {
  text?: string;
  "font-id"?: string;
  "font-family"?: string;
  "font-variant-id"?: string | null;
  "font-size"?: number | string;
  "font-weight"?: number | string;
  "font-style"?: string;
  "line-height"?: number | string;
  "letter-spacing"?: number | string;
  "text-decoration"?: string;
  "text-transform"?: string;
  "text-direction"?: string;
  fills?: readonly Fill[];
}

// The paragraph attrs are also the fallbacks of its spans.
export interface TextParagraph {
  "font-id"?: string;
  "font-size"?: number | string;
  "font-weight"?: number | string;
  "font-style"?: string;
  "line-height"?: number | string;
  "letter-spacing"?: number | string;
  "text-align"?: string;
  "text-decoration"?: string;
  "text-transform"?: string;
  "text-direction"?: string;
}

// The content tree: a paragraph set holding the paragraphs, each holding its
// spans. The model keys the fields with kebab-case strings.
export interface TextParagraphContent extends TextParagraph {
  children?: readonly TextSpan[];
}

export interface TextParagraphSet {
  children?: readonly TextParagraphContent[];
}

export interface TextContent {
  "vertical-align"?: string;
  children?: readonly TextParagraphSet[];
}

export interface WriteTextOptions {
  // font-id -> the uuid the renderer keys the face by. Defaults to the zero
  // uuid, which the renderer resolves to the default font.
  normalizeFontId?: (fontId: string) => string;
  normalizeParagraph?: (paragraph: TextParagraph) => TextParagraph;
  normalizeSpan?: (span: TextSpan, paragraph: TextParagraph) => TextSpan;
}

// d/parse-double: js/parseFloat plus the NaN -> default step.
export function parseDouble(value: unknown): number | undefined {
  const parsed = Number.parseFloat(String(value));
  return Number.isNaN(parsed) ? undefined : parsed;
}

export function serializeFontSize(fontSize: unknown): number {
  if (typeof fontSize === "number") return fontSize;
  if (typeof fontSize === "string") return parseDouble(fontSize) ?? DEFAULT_FONT_SIZE;
  return DEFAULT_FONT_SIZE;
}

// serialize-font-weight. The order is the original's: "bold" is checked
// before "black" and "extrabold", so "extrabold" and "semibold" both answer
// 700. Kept as-is: the renderer and the classic text engine must agree.
export function serializeFontWeight(fontWeight: unknown): number {
  if (typeof fontWeight === "number") return fontWeight;

  const text = fontWeight === null || fontWeight === undefined ? "" : String(fontWeight);
  if (/^\d+$/.test(text)) return Number(text);
  if (text.includes("bold")) return 700;
  if (text.includes("black")) return 900;
  if (text.includes("extrabold")) return 800;
  if (text.includes("extralight")) return 200;
  if (text.includes("light")) return 300;
  if (text.includes("medium")) return 500;
  if (text.includes("semibold")) return 600;
  if (text.includes("thin")) return 100;
  return DEFAULT_FONT_WEIGHT;
}

export function serializeLineHeight(
  lineHeight: unknown,
  defaultValue: number = DEFAULT_LINE_HEIGHT,
): number {
  if (typeof lineHeight === "number") return lineHeight;
  if (typeof lineHeight === "string") return parseDouble(lineHeight) ?? defaultValue;
  return defaultValue;
}

export function serializeLetterSpacing(letterSpacing: unknown): number {
  if (typeof letterSpacing === "number") return letterSpacing;
  if (typeof letterSpacing === "string") {
    return parseDouble(letterSpacing) ?? DEFAULT_LETTER_SPACING;
  }
  return DEFAULT_LETTER_SPACING;
}

// One paragraph record: 4 + the paragraph attrs + one span record (attrs and
// its fill block) per span + the UTF-8 bytes of every span's text.
export function paragraphByteSize(
  spanCount: number,
  textByteLength: number,
): number {
  return (
    4 +
    PARAGRAPH_ATTR_U8_SIZE +
    spanCount * (SPAN_ATTR_U8_SIZE + MAX_TEXT_FILLS * FILL_U8_SIZE) +
    textByteLength
  );
}

function writeUuid(view: DataView, offset: number, id: string): number {
  const quartet = uuidToU32(id);
  for (let index = 0; index < 4; index += 1) {
    view.setUint32(offset + index * 4, quartet[index], true);
  }
  return offset + 16;
}

// The paragraph-level fallbacks its spans inherit.
interface ParagraphDefaults {
  weight: number;
  lineHeight: number;
}

// The paragraph attrs follow the span count: four enum bytes, the line height
// and the letter spacing. `offset` points after the count.
function writeParagraph(
  view: DataView,
  offset: number,
  paragraph: TextParagraph,
): number {
  view.setUint8(offset, translateTextAlign(paragraph["text-align"]) ?? 0);
  view.setUint8(offset + 1, translateTextDirection(paragraph["text-direction"]) ?? 0);
  view.setUint8(offset + 2, translateTextDecoration(paragraph["text-decoration"]) ?? 0);
  view.setUint8(offset + 3, translateTextTransform(paragraph["text-transform"]) ?? 0);
  view.setFloat32(offset + 4, serializeLineHeight(paragraph["line-height"]), true);
  view.setFloat32(offset + 8, serializeLetterSpacing(paragraph["letter-spacing"]), true);
  return offset + PARAGRAPH_ATTR_U8_SIZE;
}

function writeSpan(
  view: DataView,
  offset: number,
  span: TextSpan,
  paragraph: TextParagraph,
  defaults: ParagraphDefaults,
  normalizeFontId: (fontId: string) => string,
): number {
  const variantId = span["font-variant-id"];
  const textByteLength = encoder.encode(span.text ?? "").byteLength;
  const fills = (span.fills ?? []).slice(0, MAX_TEXT_FILLS);

  view.setUint8(offset, translateFontStyle(span["font-style"] ?? "normal") ?? 0);
  // The CLJS `or` chain falls back to the paragraph attrs, but its translators
  // answer a number for every input (0 for a missing key), so the chain never
  // reaches the paragraph half. The paragraph carries its own attrs; the span
  // answers only with its own, exactly like the compiled writer.
  view.setUint8(offset + 1, translateTextDecoration(span["text-decoration"]) ?? 0);
  view.setUint8(offset + 2, translateTextTransform(span["text-transform"]) ?? 0);
  view.setUint8(offset + 3, translateTextDirection(span["text-direction"]) ?? 0);
  view.setFloat32(
    offset + 4,
    serializeFontSize(span["font-size"] ?? paragraph["font-size"]),
    true,
  );
  view.setFloat32(
    offset + 8,
    serializeLineHeight(span["line-height"], defaults.lineHeight),
    true,
  );
  view.setFloat32(offset + 12, serializeLetterSpacing(span["letter-spacing"]), true);
  view.setUint32(
    offset + 16,
    serializeFontWeight(span["font-weight"] ?? paragraph["font-weight"]),
    true,
  );
  writeUuid(view, offset + 20, normalizeFontId(span["font-id"] ?? DEFAULT_FONT_ID));
  // The renderer keeps the font-family word but never reads it (TextSpan is
  // built from the font uuid, weight and style); the CLJS writes clojure's
  // string hash here.
  view.setInt32(offset + 36, 0, true);
  writeUuid(view, offset + 40, isUuid(variantId) ? variantId : ZERO_UUID);
  view.setUint32(offset + 56, textByteLength, true);
  view.setUint32(offset + 60, fills.length, true);

  // The allocator zeroes the block, so the unused fill slots stay empty.
  let at = offset + SPAN_ATTR_U8_SIZE;
  for (const fill of fills) at = writeFill(view, at, fill);
  return offset + SPAN_ATTR_U8_SIZE + MAX_TEXT_FILLS * FILL_U8_SIZE;
}

// write-shape-text!: one paragraph into the current shape. Returns false when
// the context is dead (nothing was allocated).
export function writeShapeText(
  module: RenderWasmModule,
  spans: readonly TextSpan[],
  paragraph: TextParagraph,
  text: string,
  options: WriteTextOptions = {},
): boolean {
  if (!live()) return false;

  const normalizeParagraph = options.normalizeParagraph ?? ((value) => value);
  const normalizeSpan = options.normalizeSpan ?? ((span) => span);
  const normalizeFontId = options.normalizeFontId ?? (() => ZERO_UUID);

  const preparedParagraph = normalizeParagraph(paragraph);
  const preparedSpans = spans.map((span) => normalizeSpan(span, preparedParagraph));
  const textBytes = encoder.encode(text);

  const size = paragraphByteSize(preparedSpans.length, textBytes.byteLength);
  const offset = alloc(module, size);
  const view = dataView(heapU8(module));

  const defaults: ParagraphDefaults = {
    weight: serializeFontWeight(preparedParagraph["font-weight"]),
    lineHeight: serializeLineHeight(preparedParagraph["line-height"]),
  };

  // The record opens with the span count; the paragraph attrs follow it.
  view.setUint32(offset, preparedSpans.length, true);
  let at = writeParagraph(view, offset + 4, preparedParagraph);
  for (const span of preparedSpans) {
    at = writeSpan(view, at, span, preparedParagraph, defaults, normalizeFontId);
  }
  writeBuffer(heapU8(module), textBytes, at);

  call(module, "_set_shape_text_content");
  return true;
}

// The paragraphs of a content tree: the first paragraph set's children.
export function textParagraphs(content: TextContent): readonly TextParagraphContent[] {
  const set = content.children?.[0];
  return set?.children ?? [];
}

// The text of one paragraph, in span order.
export function paragraphText(paragraph: TextParagraphContent): string {
  return (paragraph.children ?? []).map((span) => span.text ?? "").join("");
}

// write-text-content!: every non-empty paragraph, in order.
export function writeTextContent(
  module: RenderWasmModule,
  content: TextContent,
  options: WriteTextOptions = {},
): number {
  if (!live()) return 0;

  let written = 0;
  for (const paragraph of textParagraphs(content)) {
    const spans = paragraph.children ?? [];
    if (spans.length === 0) continue;
    writeShapeText(module, spans, paragraph, paragraphText(paragraph), options);
    written += 1;
  }
  return written;
}

export function setShapeVerticalAlign(
  module: RenderWasmModule,
  verticalAlign: unknown,
): void {
  call(module, "_set_shape_vertical_align", translateVerticalAlign(verticalAlign as EnumValue) ?? 0);
}

// The host half of set-shape-text-content: resolving and storing the fonts is
// the host's job (it owns the catalog and the fetch), and so is the editor's
// fallback loading. Both run at the point the compiled original runs them;
// `prepareFonts` returns whatever the caller wants back (the pending fetch
// stream in the workspace).
export interface TextContentHost {
  prepareFonts?: (content: TextContent) => unknown;
  afterWrite?: (content: TextContent) => void;
  writeOptions?: WriteTextOptions;
}

// set-shape-text-content: clear, place vertically, store the fonts, write
// every paragraph, then relayout the shape.
export function setShapeTextContent(
  module: RenderWasmModule,
  content: TextContent,
  host: TextContentHost = {},
): unknown {
  if (!live()) return undefined;

  call(module, "_clear_shape_text");
  setShapeVerticalAlign(module, content["vertical-align"]);

  const fonts = host.prepareFonts?.(content);
  writeTextContent(module, content, host.writeOptions);
  host.afterWrite?.(content);
  call(module, "_update_shape_text_layout");

  return fonts;
}