// Constraints and subtree propagation for the resize/rotate gestures
// (F9.10).
//
// Ported from:
// - common/src/app/common/geom/shapes/constraints.cljc
//   (constraint-modifier, const->type+axis, default-constraints-h/v and the
//    forced left/top of calc-child-modifiers inside a layout);
// - common/src/app/common/types/modifiers.cljc and
//   common/src/app/common/geom/shapes/transforms.cljc (the modifier tree:
//   the transformed shapes carry the gesture matrix and every descendant
//   follows its nearest ancestor).
//
// The shell stores world coordinates, so a resize of an axis-aligned
// container is a plain affine map on each axis: x' = scale*x + offset. For
// each direct child the constraint picks that map, read off the parent's
// selrect before and after the resize:
//
//   left / top             keep the start offset:   offset = startDelta, 1
//   right / bottom         keep the end offset:     offset = endDelta, 1
//   leftright / topbottom  keep both offsets:       offset = startDelta, scale = size ratio
//   center                 keep the center offset:  offset = centerDelta, 1
//   scale                  follow the parent's map: offset = afterStart - scale*startBefore
//
// This is the axis-aligned case of calc-child-modifiers: the CLJS first
// removes the deformation the parent resize imposed (normalize-modifiers)
// and then moves the original child bounds by the constraint displacement,
// which is the arithmetic above. The deeper descendants add no constraint
// of their own: they take the matrix of their nearest transformed ancestor.
//
// Deviations from the CLJS original, documented:
// - Only an axis-aligned container spreads constraints (rotation 0, no
//   flip); a rotated or flipped shape hands the gesture matrix to its
//   children. The rule applies at every level, so a deeper child of an
//   axis-aligned container still takes its constraints below a rotated
//   root. The CLJS works on the child quad in the parent frame, and the
//   six-number transform the shell stores cannot express the shear a
//   non-uniform scale of a rotated child produces.
// - A layout frame does not reflow in this local spread: its flow children
//   only get the forced left/top constraints. The renderer does reflow it
//   (F9.11), and the gestures prefer that answer; this module is the
//   fallback for a wasm without the propagate ABI.
// - Constraints are applied to the child's selrect, so a child whose own
//   rotation is non-zero is scaled along the world axes (the same choice
//   the panel size fields make in lib/workspace-geometry.ts).
// - No modifier chain and no `ignore-constraints` flag: the shell never
//   resizes a shape without its subtree, so the flag has no caller.

import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { selrectOf } from "@/lib/workspace-geometry";
import { isAnyLayout, isPositionAbsolute } from "@/lib/workspace-layout";
import {
  applyTransformToShape,
  isTransformableShape,
  type GeometryRect,
  type Matrix6,
  type TransformEntry,
} from "@/lib/workspace-transform";

type Axis = "x" | "y";

// constraints.cljc const->type+axis: the five behaviors the two axes share.
type ConstraintKind = "start" | "end" | "fixed" | "center" | "scale";

const CONSTRAINT_KINDS: Record<string, ConstraintKind> = {
  left: "start",
  top: "start",
  right: "end",
  bottom: "end",
  leftright: "fixed",
  topbottom: "fixed",
  center: "center",
  scale: "scale",
};

// The shape types that own a `shapes` array and can be resized as a box.
const CONTAINER_TYPES = new Set(["frame", "group", "bool"]);

// A resize below this much rotation counts as axis-aligned.
const ALIGNED_EPSILON = 0.01;

// One axis of the child's map: x' = scale * x + offset.
export interface AxisMap {
  scale: number;
  offset: number;
}

function axisStart(rect: GeometryRect, axis: Axis): number {
  return axis === "x" ? rect.x : rect.y;
}

function axisSize(rect: GeometryRect, axis: Axis): number {
  return axis === "x" ? rect.width : rect.height;
}

// -0 and 0 compare equal but not under a deep equality (and a negative zero
// in a wire patch is noise): normalize the sign of a zero result.
function positiveZero(value: number): number {
  return value === 0 ? 0 : value;
}

// constraint-modifier for one axis: the map the child start takes when the
// parent goes from `parentBefore` to `parentAfter`. Null for an unknown
// constraint value (the schema guards the model, this only protects a
// hand-edited file).
export function constraintAxisMap(
  constraint: string,
  axis: Axis,
  parentBefore: GeometryRect,
  parentAfter: GeometryRect,
  childStart: number,
  childSize: number,
): AxisMap | null {
  const kind = CONSTRAINT_KINDS[constraint];
  if (kind === undefined) return null;

  const startBefore = axisStart(parentBefore, axis);
  const startAfter = axisStart(parentAfter, axis);
  const sizeBefore = axisSize(parentBefore, axis);
  const sizeAfter = axisSize(parentAfter, axis);
  const startDelta = startAfter - startBefore;

  let scale = 1;
  let offset = 0;
  switch (kind) {
    case "start":
      offset = startDelta;
      break;
    case "end":
      // The end edge moves by the parent's end delta, which is the start
      // delta plus the size delta.
      offset = startDelta + (sizeAfter - sizeBefore);
      break;
    case "fixed": {
      // Scale around the child start: the start offset stays and the end
      // offset follows the parent's end.
      const size = Math.max(childSize, 0.01);
      scale = Math.max(size + (sizeAfter - sizeBefore), 0.01) / size;
      offset = childStart * (1 - scale) + startDelta;
      break;
    }
    case "center":
      offset = startAfter + sizeAfter / 2 - (startBefore + sizeBefore / 2);
      break;
    case "scale":
      // The child takes the parent's own map: proportional to the parent's
      // size, anchored on the parent's start (which may have moved).
      if (sizeBefore > 0) {
        scale = sizeAfter / sizeBefore;
        offset = startAfter - scale * startBefore;
      }
      break;
  }

  return { scale: positiveZero(scale), offset: positiveZero(offset) };
}

// The world matrix one direct child takes on a resize. Null only when an
// axis carries a constraint the map does not know (the schema guards the
// model, this protects a hand-edited file): the caller then keeps the
// gesture matrix. A constraint that leaves the child alone answers the
// identity matrix, so the child truly stays put.
export function constraintChildMatrix(
  parentBefore: GeometryRect,
  parentAfter: GeometryRect,
  childBefore: GeometryRect,
  constraintH: string,
  constraintV: string,
): Matrix6 | null {
  const horizontal = constraintAxisMap(
    constraintH,
    "x",
    parentBefore,
    parentAfter,
    childBefore.x,
    childBefore.width,
  );
  const vertical = constraintAxisMap(
    constraintV,
    "y",
    parentBefore,
    parentAfter,
    childBefore.y,
    childBefore.height,
  );
  if (horizontal === null || vertical === null) return null;
  return [horizontal.scale, 0, 0, vertical.scale, horizontal.offset, vertical.offset];
}

// Whether the resize of this shape may spread constraints: a container with
// an axis-aligned frame. A blocked shape never reaches the gesture.
export function isConstraintContainer(shape: WorkspaceShape | null): boolean {
  if (shape === null || shape === undefined) return false;
  if (shape["blocked"] === true) return false;
  if (!CONTAINER_TYPES.has(shape.type)) return false;
  if (shape["flip-x"] === true || shape["flip-y"] === true) return false;
  const rotation = typeof shape["rotation"] === "number" ? shape["rotation"] : 0;
  return Math.abs(rotation) < ALIGNED_EPSILON;
}

// default-constraints-h/v, plus the forced left/top calc-child-modifiers
// applies to a flow child of a layout frame.
function constraintFor(parent: WorkspaceShape, child: WorkspaceShape, axis: Axis): string {
  if (isAnyLayout(parent) && !isPositionAbsolute(child)) {
    return axis === "x" ? "left" : "top";
  }
  const value = child[axis === "x" ? "constraints-h" : "constraints-v"];
  if (typeof value === "string") return value;
  // A first-level child of a frame keeps its start edge; anything deeper
  // scales with its parent.
  if (parent.type === "frame") return axis === "x" ? "left" : "top";
  return "scale";
}

// The transforms one gesture applies: every root takes the gesture matrix,
// its subtree follows (see the header). `accepts` filters the set exactly
// like the gesture does before it configures the renderer, so the preview
// and the commit transform the same shapes. The first entry of an id wins.
export function gestureEntries(
  objects: WorkspaceObjects,
  roots: readonly string[],
  matrix: Matrix6,
  rotationDelta: number,
  accepts?: (shape: WorkspaceShape) => boolean,
): TransformEntry[] {
  const out: TransformEntry[] = [];
  const seen = new Set<string>();
  for (const id of roots) {
    if (seen.has(id)) continue;
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    if (accepts !== undefined && !accepts(shape)) continue;
    seen.add(id);
    out.push({ id, matrix, rotation: rotationDelta });
    pushChildren(objects, shape, matrix, rotationDelta, accepts, seen, out);
  }
  return out;
}

// The direct children of one transformed shape: an axis-aligned container
// gives each of them its constraint matrix (the gesture matrix when an axis
// carries an unknown constraint), any other shape hands the gesture matrix
// down. A rotation moves the whole subtree rigidly, with the rotation delta
// added to each descendant.
function pushChildren(
  objects: WorkspaceObjects,
  root: WorkspaceShape,
  matrix: Matrix6,
  rotationDelta: number,
  accepts: ((shape: WorkspaceShape) => boolean) | undefined,
  seen: Set<string>,
  out: TransformEntry[],
): void {
  const children = root.shapes;
  if (!Array.isArray(children)) return;

  const rigid = rotationDelta !== 0 || !isConstraintContainer(root);
  const before = rigid ? null : selrectOf(root);
  const after = before === null ? null : selrectOf(applyTransformToShape(root, matrix, 0));

  for (const childId of children) {
    if (typeof childId !== "string" || seen.has(childId)) continue;
    const child = objects[childId];
    if (child === undefined || child === null) continue;
    if (accepts !== undefined && !accepts(child)) continue;
    seen.add(childId);

    let childMatrix = matrix;
    let childRotation = rotationDelta;
    if (before !== null && after !== null) {
      const childBefore = selrectOf(child);
      if (childBefore !== null) {
        const constrained = constraintChildMatrix(
          before,
          after,
          childBefore,
          constraintFor(root, child, "x"),
          constraintFor(root, child, "y"),
        );
        if (constrained !== null) {
          childMatrix = constrained;
          childRotation = 0;
        }
      }
    }

    out.push({ id: childId, matrix: childMatrix, rotation: childRotation });
    pushChildren(objects, child, childMatrix, childRotation, accepts, seen, out);
  }
}

// The entries of one renderer answer (F9.11), filtered to the shapes this
// shell may transform. The renderer spreads the gesture matrix over every
// descendant, text and blocked shapes included; a text box would move while
// its position-data stayed behind (AD6), so the same gate the local spread
// uses drops it here. A dropped shape takes its subtree with it, so a
// disabled container never leaves its children behind; the walk goes down
// from each rejected id because the renderer reports ids in hash order, not
// parent first. The first entry of an id wins, like gestureEntries.
export function acceptedSubtreeEntries(
  objects: WorkspaceObjects,
  transforms: ReadonlyArray<readonly [string, Matrix6]>,
  accepts: (shape: WorkspaceShape) => boolean = isTransformableShape,
): TransformEntry[] {
  const rejected = new Set<string>();
  for (const [id] of transforms) {
    const shape = objects[id];
    if (shape === undefined || shape === null || !accepts(shape)) rejected.add(id);
  }

  const dropSubtree = (id: string): void => {
    const children = objects[id]?.shapes;
    if (!Array.isArray(children)) return;
    for (const childId of children) {
      if (typeof childId !== "string" || rejected.has(childId)) continue;
      rejected.add(childId);
      dropSubtree(childId);
    }
  };
  for (const id of [...rejected]) dropSubtree(id);

  const out: TransformEntry[] = [];
  const seen = new Set<string>();
  for (const [id, matrix] of transforms) {
    if (rejected.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, matrix, rotation: 0 });
  }
  return out;
}
