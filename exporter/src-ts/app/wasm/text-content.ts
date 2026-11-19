// app.common.render-wasm.text-content, Node side.
//
// The single binary layout for one text paragraph: a u32 span count, the
// 12-byte paragraph attrs, then 64-byte span attrs followed by the span's fill
// records (padded to MAX_TEXT_FILLS), and finally the UTF-8 text. The bytes are
// identical to the workspace serializer; only variant normalization is
// host-specific and injected through `opts`.
//
// Mirrors `common/src/app/common/render_wasm/text_content.cljs`.

import { fontIdToUuid } from "../fonts.js";
import { isUuid, zero, getU32 } from "../uuid.js";
import { call } from "./call.js";
import { MAX_FILLS, FILL_U8_SIZE, writeFill, type Fill } from "./fills.js";
import { dataView, heapU8, alloc } from "./memory.js";
import {
  translateFontStyle,
  translateTextAlign,
  translateTextDecoration,
  translateTextDirection,
  translateTextTransform,
} from "./serializers.js";
import { module, type WasmModule } from "../wasm.js";

export const PARAGRAPH_ATTR_U8_SIZE = 12;
export const SPAN_ATTR_U8_SIZE = 64;
export const MAX_TEXT_FILLS = MAX_FILLS;

const DEFAULT_FONT_SIZE = 14;
const DEFAULT_LINE_HEIGHT = 1.2;
const DEFAULT_LETTER_SPACING = 0.0;

export interface TextFill extends Fill {}

export interface TextSpan {
  text?: string;
  "font-id"?: string;
  "font-family"?: string;
  "font-size"?: number | string;
  "font-weight"?: number | string;
  "font-style"?: string;
  "font-variant-id"?: string;
  "line-height"?: number | string;
  "letter-spacing"?: number | string;
  "text-decoration"?: string;
  "text-transform"?: string;
  "text-direction"?: string;
  fills?: readonly TextFill[];
}

export interface TextParagraph {
  "font-size"?: number | string;
  "font-weight"?: number | string;
  "line-height"?: number | string;
  "letter-spacing"?: number | string;
  "text-align"?: string;
  "text-direction"?: string;
  "text-decoration"?: string;
  "text-transform"?: string;
}

export interface WriteTextOptions {
  normalizeFontId?: (fontId: string) => string;
  normalizeParagraph?: (paragraph: TextParagraph) => TextParagraph;
  normalizeSpan?: (span: TextSpan, paragraph: TextParagraph) => TextSpan;
}

function parseDouble(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number.parseFloat(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function serializeFontSize(fontSize: unknown): number {
  if (typeof fontSize === "number") return fontSize;
  if (typeof fontSize === "string") return parseDouble(fontSize) ?? DEFAULT_FONT_SIZE;
  return DEFAULT_FONT_SIZE;
}

// Weight names are matched in the CLJS order on purpose (bold before
// extrabold), so the numbers stay identical.
export function serializeFontWeight(fontWeight: unknown): number {
  if (typeof fontWeight === "number") return fontWeight;

  const text = String(fontWeight);
  if (/^\d+$/.test(text)) return Number(text);
  if (text.includes("bold")) return 700;
  if (text.includes("black")) return 900;
  if (text.includes("extrabold")) return 800;
  if (text.includes("extralight")) return 200;
  if (text.includes("light")) return 300;
  if (text.includes("medium")) return 500;
  if (text.includes("semibold")) return 600;
  if (text.includes("thin")) return 100;
  return 400;
}

export function serializeLineHeight(lineHeight: unknown, fallback = DEFAULT_LINE_HEIGHT): number {
  if (typeof lineHeight === "number") return lineHeight;
  if (typeof lineHeight === "string") return parseDouble(lineHeight) ?? fallback;
  return fallback;
}

export function serializeLetterSpacing(letterSpacing: unknown): number {
  if (typeof letterSpacing === "number") return letterSpacing;
  if (typeof letterSpacing === "string") return parseDouble(letterSpacing) ?? DEFAULT_LETTER_SPACING;
  return DEFAULT_LETTER_SPACING;
}

function utf8(text: string): Uint8Array {
  return Buffer.from(text, "utf-8");
}

function writeUuid(view: DataView, offset: number, id: string): number {
  const quartet = getU32(id);
  for (let index = 0; index < 4; index += 1) view.setUint32(offset + index * 4, quartet[index], true);
  return offset + 16;
}

function writeParagraphAttrs(view: DataView, offset: number, paragraph: TextParagraph): number {
  view.setUint8(offset, translateTextAlign(paragraph["text-align"]) ?? 0);
  view.setUint8(offset + 1, translateTextDirection(paragraph["text-direction"]) ?? 0);
  view.setUint8(offset + 2, translateTextDecoration(paragraph["text-decoration"]) ?? 0);
  view.setUint8(offset + 3, translateTextTransform(paragraph["text-transform"]) ?? 0);
  view.setFloat32(offset + 4, serializeLineHeight(paragraph["line-height"]), true);
  view.setFloat32(offset + 8, serializeLetterSpacing(paragraph["letter-spacing"]), true);
  return offset + PARAGRAPH_ATTR_U8_SIZE;
}

function writeSpanFills(view: DataView, offset: number, fills: readonly TextFill[]): number {
  let at = offset;
  for (const fill of fills) at = writeFill(view, at, fill);

  const padding = Math.max(0, MAX_TEXT_FILLS - fills.length);
  return at + padding * FILL_U8_SIZE;
}

function writeSpans(
  view: DataView,
  offset: number,
  spans: readonly TextSpan[],
  paragraph: TextParagraph,
  normalizeFontId: (fontId: string) => string,
): number {
  const paragraphFontSize = paragraph["font-size"];
  const paragraphFontWeight = serializeFontWeight(paragraph["font-weight"]);
  const paragraphLineHeight = serializeLineHeight(paragraph["line-height"]);

  let at = offset;
  for (const span of spans) {
    const fontStyle = translateFontStyle(span["font-style"] ?? "normal") ?? 0;
    const decoration =
      translateTextDecoration(span["text-decoration"]) ??
      translateTextDecoration(paragraph["text-decoration"]) ??
      translateTextDecoration("none") ??
      0;
    const transform =
      translateTextTransform(span["text-transform"]) ??
      translateTextTransform(paragraph["text-transform"]) ??
      translateTextTransform("none") ??
      0;
    const direction =
      translateTextDirection(span["text-direction"]) ??
      translateTextDirection(paragraph["text-direction"]) ??
      translateTextDirection("ltr") ??
      0;
    const fontSize = serializeFontSize(span["font-size"] ?? paragraphFontSize);
    const lineHeight = serializeLineHeight(span["line-height"], paragraphLineHeight);
    const letterSpacing = serializeLetterSpacing(span["letter-spacing"]);
    const fontWeight = serializeFontWeight(span["font-weight"] ?? paragraphFontWeight);
    const variantId =
      typeof span["font-variant-id"] === "string" && isUuid(span["font-variant-id"])
        ? span["font-variant-id"]
        : zero;
    const text = span.text ?? "";
    const textBytes = utf8(text);
    const fills = (span.fills ?? []).slice(0, MAX_TEXT_FILLS);

    view.setUint8(at, fontStyle);
    view.setUint8(at + 1, decoration);
    view.setUint8(at + 2, transform);
    view.setUint8(at + 3, direction);
    view.setFloat32(at + 4, fontSize, true);
    view.setFloat32(at + 8, lineHeight, true);
    view.setFloat32(at + 12, letterSpacing, true);
    view.setUint32(at + 16, fontWeight, true);
    at = writeUuid(view, at + 20, normalizeFontId(span["font-id"] ?? "sourcesanspro"));
    // The Rust side keeps only id/weight/style; the family hash lane stays zero.
    view.setInt32(at, 0, true);
    at = writeUuid(view, at + 4, variantId);
    view.setInt32(at, textBytes.byteLength, true);
    view.setInt32(at + 4, fills.length, true);
    at += 8;

    at = writeSpanFills(view, at, fills);
  }

  return at;
}

// Writes one paragraph and appends it to the current shape. The buffer is
// consumed by `_set_shape_text_content`, so it is never freed here.
export function writeShapeText(
  spans: readonly TextSpan[],
  paragraph: TextParagraph,
  text: string,
  options: WriteTextOptions = {},
  target: WasmModule = module(),
): void {
  const normalizeFontId = options.normalizeFontId ?? fontIdToUuid;
  const normalizeParagraph = options.normalizeParagraph ?? ((value: TextParagraph) => value);
  const normalizeSpan =
    options.normalizeSpan ?? ((span: TextSpan, _paragraph: TextParagraph) => span);

  const preparedParagraph = normalizeParagraph(paragraph);
  const preparedSpans = spans.map((span) => normalizeSpan(span, preparedParagraph));

  const fillsSize = FILL_U8_SIZE * MAX_TEXT_FILLS;
  const metadataSize =
    PARAGRAPH_ATTR_U8_SIZE + preparedSpans.length * (SPAN_ATTR_U8_SIZE + fillsSize);
  const textBytes = utf8(text);
  const totalSize = 4 + metadataSize + textBytes.byteLength;

  const offset = alloc(target, totalSize);
  const heap = heapU8(target);
  const view = dataView(heap);

  view.setUint32(offset, preparedSpans.length, true);
  let at = writeParagraphAttrs(view, offset + 4, preparedParagraph);
  at = writeSpans(view, at, preparedSpans, preparedParagraph, normalizeFontId);
  heap.set(textBytes, at);

  call(target, "_set_shape_text_content");
}
