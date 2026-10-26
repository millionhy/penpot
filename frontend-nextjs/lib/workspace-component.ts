// Component predicates and tree walks over the JS workspace model (F9.3
// companion changes), ported from common/src/app/common/types/component.cljc
// and common/src/app/common/types/container.cljc. They serve two purposes:
// - the reparent companions of generate-relocate (the component-root
//   add/remove when a shape enters or leaves a component instance);
// - the structural guards of the backend `is-valid-move?` (never alter a
//   component copy, never create a component nesting loop).
//
// Deviations from the CLJS original, documented:
// - The walks carry a visited set: the backend trusts the tree shape, the
//   shell must not hang on a malformed cycle.
// - `find-component-main` and the swap-slot helpers stay out: the F9.3
//   companion slice drops swap slots because they travel as a touched group,
//   which this client does not encode yet.

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { getParentsWithSelf, isInstanceHead } from "@/lib/workspace-selection";

function shapeOf(objects: WorkspaceObjects, id: string): WorkspaceShape | null {
  const shape = objects[id];
  return shape === undefined || shape === null ? null : shape;
}

function componentIdOf(shape: WorkspaceShape): string | null {
  const componentId = shape["component-id"];
  return typeof componentId === "string" ? componentId : null;
}

// helpers.cljc root?: the zero frame itself.
export function isRootShape(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape.type === "frame" && shape.id === ZERO_UUID;
}

// ctk/in-component-copy?: the shape belongs to a component copy (its
// shape-ref points at the main shape). A main instance does not carry
// shape-ref, so it stays editable.
export function isInComponentCopy(shape: WorkspaceShape | null): boolean {
  if (shape === null) return false;
  const shapeRef = shape["shape-ref"];
  return shapeRef !== null && shapeRef !== undefined;
}

// ctk/instance-root?: the head of a top instance (main or copy).
export function isInstanceRoot(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["component-root"] === true;
}

// ctk/subinstance-head?: a nested instance head (component-id without the
// component-root flag). The head predicate (ctk/instance-head?) lives in
// lib/workspace-selection and is shared with the hover/selection code.
export function isSubinstanceHead(shape: WorkspaceShape | null): boolean {
  return isInstanceHead(shape) && !isInstanceRoot(shape);
}

// ctn/get-instance-root: the top shape of the instance containing `shape`
// (itself when it already is a root), null at the zero root. Used with the
// reparent target: a non-null answer means the target sits inside an
// instance and moved-in heads lose their component-root flag.
export function getInstanceRoot(
  objects: WorkspaceObjects,
  shape: WorkspaceShape | null,
): WorkspaceShape | null {
  const seen = new Set<string>();
  let current = shape;
  while (current !== null) {
    if (isRootShape(current)) return null;
    if (isInstanceRoot(current)) return current;
    if (seen.has(current.id)) return null;
    seen.add(current.id);
    const parentId = current["parent-id"];
    if (typeof parentId !== "string") return null;
    current = shapeOf(objects, parentId);
  }
  return null;
}

// ctn/get-child-heads: every descendant instance head of one shape,
// including the shape itself when it is a head. The walk stops at the
// first head of each branch, so a nested instance below another head does
// not surface (it stays nested).
export function getChildHeads(
  objects: WorkspaceObjects,
  id: string,
): WorkspaceShape[] {
  const result: WorkspaceShape[] = [];
  const seen = new Set<string>();
  const visit = (shapeId: string): void => {
    if (seen.has(shapeId)) return;
    seen.add(shapeId);
    const shape = shapeOf(objects, shapeId);
    if (shape === null) return;
    if (isInstanceHead(shape)) {
      result.push(shape);
      return;
    }
    const children = shape.shapes;
    if (!Array.isArray(children)) return;
    for (const childId of children) {
      if (typeof childId === "string") visit(childId);
    }
  };
  visit(id);
  return result;
}

// cfh/get-children-ids-with-self: the shape id followed by every
// descendant, depth-first in the children order (cycle-safe).
export function getChildrenIdsWithSelf(
  objects: WorkspaceObjects,
  id: string,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (shapeId: string): void => {
    if (seen.has(shapeId)) return;
    seen.add(shapeId);
    result.push(shapeId);
    const children = shapeOf(objects, shapeId)?.shapes;
    if (!Array.isArray(children)) return;
    for (const childId of children) {
      if (typeof childId === "string") visit(childId);
    }
  };
  visit(id);
  return result;
}

// cfh/components-nesting-loop?: whether moving `shapeId` below `parentId`
// would put two heads of the same component in one ancestor chain. The
// backend rejects such a move outright; the drop path filters it first so
// the companion mod-obj changes never land without the move.
export function componentsNestingLoop(
  objects: WorkspaceObjects,
  shapeId: string,
  parentId: string,
): boolean {
  const childComponents = new Set<string>();
  for (const id of getChildrenIdsWithSelf(objects, shapeId)) {
    const shape = shapeOf(objects, id);
    const componentId = shape === null ? null : componentIdOf(shape);
    if (componentId !== null) childComponents.add(componentId);
  }
  if (childComponents.size === 0) return false;
  for (const shape of getParentsWithSelf(objects, parentId)) {
    const componentId = componentIdOf(shape);
    if (componentId !== null && childComponents.has(componentId)) return true;
  }
  return false;
}
