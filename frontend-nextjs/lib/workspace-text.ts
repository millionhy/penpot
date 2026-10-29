// The text shape model (第2项): setup-shape for :text, the default attrs of
// the CLJS text types, and the content the inline editor commits.
//
// Ported from:
// - common/src/app/common/types/text.cljc (default-text-attrs,
//   default-text-fills, default-root-attrs, default-paragraph-attrs and
//   change-text);
// - common/src/app/common/types/shape.cljc (minimal-text-attrs: type and
//   name only; text keeps the setup-rect geometry and setup-proportions
//   leaves the proportions alone);
// - frontend/src/app/main/data/workspace/drawing/common.cljs
//   (handle-finish-drawing: a click text is a 4 x 17 box with grow-type
//   auto-width anchored at the press point; a dragged text keeps its box
//   with grow-type fixed);
// - frontend/src/app/main/data/workspace/shapes.cljs (add-shape starts the
//   edition on a new text shape and deletes it when the edition ends empty).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
//
// Deviations from the CLJS original, documented:
// - The box the editor commits is measured with a fixed advance ratio
//   (0.55 em per character) instead of the wasm text layout
//   (calc-text-bounds). The renderer still draws the stored text; a reload
//   keeps the committed box.
// - The editor edits one plain text value: no rich spans, no per-span
//   styles and no paragraph selection.

// shapes/text.cljc default-text-attrs. The ids of the typography references
// stay absent, like the nil defaults the CLJS drops on serialize.
export const TEXT_DEFAULT_ATTRS: Readonly<Record<string, unknown>> = {
  "font-id": "sourcesanspro",
  "font-family": "sourcesanspro",
  "font-variant-id": "regular",
  "font-size": "14",
  "font-weight": "400",
  "font-style": "normal",
  "line-height": "1.2",
  "letter-spacing": "0",
  "text-transform": "none",
  "text-align": "left",
  "text-decoration": "none",
  "text-direction": "ltr",
};

// text.cljc default-paragraph-attrs.
export const TEXT_PARAGRAPH_ATTRS: Readonly<Record<string, unknown>> = {
  "text-align": "left",
  "text-direction": "ltr",
};

// text.cljc default-root-attrs.
const TEXT_ROOT_ATTRS: Readonly<Record<string, unknown>> = {
  "vertical-align": "top",
};

// text.cljc default-text-fills: black at opacity 1.
export const TEXT_DEFAULT_FILLS: ReadonlyArray<Readonly<Record<string, unknown>>> = [
  { "fill-color": "#000000", "fill-opacity": 1 },
];

// The font size and line height the CLJS attrs carry as strings.
export const TEXT_FONT_SIZE = 14;
export const TEXT_LINE_HEIGHT = 1.2;

// drawing/common.cljs: the click box of a text shape.
export const TEXT_CLICK_WIDTH = 4;
export const TEXT_CLICK_HEIGHT = 17;

// The approximation of the glyph advance the box measurement uses: the CLJS
// asks the wasm text layout instead.
const TEXT_ADVANCE_RATIO = 0.55;

export type TextGrowType = "fixed" | "auto-width";

export interface TextRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// text/change-text: root -> paragraph-set -> one paragraph per line, each
// paragraph holding one text node. Both the paragraph and its text node
// carry the default text attrs, like the merge of paragraph-style and
// text-style in the CLJS.
export function createTextContent(text: string): Record<string, unknown> {
  const lines = text.split("\n");
  return {
    type: "root",
    ...TEXT_ROOT_ATTRS,
    children: [
      {
        type: "paragraph-set",
        children: lines.map((line) => ({
          type: "paragraph",
          ...TEXT_PARAGRAPH_ATTRS,
          ...TEXT_DEFAULT_ATTRS,
          children: [{ text: line, ...TEXT_DEFAULT_ATTRS }],
        })),
      },
    ],
  };
}

// The plain text of a content tree, the value the editor starts from.
export function textPlainText(content: unknown): string {
  if (content === null || typeof content !== "object") return "";
  const root = content as { children?: unknown };
  if (!Array.isArray(root.children)) return "";
  const paragraphs: string[] = [];
  for (const set of root.children) {
    if (set === null || typeof set !== "object") continue;
    const children = (set as { children?: unknown }).children;
    if (!Array.isArray(children)) continue;
    for (const paragraph of children) {
      if (paragraph === null || typeof paragraph !== "object") continue;
      const nodes = (paragraph as { children?: unknown }).children;
      if (!Array.isArray(nodes)) continue;
      let line = "";
      for (const node of nodes) {
        if (node !== null && typeof node === "object") {
          const value = (node as { text?: unknown }).text;
          if (typeof value === "string") line += value;
        }
      }
      paragraphs.push(line);
    }
  }
  return paragraphs.join("\n");
}

// The box the editor commits: the longest line sets the width, the line
// count sets the height. A blank text keeps the click box of the CLJS.
export function measureTextRect(text: string, x: number, y: number): TextRect {
  const lines = text.split("\n");
  let longest = 0;
  for (const line of lines) {
    // Count code points, so an emoji or an accented pair counts once.
    longest = Math.max(longest, [...line].length);
  }
  return {
    x,
    y,
    width: Math.max(TEXT_CLICK_WIDTH, longest * TEXT_FONT_SIZE * TEXT_ADVANCE_RATIO),
    height: Math.max(TEXT_CLICK_HEIGHT, lines.length * TEXT_FONT_SIZE * TEXT_LINE_HEIGHT),
  };
}

// The mod-obj attrs of a finished edition: the packed content plus the
// geometry of the measured box (setup-rect).
export function textEditAttrs(text: string, x: number, y: number): Record<string, unknown> {
  const rect = measureTextRect(text, x, y);
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  return {
    content: createTextContent(text),
    width: rect.width,
    height: rect.height,
    selrect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      x1: rect.x,
      y1: rect.y,
      x2,
      y2,
    },
    points: [
      { x: rect.x, y: rect.y },
      { x: x2, y: rect.y },
      { x: x2, y: y2 },
      { x: rect.x, y: y2 },
    ],
  };
}
