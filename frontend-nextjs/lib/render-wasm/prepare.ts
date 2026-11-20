// prepare-objects / prepare-page-objects (app.main.ui.viewer.viewport-common)
// over the plain decoded objects: shift shapes into vbox space by
// -(size + delta), where size is the padded bounds origin and delta the
// alignment offset of an overlay viewport.
//
// The viewer hands the prepared map to the hotspot layer only; the wasm pass
// keeps the raw objects. That is why a pure translation is enough and the
// path content stays untouched (see translateShape).

import { ZERO_UUID } from "./engine";
import { translateShape } from "./engine/transform";

export type ShapeObjects = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function childIds(shape: Record<string, unknown>): string[] {
  const value = shape.shapes;
  if (!Array.isArray(value)) return [];
  return value.filter((id): id is string => typeof id === "string");
}

// files/get-children-ids: every descendant, depth first in `shapes` order.
// `processed` travels down each branch, so a cycle stops at the id that
// started it while a diamond keeps both paths, like the CLJS `conj`.
export function getChildrenIds(objects: ShapeObjects, id: string): string[] {
  const walk = (currentId: string, processed: Set<string>): string[] => {
    if (processed.has(currentId)) return [];
    const shape = objects[currentId];
    if (!isObject(shape)) return [];
    const children = childIds(shape);
    if (children.length === 0) return [];

    const nextProcessed = new Set(processed);
    nextProcessed.add(currentId);
    const out = children.slice();
    for (const child of children) out.push(...walk(child, nextProcessed));
    return out;
  };

  return walk(id, new Set());
}

function shiftAll(
  objects: ShapeObjects,
  ids: readonly string[],
  dx: number,
  dy: number,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...objects };
  for (const id of ids) {
    const shape = objects[id];
    if (!isObject(shape)) continue;
    out[id] = translateShape(shape, dx, dy);
  }
  return out;
}

export interface PrepareSize {
  x: number;
  y: number;
}

// prepare-objects: the frame and its subtree move into vbox space.
export function prepareObjects(
  objects: ShapeObjects,
  frameId: string,
  size: PrepareSize,
  delta: PrepareSize,
): Record<string, unknown> {
  const dx = -(size.x + delta.x);
  const dy = -(size.y + delta.y);
  return shiftAll(objects, [frameId, ...getChildrenIds(objects, frameId)], dx, dy);
}

// prepare-page-objects: every object except the page root.
export function preparePageObjects(
  objects: ShapeObjects,
  size: PrepareSize,
  delta: PrepareSize,
): Record<string, unknown> {
  const dx = -(size.x + delta.x);
  const dy = -(size.y + delta.y);
  return shiftAll(
    objects,
    Object.keys(objects).filter((id) => id !== ZERO_UUID),
    dx,
    dy,
  );
}
