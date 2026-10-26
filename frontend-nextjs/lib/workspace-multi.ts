// The multi-selection batch patches of the workspace style panel (F9.9):
// the pure builders behind the one update-file commit the canvas sends for
// a whole selection.
//
// Ported from frontend/src/app/main/ui/workspace/sidebar/options/shapes/
// multiple.cljs (the menu list a multi selection shows) and from the
// update-shapes call sites of the menus it composes: each selected shape
// receives its own patch, so the per-shape values (a fresh shadow id, the
// stored shadow list) never leak between shapes.
//
// Everything is a ShapeUpdate list, the wire shape the canvas turns into one
// mod-obj per entry: a caller with nothing to change returns an empty list,
// which the canvas resolves as a no-op instead of an empty RPC.

import type { WorkspaceShape } from "@/lib/workspace";
import { inFrameForConstraints } from "@/lib/workspace-layout-attrs";
import {
  addBlur,
  addShadow,
  shadowsOf,
  shadowsPatch,
} from "@/lib/workspace-style";

export interface ShapeUpdate {
  id: string;
  attrs: Record<string, unknown>;
}

// The value every shape shares, or undefined when the list is empty or the
// shapes disagree (the "mixed" state of a multi selection). An undefined read
// and a mixed read collapse to the same answer: the panel shows the mixed
// placeholder in both cases.
export function sharedValue<T>(
  shapes: readonly WorkspaceShape[],
  read: (shape: WorkspaceShape) => T,
): T | undefined {
  if (shapes.length === 0) return undefined;
  const first = read(shapes[0]);
  for (let index = 1; index < shapes.length; index += 1) {
    if (!Object.is(read(shapes[index]), first)) return undefined;
  }
  return first;
}

// The shared boolean of a flag (hidden, blocked); a shape carrying a
// non-boolean value disagrees with the rest.
export function sharedFlag(
  shapes: readonly WorkspaceShape[],
  attr: "hidden" | "blocked",
): boolean | undefined {
  return sharedValue(shapes, (shape) => shape[attr] === true);
}

// One flag for every shape: the caller flips the shared value.
export function flagUpdates(
  shapes: readonly WorkspaceShape[],
  attr: "hidden" | "blocked",
  value: boolean,
): ShapeUpdate[] {
  return shapes.map((shape) => ({ id: shape.id, attrs: { [attr]: value } }));
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

// update-shapes :opacity: one 0..1 value for every shape.
export function opacityUpdates(
  shapes: readonly WorkspaceShape[],
  opacity: number,
): ShapeUpdate[] {
  const value = clamp01(opacity);
  return shapes.map((shape) => ({ id: shape.id, attrs: { opacity: value } }));
}

// shape-radius-to-all-corners of menus/border_radius.cljs: the four radii
// move together. Only rect and frame carry the attribute (the same type set
// the single-shape radius section shows).
export function radiusUpdates(
  shapes: readonly WorkspaceShape[],
  radius: number,
): ShapeUpdate[] {
  const value = Math.max(0, Number.isFinite(radius) ? radius : 0);
  return shapes
    .filter((shape) => shape.type === "rect" || shape.type === "frame")
    .map((shape) => ({
      id: shape.id,
      attrs: { r1: value, r2: value, r3: value, r4: value },
    }));
}

// add-shadow on every shape: each keeps its stored list and gets a fresh
// shadow prepended under its own id.
export function shadowAddUpdates(
  shapes: readonly WorkspaceShape[],
  makeId: () => string,
): ShapeUpdate[] {
  return shapes.map((shape) => ({
    id: shape.id,
    attrs: { shadow: shadowsPatch(addShadow(shadowsOf(shape), makeId())) },
  }));
}

// remove all shadows: a nil val deletes :shadow, the attribute a shape
// without shadows does not carry.
export function shadowClearUpdates(shapes: readonly WorkspaceShape[]): ShapeUpdate[] {
  return shapes
    .filter((shape) => shadowsOf(shape).length > 0)
    .map((shape) => ({ id: shape.id, attrs: { shadow: null } }));
}

// create-blur on every shape; the shape holds one layer blur, so the new map
// replaces the stored one.
export function blurAddUpdates(
  shapes: readonly WorkspaceShape[],
  makeId: () => string,
): ShapeUpdate[] {
  return shapes.map((shape) => ({
    id: shape.id,
    attrs: { blur: addBlur(makeId()) },
  }));
}

// remove the layer blur on the shapes that carry one.
export function blurClearUpdates(shapes: readonly WorkspaceShape[]): ShapeUpdate[] {
  return shapes
    .filter((shape) => shape.blur !== null && shape.blur !== undefined)
    .map((shape) => ({ id: shape.id, attrs: { blur: null } }));
}

// The constraints of every shape that sits inside a frame (the root board
// child has no constraints menu). A null axis keeps the stored value, so
// the caller can edit one axis alone.
export function constraintUpdates(
  shapes: readonly WorkspaceShape[],
  h: string | null,
  v: string | null,
): ShapeUpdate[] {
  const updates: ShapeUpdate[] = [];
  for (const shape of shapes) {
    if (!inFrameForConstraints(shape)) continue;
    const attrs: Record<string, unknown> = {};
    if (h !== null) attrs["constraints-h"] = h;
    if (v !== null) attrs["constraints-v"] = v;
    if (Object.keys(attrs).length > 0) updates.push({ id: shape.id, attrs });
  }
  return updates;
}

// layout-item-h-sizing / -v-sizing on every shape; a null axis keeps the
// stored value. The schema validates the enum on the backend, so an unknown
// string would reject the whole change, which the panel never builds.
export function sizingUpdates(
  shapes: readonly WorkspaceShape[],
  h: string | null,
  v: string | null,
): ShapeUpdate[] {
  const updates: ShapeUpdate[] = [];
  for (const shape of shapes) {
    const attrs: Record<string, unknown> = {};
    if (h !== null) attrs["layout-item-h-sizing"] = h;
    if (v !== null) attrs["layout-item-v-sizing"] = v;
    if (Object.keys(attrs).length > 0) updates.push({ id: shape.id, attrs });
  }
  return updates;
}
