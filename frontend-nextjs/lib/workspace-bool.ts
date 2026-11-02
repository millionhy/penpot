// Boolean shapes (F9.12): the creation flow of app.main.data.workspace.bool
// plus the change list it commits.
//
// The content itself comes from the renderer (lib/render-wasm/bool.ts); this
// module decides which shapes take part, what the bool record carries and
// the changes that build it, so the whole step is testable without a wasm:
//
// - operands: the selection minus loops, minus frames, minus variants and
//   minus shapes inside a component copy, in tree order (top-most first);
// - head: the base of the operation — the bottom shape for a difference,
//   the top one otherwise — and the source of the keeps;
// - record: the style properties of the head (fills, strokes, shadow, blur,
//   background blur), the content the renderer answered, and the geometry
//   the content implies (path/update-geometry over a fresh shape);
// - changes: one add-obj right above the head, one mod-obj per operand that
//   drops its layout-item data (the shape leaves the parent layout), and one
//   mov-objects that parents the operands under the bool.
//
// Deviations from the CLJS original, documented:
// - create-bool runs only when the renderer is ready: the CLJS falls back to
//   its pure content calculation, this build commits nothing instead (see
//   lib/render-wasm/bool.ts);
// - change-bool-type (the same shortcut over an existing bool) is not here:
//   it needs the menu slice and rewrites the content as well.

import { ZERO_UUID } from "@/lib/file-data";
import type { PathData, UpdateFileChange } from "@/lib/transit";
import { pathDataRect, rectPoints } from "@/lib/workspace-path";
import { layoutItemAttrsToRemove } from "@/lib/workspace-layout";
import { cleanLoops, isFrameShape } from "@/lib/workspace-selection";
import {
  IDENTITY_TRANSFORM,
  type WorkspaceObjects,
  type WorkspaceShape,
} from "@/lib/workspace";

export type BoolType = "union" | "difference" | "intersection" | "exclude";

export const BOOL_TYPES: readonly BoolType[] = [
  "union",
  "difference",
  "intersection",
  "exclude",
];

// The name create-bool gives the shape: (-> type d/name str/capital).
export const BOOL_TYPE_NAMES: Record<BoolType, string> = {
  union: "Union",
  difference: "Difference",
  intersection: "Intersection",
  exclude: "Exclude",
};

// The shortcut letters of the CLJS keymap (c-mod alt+u/d/i/e).
export const BOOL_SHORTCUTS: Readonly<Record<string, BoolType>> = {
  u: "union",
  d: "difference",
  i: "intersection",
  e: "exclude",
};

// path/bool/style-properties: the keeps of the head plus the two effects of
// the group (a bool is a container, so the group keeps travel too).
export const BOOL_STYLE_PROPERTIES = [
  "fills",
  "strokes",
  "shadow",
  "blur",
  "background-blur",
] as const;

// The fill path/get-default-bool-fills gives an imported svg, which carries
// no fill of its own and would make the operation invisible.
const DEFAULT_BOOL_FILLS = [{ "fill-color": "#000000", "fill-opacity": 1 }];

// ctc/is-variant?: a shape that belongs to a variant component.
function isVariant(shape: WorkspaceShape): boolean {
  return shape["variant-id"] !== undefined && shape["variant-id"] !== null;
}

// ctk/in-component-copy?: the shape carries a shape-ref.
function inComponentCopy(shape: WorkspaceShape): boolean {
  return shape["shape-ref"] !== undefined && shape["shape-ref"] !== null;
}

// ctn/has-any-copy-parent?: something above the shape is an instance.
function hasAnyCopyParent(objects: WorkspaceObjects, shape: WorkspaceShape): boolean {
  const seen = new Set<string>();
  let parentId = shape["parent-id"];
  while (typeof parentId === "string" && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = objects[parentId];
    if (parent === undefined || parent === null) return false;
    if (inComponentCopy(parent)) return true;
    parentId = parent["parent-id"];
  }
  return false;
}

// cfh/order-by-indexed-shapes: the selected ids in tree order, top-most
// first (the CLJS walks the root children reversed and keeps the selection).
export function orderByIndexedShapes(
  objects: WorkspaceObjects,
  ids: readonly string[],
): string[] {
  const selected = new Set(ids);
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    if (selected.has(id)) ordered.push(id);
    const children = objects[id]?.shapes;
    if (!Array.isArray(children)) return;
    for (let index = children.length - 1; index >= 0; index -= 1) visit(children[index]);
  };
  const root = objects[ZERO_UUID];
  const top = Array.isArray(root?.shapes) ? root.shapes : [];
  for (let index = top.length - 1; index >= 0; index -= 1) visit(top[index]);
  return ordered;
}

// The operands of the operation, top-most first. Frames, variants and any
// shape whose parent chain crosses a component copy stay out: a bool flattens
// its children, which would break an instance.
export function boolOperands(
  objects: WorkspaceObjects,
  selection: readonly string[],
): WorkspaceShape[] {
  const ids = cleanLoops(objects, selection).filter(
    (id) => objects[id] !== undefined && objects[id] !== null,
  );
  const shapes: WorkspaceShape[] = [];
  for (const id of orderByIndexedShapes(objects, ids)) {
    const shape = objects[id];
    if (isFrameShape(shape)) continue;
    if (isVariant(shape)) continue;
    if (hasAnyCopyParent(objects, shape)) continue;
    shapes.push(shape);
  }
  return shapes;
}

// The head of the operation: the base of a difference, the top shape
// otherwise (create-bool-shape over the reversed operand list).
export function boolHead(
  type: BoolType,
  children: readonly WorkspaceShape[],
): WorkspaceShape | null {
  if (children.length === 0) return null;
  return type === "difference" ? children[0] : children[children.length - 1];
}

// The record calculate-bool reads before the bool shape exists: the type and
// the operands in children order (bottom-first, the order the wasm reverses
// back into its fold).
export function boolRequest(
  objects: WorkspaceObjects,
  selection: readonly string[],
  type: BoolType,
): { "bool-type": BoolType; shapes: string[] } | null {
  const operands = boolOperands(objects, selection);
  if (operands.length === 0) return null;
  return {
    "bool-type": type,
    shapes: operands.map((shape) => shape.id).reverse(),
  };
}

// create-bool-shape: the bool record, `children` in bottom-first order (the
// order the mov-objects change ends up applying). Answers null when the
// renderer answered no content or the content has no usable box.
export function createBoolShape(
  type: BoolType,
  id: string,
  children: readonly WorkspaceShape[],
  content: PathData,
): WorkspaceShape | null {
  const head = boolHead(type, children);
  if (head === null) return null;
  const rect = pathDataRect(content);
  if (rect === null) return null;

  const fills = Array.isArray(head.fills) ? head.fills : [];
  const strokes = Array.isArray(head.strokes) ? head.strokes : [];
  const svg = head["svg-attrs"] !== undefined && head["svg-attrs"] !== null;
  const parentId = typeof head["parent-id"] === "string" ? head["parent-id"] : ZERO_UUID;
  const frameId =
    typeof head["frame-id"] === "string" ? head["frame-id"] : parentId;

  const shape: WorkspaceShape = {
    id,
    type: "bool",
    name: BOOL_TYPE_NAMES[type],
    "bool-type": type,
    "parent-id": parentId,
    "frame-id": frameId,
    shapes: children.map((child) => child.id),
    content,
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    selrect: {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      x1: rect.x,
      y1: rect.y,
      x2: rect.x + rect.width,
      y2: rect.y + rect.height,
    },
    points: rectPoints(rect),
    transform: { ...IDENTITY_TRANSFORM },
    "transform-inverse": { ...IDENTITY_TRANSFORM },
    rotation: 0,
    proportion: 1,
    "proportion-lock": false,
    fills: svg && fills.length === 0 ? DEFAULT_BOOL_FILLS.map((fill) => ({ ...fill })) : fills,
    strokes,
  };

  // The group keeps of the head travel to the bool (select-keys over
  // bool/style-properties); fills and strokes are already in place.
  for (const attr of BOOL_STYLE_PROPERTIES) {
    if (attr === "fills" || attr === "strokes") continue;
    const value = head[attr];
    if (value !== undefined && value !== null) shape[attr] = value;
  }
  return shape;
}

// The whole creation step: the bool record and the changes that build it.
// Answers null when the selection has no operand or the parent is missing.
export interface BoolCreation {
  shape: WorkspaceShape;
  changes: UpdateFileChange[];
}

export function buildBoolChanges(
  objects: WorkspaceObjects,
  selection: readonly string[],
  type: BoolType,
  pageId: string,
  shapeId: string,
  content: PathData,
): BoolCreation | null {
  const operands = boolOperands(objects, selection);
  if (operands.length === 0) return null;
  // create-bool-shape receives (reverse shapes): bottom-most first.
  const children = operands.slice().reverse();
  const shape = createBoolShape(type, shapeId, children, content);
  if (shape === null) return null;

  const parentId = shape["parent-id"] as string;
  const parent = objects[parentId];
  const siblings =
    parent !== undefined && parent !== null && Array.isArray(parent.shapes)
      ? parent.shapes
      : [];
  const head = boolHead(type, children) as WorkspaceShape;
  const headIndex = siblings.indexOf(head.id);

  const changes: UpdateFileChange[] = [
    {
      type: "add-obj",
      id: shape.id,
      obj: shape,
      "page-id": pageId,
      "frame-id": frameIdOf(shape, parentId),
      "parent-id": parentId,
      // pcb/add-object {:index (inc index)}: the bool lands right above its
      // head, a missing head appends at the tail.
      index: headIndex < 0 ? siblings.length : headIndex + 1,
    },
  ];

  // ctl/remove-layout-item-data: the operands stop being layout items.
  for (const child of children) {
    const operations = layoutItemAttrsToRemove(child)
      .filter((attr) => child[attr] !== undefined && child[attr] !== null)
      .map((attr) => ({ type: "set" as const, attr, val: null }));
    if (operations.length === 0) continue;
    changes.push({ type: "mod-obj", "page-id": pageId, id: child.id, operations });
  }

  // pcb/change-parent: the ids in reverse order, appended at the tail of the
  // bool children (bottom-first, like the backend leaves them).
  changes.push({
    type: "mov-objects",
    "page-id": pageId,
    "parent-id": shape.id,
    shapes: children.map((child) => child.id),
  });

  return { shape, changes };
}

function frameIdOf(shape: WorkspaceShape, parentId: string): string {
  const frameId = shape["frame-id"];
  return typeof frameId === "string" ? frameId : parentId;
}
