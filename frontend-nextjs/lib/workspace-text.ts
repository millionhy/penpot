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
// - getTextAttrs/setTextAttrs (D4) read and write a typography attribute
//   across the whole content tree. The CLJS routes text-align to the
//   paragraphs and the font/spacing/transform/fills to the text nodes, and
//   stores line-height on both (data/workspace/texts.cljs update-attrs); the
//   writer here mirrors every scalar on both the paragraph and its nodes, the
//   same shape createTextContent already builds, so the reader never reports
//   a mixed value the writer could not produce. The reader takes each key
//   from one authoritative level (text-align off the paragraph, the rest off
//   the text nodes) and fills off the text nodes alone.

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

// --- Typography attrs (D4) -------------------------------------------------
//
// The content tree is root -> paragraph-set -> paragraph -> text node. A
// typography edit applies to the whole shape (every paragraph and every text
// node), so these two helpers are the read/write seam the options component
// commits through: getTextAttrs folds the tree into the shared value per key
// (TEXT_MIXED when the spans disagree, the CLJS :multiple), and setTextAttrs
// rebuilds the tree with the new value mirrored on both levels. Only the keys
// of the ported subset survive the write, like the CLJS emit-update! that
// merges over select-keys of txt/text-node-attrs (ui/.../menus/text.cljs).

// Bounds ported from common/types/text.cljc (font-size-min/max, spacing-min/
// max). The numeric fields clamp to them before they reach the store.
export const TEXT_FONT_SIZE_MIN = 3;
export const TEXT_FONT_SIZE_MAX = 1000;
export const TEXT_SPACING_MIN = -200;
export const TEXT_SPACING_MAX = 200;

// The value getTextAttrs returns when the selection disagrees on a key. The
// fields render it as the "--" placeholder and never commit it back.
export const TEXT_MIXED = "__mixed__" as const;
export type TextMixed = typeof TEXT_MIXED;

// The D4 core slice: the subset of the CLJS txt/text-node-attrs plus the
// paragraph-level text-align the eight target controls write. Stray keys
// (typography refs, text-decoration, direction, the shape/root grow-type and
// vertical-align) are out of this slice.
export const TEXT_NODE_ATTRS = [
  "font-id",
  "font-family",
  "font-variant-id",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-transform",
  "text-align",
  "fills",
] as const;

export type TextAttrKey = (typeof TEXT_NODE_ATTRS)[number];
export type TextAttrValue = string | readonly Record<string, unknown>[] | TextMixed;
export type TextAttrs = Partial<Record<TextAttrKey, TextAttrValue>>;

type ContentNode = Record<string, unknown>;

function isObject(value: unknown): value is ContentNode {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childNodes(node: ContentNode): ContentNode[] {
  const children = node["children"];
  return Array.isArray(children) ? children.filter(isObject) : [];
}

// txt/is-text-node?: a map with no :type and a string :text.
function isTextNode(node: ContentNode): boolean {
  return node["type"] === undefined && typeof node["text"] === "string";
}

function nodeType(node: ContentNode): string | undefined {
  return typeof node["type"] === "string" ? node["type"] : undefined;
}

// Walk the tree collecting every paragraph and every text node, the two
// levels that carry the applied style (like the CLJS node-seq filtered by
// is-paragraph-node? / is-text-node?).
function collectStyled(
  node: ContentNode,
  paragraphs: ContentNode[],
  textNodes: ContentNode[],
): void {
  if (isTextNode(node)) {
    textNodes.push(node);
    return;
  }
  if (nodeType(node) === "paragraph") paragraphs.push(node);
  for (const child of childNodes(node)) collectStyled(child, paragraphs, textNodes);
}

// Compare two raw attr values: numbers and their string form match within a
// float tolerance (the CLJS compares numeric attrs with close?), arrays
// (fills) by their serialized shape.
function attrEq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  const na = typeof a === "number" ? a : Number(a);
  const nb = typeof b === "number" ? b : Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return Math.abs(na - nb) < 1e-6;
  return false;
}

// The stored value normalized for the fields: numbers become strings (the
// CLJS attrs carry font-size and line-height as strings), fills stay arrays.
function toDisplayValue(value: unknown): TextAttrValue {
  if (Array.isArray(value)) return value as readonly Record<string, unknown>[];
  if (typeof value === "string") return value;
  return String(value);
}

// The paragraph is authoritative for text-align, the text node for the rest;
// reading one level per key avoids a false mixed when the two levels are not
// mirrored (a legacy file that only styled one level).
function readSourcesFor(
  key: TextAttrKey,
  paragraphs: ContentNode[],
  textNodes: ContentNode[],
): ContentNode[] {
  if (key !== "text-align") return textNodes;
  return paragraphs.length > 0 ? paragraphs : textNodes;
}

// Fold the content tree into the shared typography value per key. A key no
// node carries is left absent (the field falls back to the default); a key
// the nodes disagree on reads as TEXT_MIXED.
export function getTextAttrs(content: unknown): TextAttrs {
  if (!isObject(content)) return {};
  const paragraphs: ContentNode[] = [];
  const textNodes: ContentNode[] = [];
  collectStyled(content, paragraphs, textNodes);

  const result: TextAttrs = {};
  for (const key of TEXT_NODE_ATTRS) {
    const carriers = readSourcesFor(key, paragraphs, textNodes);
    let seen = false;
    let first: unknown;
    let mixed = false;
    for (const node of carriers) {
      const value = node[key];
      if (value === undefined) continue;
      if (!seen) {
        seen = true;
        first = value;
      } else if (!attrEq(first, value)) {
        mixed = true;
        break;
      }
    }
    if (!seen) continue;
    result[key] = mixed ? TEXT_MIXED : toDisplayValue(first);
  }
  return result;
}

// Rebuild the tree with attrs applied to every paragraph and text node.
// Scalars mirror on both levels (createTextContent's shape); fills land on the
// text nodes alone. Undefined and TEXT_MIXED values are skipped, and keys
// outside the subset are dropped, so a commit never writes a stray attribute.
export function setTextAttrs(content: unknown, attrs: TextAttrs): unknown {
  if (!isObject(content)) return content;

  const scalars: ContentNode = {};
  let fillsValue: unknown;
  let hasFills = false;
  for (const key of TEXT_NODE_ATTRS) {
    const value = attrs[key];
    if (value === undefined || value === TEXT_MIXED) continue;
    if (key === "fills") {
      fillsValue = value;
      hasFills = true;
    } else {
      scalars[key] = value;
    }
  }

  const rewrite = (node: ContentNode): ContentNode => {
    if (isTextNode(node)) {
      const next: ContentNode = { ...node, ...scalars };
      if (hasFills) next["fills"] = fillsValue;
      return next;
    }
    const next: ContentNode = { ...node };
    if (nodeType(node) === "paragraph") Object.assign(next, scalars);
    const children = node["children"];
    if (Array.isArray(children)) {
      next["children"] = children.map((child) => (isObject(child) ? rewrite(child) : child));
    }
    return next;
  };

  return rewrite(content);
}
