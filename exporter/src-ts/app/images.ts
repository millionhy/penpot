// app.common.types.shape.images, Node side: the image ids a scene references.
//
// Pure walking, no Node or browser dependencies, so the exporter fetches
// exactly the bytes the workspace would. Mirrors
// `common/src/app/common/types/shape/images.cljs`.

import { coerce, getImageIds, type Fills } from "./wasm/fills.js";
import type { Stroke } from "./wasm/props.js";
import type { Shape } from "./wasm/upload.js";

interface TextNode {
  children?: readonly TextNode[];
  fills?: Fills;
}

function fillImageIds(fills: Fills | null | undefined): string[] {
  if (fills === null || fills === undefined || fills.length === 0) return [];
  return getImageIds(coerce(fills));
}

function strokeImageIds(strokes: readonly Stroke[] | null | undefined): string[] {
  const ids: string[] = [];
  for (const stroke of strokes ?? []) {
    const id = stroke["stroke-image"]?.id;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}

// Image-fill ids referenced by a text shape's span fills.
function textImageIds(content: unknown): string[] {
  if (content === null || content === undefined || typeof content !== "object") return [];

  const ids: string[] = [];
  const visit = (node: TextNode): void => {
    for (const id of fillImageIds(node.fills)) ids.push(id);
    for (const child of node.children ?? []) visit(child);
  };

  visit(content as TextNode);
  return ids;
}

// Distinct image ids referenced by one shape: its fills, its strokes' image
// fills, and (for texts) its spans' image fills.
export function shapeImageIds(shape: Shape): Set<string> {
  const ids = new Set<string>();

  for (const id of fillImageIds(shape.fills)) ids.add(id);
  for (const id of strokeImageIds(shape.strokes)) ids.add(id);

  // `content` is only a text tree for text shapes (paths reuse the key for
  // geometry).
  if (shape.type === "text") {
    for (const id of textImageIds(shape.content)) ids.add(id);
  }

  return ids;
}

// Distinct image ids referenced anywhere in an `objects` map.
export function sceneImageIds(scene: Record<string, Shape>): Set<string> {
  const ids = new Set<string>();
  for (const shape of Object.values(scene)) {
    for (const id of shapeImageIds(shape)) ids.add(id);
  }
  return ids;
}