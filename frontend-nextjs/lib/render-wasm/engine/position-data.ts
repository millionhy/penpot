// calculate-position-data: the placement the renderer computed for the
// current text shape, read back as plain text attrs.
//
// The compiled body (app.render-wasm.api/calculate-position-data) selects the
// shape, calls `_calculate_position_data`, reads a count-prefixed panel of
// 36-byte entries, frees the buffer, and patches the editor's default text
// attrs with what the renderer measured. The entry layout, in 32-bit slots:
//
//   [u32 paragraph][u32 span][u32 start][u32 end]
//   [f32 x][f32 y][f32 width][f32 height][u32 direction]
//
// The buffer is written by Rust and owned by the caller only until
// `_free_bytes`, so it is read in one synchronous step and never kept.

import { call } from "./call";
import { free, heapF32, heapU32, offset32 } from "./memory";
import { ready, type RenderWasmModule } from "./module";
import { selectShape } from "./select";
import { textParagraphs, type TextContent } from "./text";

export const POSITION_DATA_U8_SIZE = 36;
export const POSITION_DATA_U32_SIZE = POSITION_DATA_U8_SIZE / 4;

export interface PositionEntry {
  paragraph: number;
  span: number;
  startPos: number;
  endPos: number;
  x: number;
  y: number;
  width: number;
  height: number;
  direction: number;
}

// The shape half the calculation reads: an id to select and the text tree.
export interface PositionDataShape {
  id: string;
  content?: TextContent | null;
}

export type PositionDataAttrs = Record<string, unknown>;

// translate-direction: 0 is RTL, everything else LTR.
export function translateDirection(direction: unknown): "ltr" | "rtl" {
  return direction === 0 ? "rtl" : "ltr";
}

// get-default-text-attrs of app.common.types.text. The binary-fills flag only
// changes the fills representation, and this module already carries plain
// fill maps.
export function defaultTextAttrs(): Record<string, unknown> {
  return {
    "typography-ref-file": null,
    "typography-ref-id": null,
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
    fills: [{ "fill-color": "#000000", "fill-opacity": 1 }],
  };
}

// The entries of one returned panel: `offset` and `length` are in 32-bit
// slots, like the compiled loop.
export function readPositionEntries(
  view32: Uint32Array,
  viewF32: Float32Array,
  offset: number,
  length: number,
): PositionEntry[] {
  const entries: PositionEntry[] = [];
  for (let index = 0; index < length; index += 1) {
    const at = offset + index * POSITION_DATA_U32_SIZE;
    entries.push({
      paragraph: view32[at],
      span: view32[at + 1],
      startPos: view32[at + 2],
      endPos: view32[at + 3],
      x: viewF32[at + 4],
      y: viewF32[at + 5],
      width: viewF32[at + 6],
      height: viewF32[at + 7],
      direction: view32[at + 8],
    });
  }
  return entries;
}

// subs of the compiled body. RTL runs can carry start-pos past end-pos; the
// compiled code would throw there, the port reads the same run in the right
// order.
function sliceText(text: string, start: number, end: number): string {
  return start <= end ? text.slice(start, end) : text.slice(end, start);
}

function styleString(value: unknown): string {
  return `${value === undefined || value === null ? "" : String(value)}px`;
}

// The span the renderer measured, or undefined when the model no longer holds
// it (a stale id, or a text tree edited after the upload).
function spanElement(
  content: TextContent | null | undefined,
  paragraph: number,
  span: number,
): Record<string, unknown> | undefined {
  if (content === null || content === undefined) return undefined;
  const paragraphs = textParagraphs(content);
  const spans = paragraphs[paragraph]?.children;
  const element = spans?.[span];
  return element as Record<string, unknown> | undefined;
}

function positionAttrs(
  entry: PositionEntry,
  element: Record<string, unknown> | undefined,
  text: string,
): PositionDataAttrs {
  const attrs: PositionDataAttrs = { ...defaultTextAttrs() };
  const values: Record<string, unknown> = {
    x: entry.x,
    y: entry.y + entry.height,
    width: entry.width,
    height: entry.height,
    direction: translateDirection(entry.direction),
    "font-id": element?.["font-id"],
    "font-family": element?.["font-family"],
    "font-size": styleString(element?.["font-size"]),
    "font-weight": element?.["font-weight"],
    "text-transform": element?.["text-transform"],
    "text-decoration": element?.["text-decoration"],
    "letter-spacing": styleString(element?.["letter-spacing"]),
    "font-style": element?.["font-style"],
    fills: element?.fills,
    text,
  };
  for (const [key, value] of Object.entries(values)) {
    // d/without-nils: the default stays when the renderer answered nothing.
    if (value === undefined || value === null) continue;
    attrs[key] = value;
  }
  return attrs;
}

// calculate-position-data: nil when the context is not ready (the compiled
// `(when (initialized?) ...)`), otherwise one attrs map per measured run.
export function calculatePositionData(
  module: RenderWasmModule,
  shape: PositionDataShape,
): PositionDataAttrs[] | undefined {
  if (!ready()) return undefined;
  if (!selectShape(module, shape.id)) return undefined;

  const offset = offset32(call<number>(module, "_calculate_position_data"));
  // Re-read after the call: a heap growth detaches the previous views.
  const view32 = heapU32(module);
  const viewF32 = heapF32(module);
  const length = view32[offset];
  const entries = readPositionEntries(view32, viewF32, offset + 1, length);

  free(module);

  const content = shape.content ?? undefined;
  const out: PositionDataAttrs[] = [];
  for (const entry of entries) {
    const element = spanElement(content, entry.paragraph, entry.span);
    const text = element?.["text"];
    if (typeof text !== "string") continue;
    out.push(positionAttrs(entry, element, sliceText(text, entry.startPos, entry.endPos)));
  }
  return out;
}
