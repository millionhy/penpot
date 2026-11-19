// app.wasm.text: the exporter's browser-free text serialization.
//
// Mirrors the editor's sequence for one text shape: clear, set the vertical
// alignment, append one paragraph at a time, then lay the text out. Byte
// writing and the font-id mapping come from the shared text-content module;
// the exporter has no fonts database, so it injects no variant normalization.

import { call } from "./call.js";
import { translateVerticalAlign } from "./serializers.js";
import { writeShapeText, type TextParagraph, type TextSpan } from "./text-content.js";
import { module, type WasmModule } from "../wasm.js";

export interface TextParagraphNode extends TextParagraph {
  children?: readonly TextSpan[];
}

export interface TextParagraphSetNode {
  children?: readonly TextParagraphNode[];
}

export interface TextContent {
  "vertical-align"?: string;
  children?: readonly TextParagraphSetNode[];
}

export function setShapeText(content: TextContent | null | undefined, target: WasmModule = module()): void {
  if (content === null || content === undefined) return;

  call(target, "_clear_shape_text");
  call(target, "_set_shape_vertical_align", translateVerticalAlign(content["vertical-align"]) ?? 0);

  const paragraphSet = content.children?.[0];
  const paragraphs = paragraphSet?.children ?? [];

  for (const paragraph of paragraphs) {
    const spans = paragraph.children ?? [];
    if (spans.length === 0) continue;

    const text = spans.map((span) => span.text ?? "").join("");
    writeShapeText(spans, paragraph, text, {}, target);
  }

  call(target, "_update_shape_text_layout");
}
