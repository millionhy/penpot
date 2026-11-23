// Workspace selection and hover semantics (F9.2). Headless port of the
// rules the CLJS workspace runs between the worker hit-test and the
// component state:
// - frontend/src/app/main/ui/workspace/viewport/hooks.cljs
//   (setup-hover-shapes: query-point, make-sorted-ids and the remove-hover?
//   derivation);
// - frontend/src/app/main/ui/workspace/viewport/actions.cljs (on-click and
//   the area-selection branch of on-pointer-down);
// - frontend/src/app/main/data/workspace/selection.cljs (select-shape,
//   select-shapes, select-shapes-by-current-selrect,
//   handle-area-selection);
// - common/src/app/common/files/helpers.cljc (shape predicates, the parent
//   walks and clean-loops);
// - common/src/app/common/data.cljc (toggle-selection).
//
// The pure functions take the plain objects of lib/workspace and a
// WorkspaceIndex (lib/workspace-index), so vitest exercises every rule
// without the renderer. The z-order sort at the bottom reads the same model;
// the glyph hit test and the innermost-frame walk are injected by the canvas
// as dependencies.
//
// Deviations from the CLJS original, documented:
// - No double-click enter-group/enter-frame: a double click behaves as a
//   plain click (the CLJS cycles the container levels on repeated clicks).
// - No focus mode: the `(or (empty? focus) ...)` hover filter degrades to
//   pass-through (F9.2 has no focus-selected feature).
// - No show-measures? path: remove-measure-xf / measure-hover-shape are not
//   ported (the measures slice arrives with a later workspace slice).
// - The hover-ids drag suppression (transform = :move) is not ported: F9.2
//   has no shape dragging (F9.3).
// - The render-wasm/v1 feature flag around the text glyph filter is always
//   on (this port only runs in the wasm workspace); without an
//   intersect-position-in-shape adapter the filter degrades to "inside the
//   glyphs", i.e. text keeps its plain selrect behaviour.
// - last-selected is not tracked: select-shape's write and the
//   shift-select region expansion arrive with F9.3.
// - get-parents-with-self skips missing entries (the CLJS into keeps the
//   nils).

import { ZERO_UUID } from "@/lib/file-data";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import {
  querySelection,
  type Bounds,
  type Point,
  type WorkspaceIndex,
} from "@/lib/workspace-index";
import { getParentIdsWithIndex } from "@/lib/viewer";

// --- Small helpers ----------------------------------------------------------

function shapeOf(objects: WorkspaceObjects, id: string): WorkspaceShape | null {
  const shape = objects[id];
  return shape === undefined || shape === null ? null : shape;
}

// The cljs truthiness of `^boolean` coercions (nil and false are falsy).
function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

// The ordered-set semantics of d/ordered-set: deduplicate keeping the
// first-occurrence order.
export function orderedUnique(ids: readonly string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// --- Parent walks (helpers.cljc get-parent-id / get-parent-ids / -------)
// hidden-parent? / get-parents-with-self) ------------------------------------

export function getParentId(objects: WorkspaceObjects, id: string): string | null {
  const parentId = shapeOf(objects, id)?.["parent-id"];
  return typeof parentId === "string" ? parentId : null;
}

// The ancestor ids, nearest first (zero included; stops on a missing
// parent or a self-reference).
export function getParentIds(objects: WorkspaceObjects, id: string): string[] {
  const result: string[] = [];
  let current = id;
  for (;;) {
    const parentId = getParentId(objects, current);
    if (parentId === null || parentId === current) return result;
    result.push(parentId);
    current = parentId;
  }
}

export function getParentsWithSelf(objects: WorkspaceObjects, id: string): WorkspaceShape[] {
  const result: WorkspaceShape[] = [];
  const self = shapeOf(objects, id);
  if (self !== null) result.push(self);
  for (const parentId of getParentIds(objects, id)) {
    const parent = shapeOf(objects, parentId);
    if (parent !== null) result.push(parent);
  }
  return result;
}

// Whether any ancestor of the shape carries :hidden. Zero and missing
// links answer false, like the CLJS.
export function hiddenParentQmark(objects: WorkspaceObjects, id: string): boolean {
  let current: string | null = id;
  for (;;) {
    if (current === null || current === ZERO_UUID) return false;
    const parentId = getParentId(objects, current);
    if (parentId === null || parentId === ZERO_UUID) return false;
    if (truthy(shapeOf(objects, parentId)?.["hidden"])) return true;
    current = parentId;
  }
}

// --- Shape predicates (helpers.cljc) ----------------------------------------

export function isFrameShape(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape.type === "frame";
}

export function isGroupShape(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape.type === "group";
}

export function isMaskShape(shape: WorkspaceShape | null): boolean {
  if (shape === null || !isGroupShape(shape)) return false;
  return truthy(shape["masked-group"]);
}

export function isBoolShape(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape.type === "bool";
}

export function isSvgRawShape(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape.type === "svg-raw";
}

export function isTextShape(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape.type === "text";
}

export function hasChildrenQmark(shape: WorkspaceShape | null): boolean {
  return shape !== null && Array.isArray(shape.shapes) && shape.shapes.length > 0;
}

export function isGroupLikeShape(shape: WorkspaceShape | null): boolean {
  return isGroupShape(shape) || isBoolShape(shape) || (isSvgRawShape(shape) && hasChildrenQmark(shape));
}

// root-frame?: a frame sitting directly under zero (not zero itself).
export function isRootFrameShape(shape: WorkspaceShape | null): boolean {
  return (
    shape !== null &&
    shape.id !== ZERO_UUID &&
    shape.type === "frame" &&
    shape["frame-id"] === ZERO_UUID
  );
}

export function isDirectChildOfRoot(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["frame-id"] === ZERO_UUID;
}

export function isInstanceHead(shape: WorkspaceShape | null): boolean {
  if (shape === null) return false;
  return shape["component-id"] !== null && shape["component-id"] !== undefined;
}

export function isMainInstance(shape: WorkspaceShape | null): boolean {
  return shape !== null && shape["main-instance"] === true;
}

// clean-loops: drop the ids that have an ancestor inside the set, so a
// selection never contains a container together with its contents.
export function cleanLoops(objects: WorkspaceObjects, ids: readonly string[]): string[] {
  const unique = orderedUnique(ids);
  if (unique.length < 2) return unique;
  const set = new Set(unique);
  return unique.filter(
    (id) => !getParentIds(objects, id).some((parentId) => set.has(parentId)),
  );
}

// --- Hover (hooks.cljs setup-hover-shapes) ----------------------------------

// query-point: a square centered on the position with a (5 / zoom) half
// size, so the hover ring is a constant screen distance. The side floors
// at 0.01 (make-rect), which only matters above zoom 500.
export function hoverQueryRect(point: Point, zoom: number): Bounds {
  const radius = 5 / zoom;
  return {
    x: point.x - radius,
    y: point.y - radius,
    width: Math.max(radius * 2, 0.01),
    height: Math.max(radius * 2, 0.01),
  };
}

// The raw index query of query-point: include-frames? true, the live
// geometry (using-selrect? false) and clip-children? relaxed while the
// mod key is held (deep selection).
export function queryHoverIds(
  index: WorkspaceIndex,
  point: Point,
  zoom: number,
  mod: boolean,
): string[] {
  return querySelection(index, hoverQueryRect(point, zoom), {
    includeFrames: true,
    clipChildren: !mod,
    usingSelrect: false,
  });
}

export interface HoverStackOptions {
  mod: boolean;
  // The CLJS removes blocked shapes only for editors ((not read-only?));
  // false here, so blocked shapes never hover (F9.2 has no permission
  // model yet).
  readOnly?: boolean;
  // app.common.types.shape-tree/sort-z-index (arity 3). The canvas passes
  // its pure `sortZIndexIds` over the live objects; without one (unit
  // tests) the query order stays.
  sortIds?: (ids: readonly string[], mod: boolean) => string[];
  // The (mod?, ids) cache (sorted-ids-cache in the CLJS): repeated pointer
  // moves over the same shapes skip the z-index sort.
  cache?: HoverIdsCache;
}

export interface HoverIdsCache {
  get(ids: readonly string[], mod: boolean, compute: () => string[]): string[];
  clear(): void;
}

export function createHoverIdsCache(): HoverIdsCache {
  const entries = new Map<string, string[]>();
  return {
    get(ids, mod, compute) {
      const key = `${mod ? "1" : "0"}|${ids.join(",")}`;
      const cached = entries.get(key);
      if (cached !== undefined) return cached;
      const value = compute();
      entries.set(key, value);
      return value;
    },
    clear() {
      entries.clear();
    },
  };
}

// make-sorted-ids: remove hidden-parent/blocked/svg-raw, sort by z-index
// (bottom-frames? while mod is held) and deduplicate keeping the sort
// order. The result is front-most first, so its head is the hover shape.
export function computeHoverStack(
  ids: readonly string[],
  objects: WorkspaceObjects,
  options: HoverStackOptions,
): string[] {
  const compute = (): string[] => {
    // The CLJS runs the filters over the sort output; the filtered-out
    // entries never reach the ordered set.
    const sorted = options.sortIds ? options.sortIds(ids, options.mod) : [...ids];
    const readOnly = options.readOnly ?? false;
    const result: string[] = [];
    const seen = new Set<string>();
    for (const id of sorted) {
      if (seen.has(id)) continue;
      if (hiddenParentQmark(objects, id)) continue;
      const shape = shapeOf(objects, id);
      if (shape === null) continue;
      if (!readOnly && truthy(shape["blocked"])) continue;
      if (isSvgRawShape(shape)) continue;
      seen.add(id);
      result.push(id);
    }
    return result;
  };

  if (options.cache !== undefined) return options.cache.get(ids, options.mod, compute);
  return compute();
}

// The complete hover stack at a position: the index query (over-shapes
// stream in the CLJS) plus the sort/filter chain.
export function hoverStackAt(
  index: WorkspaceIndex,
  objects: WorkspaceObjects,
  point: Point,
  zoom: number,
  options: HoverStackOptions,
): string[] {
  const ids = queryHoverIds(index, point, zoom, options.mod);
  if (ids.length === 0) return [];
  return computeHoverStack(ids, objects, options);
}

export interface HoverShapeOptions {
  mod: boolean;
  selected: readonly string[];
  // app.render-wasm.api/intersect-position-in-shape, bound to the engine
  // module by the canvas. Without one (unit tests) the glyph filter is
  // skipped, the documented selrect fallback.
  intersectPosition?: (id: string, point: Point) => boolean;
}

// The ids that must not become the hover shape (remove-hover? in the
// CLJS): the ancestors of the selection, plus the derived set of the
// current mode.
function hoverRemovalSet(
  stack: readonly string[],
  objects: WorkspaceObjects,
  point: Point,
  options: HoverShapeOptions,
): Set<string> {
  const { mod } = options;
  const selectedSet = new Set(options.selected);
  const remove = new Set<string>();

  // selected-with-parents: the CLJS never hovers a container already
  // covered by the selection outline.
  for (const id of options.selected) {
    for (const parentId of getParentIds(objects, id)) remove.add(parentId);
  }

  if (mod) {
    // Deep-selection mode: groups (group-like, non-mask) step aside so
    // the cursor reaches the inner shapes.
    for (const id of stack) {
      const shape = shapeOf(objects, id);
      if (shape !== null && isGroupLikeShape(shape) && !isMaskShape(shape)) remove.add(id);
    }
    return remove;
  }

  // child-parent?: the ancestors of the stack's non-group shapes. A group
  // stays hittable only while one of those children sits on the stack, so
  // a text-box empty area falls through to the group around it.
  const childParents = new Set<string>();
  for (const id of stack) {
    const shape = shapeOf(objects, id);
    if (shape === null || isGroupShape(shape)) continue;
    for (const parentId of getParentIds(objects, id)) childParents.add(parentId);
  }

  for (const id of stack) {
    const shape = shapeOf(objects, id);
    if (shape === null) continue;
    // A root frame with content never becomes the hover shape.
    const rootFrameWithData =
      isRootFrameShape(shape) &&
      hasChildrenQmark(shape) &&
      !isInstanceHead(shape) &&
      !isMainInstance(shape);
    // A group without a hittable child falls through (see above).
    const groupWithoutChild = isGroupShape(shape) && !childParents.has(id);
    // Text is hittable only right over its rendered glyphs, so clicks
    // pass through the empty parts of the box. Selected text keeps the
    // whole selrect (the CLJS avoids reselecting a container mid
    // double-click).
    const textAwayFromGlyphs =
      isTextShape(shape) &&
      !selectedSet.has(id) &&
      options.intersectPosition !== undefined &&
      !options.intersectPosition(id, point);
    if (rootFrameWithData || groupWithoutChild || textAwayFromGlyphs) remove.add(id);
  }
  return remove;
}

// The hover shape: the first id of the stack that survives remove-hover?
// and the mod-mode frame filter (no-fill nested frames).
export function hoverShapeId(
  stack: readonly string[],
  objects: WorkspaceObjects,
  point: Point,
  options: HoverShapeOptions,
): string | null {
  const remove = hoverRemovalSet(stack, objects, point, options);
  for (const id of stack) {
    if (remove.has(id)) continue;
    const shape = shapeOf(objects, id);
    if (shape === null) continue;
    if (options.mod && isNoFillNestedFrame(shape)) continue;
    return id;
  }
  return null;
}

// no-fill-nested-frames?: a frame that is not a board (direct child of
// zero) and carries no fills; skipped in mod mode.
function isNoFillNestedFrame(shape: WorkspaceShape): boolean {
  const fills = shape["fills"];
  const emptyFills = !Array.isArray(fills) || fills.length === 0;
  return isFrameShape(shape) && !isDirectChildOfRoot(shape) && emptyFills;
}

// --- Click selection (actions.cljs on-click / selection.cljs select-shape) --

// toggle-selection: a plain click replaces the whole selection with the
// shape; the toggle variant (shift-click) adds or removes it keeping the
// previous order.
export function selectionAfterClick(
  selected: readonly string[],
  id: string,
  toggle: boolean,
): string[] {
  if (!toggle) return [id];
  return selected.includes(id)
    ? selected.filter((entry) => entry !== id)
    : [...selected, id];
}

// --- Area selection (selection.cljs select-shapes-by-current-selrect) -------

// The initial-set of handle-area-selection: the append (shift) and remove
// (shift+mod) drags start from the current selection; a plain drag starts
// empty (the CLJS emits deselect-all, which also clears on a plain click
// over the empty canvas, since the marquee never grows past the minimum).
export function areaInitialSelection(
  selected: readonly string[],
  append: boolean,
  remove: boolean,
): string[] {
  return append || remove ? [...selected] : [];
}

export interface AreaSelectionOptions {
  // The shift+mod drag removes the hit shapes from the initial selection.
  remove?: boolean;
  // The mod-only drag (without shift) skips groups and bools.
  ignoreGroups?: boolean;
}

// select-shapes-by-current-selrect: the index query with the marquee flags
// (include-frames? true, full-frame? true, using-selrect? true),
// clean-loops, then either the remove-mode disjunction from the initial
// set or the append of the blocked/hidden-parent-filtered ids. The
// initial members are never re-checked: they were already selected.
export function selectionAfterArea(
  objects: WorkspaceObjects,
  index: WorkspaceIndex,
  rect: Bounds,
  initial: readonly string[],
  options: AreaSelectionOptions = {},
): string[] {
  const ids = querySelection(index, rect, {
    includeFrames: true,
    ignoreGroups: options.ignoreGroups ?? false,
    fullFrame: true,
    usingSelrect: true,
  });
  const cleaned = cleanLoops(objects, ids);

  if (options.remove === true) {
    const removed = new Set(cleaned);
    return initial.filter((id) => !removed.has(id));
  }

  const result = [...initial];
  const seen = new Set(result);
  for (const id of cleaned) {
    const shape = shapeOf(objects, id);
    if (shape === null) continue;
    if (truthy(shape["blocked"])) continue;
    if (hiddenParentQmark(objects, id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

// --- Z-order (shape-tree/sort-z-index arity 3) ------------------------------
//
// The compiled hover chain sorted the ids inside wasm against the CLJS
// objects map; the TS port reads the plain JS model instead. The comparator
// is the CLJS `is-shape-over-shape?`, including the layout z-index branch:
// children of a flex/grid frame paint by `layout-item-z-index`, the rest by
// their sibling position.

type ParentIndex = [string[], Record<string, number>];

function chainOf(
  objects: WorkspaceObjects,
  id: string,
  cache: Map<string, ParentIndex>,
): ParentIndex {
  let chain = cache.get(id);
  if (chain === undefined) {
    chain = getParentIdsWithIndex(objects as never, id);
    cache.set(id, chain);
  }
  return chain;
}

// get-base: the nearest common ancestor and each id's position under it.
function baseOf(
  idA: string,
  chainA: ParentIndex,
  idB: string,
  chainB: ParentIndex,
): [string, number | undefined, number | undefined] {
  const [parentsA, indicesA] = chainA;
  const [parentsB, indicesB] = chainB;
  const setB = new Set<string>([idB, ...parentsB]);
  const baseId = [idA, ...parentsA].find((id) => setB.has(id)) ?? ZERO_UUID;
  return [baseId, indicesA[baseId], indicesB[baseId]];
}

// ctl/any-layout?: a frame under an auto (flex or grid) layout.
function hasAutoLayout(shape: WorkspaceShape | null | undefined): boolean {
  if (shape === null || shape === undefined) return false;
  return isFrameShape(shape) && (shape.layout === "flex" || shape.layout === "grid");
}

// ctl/layout-z-index: the item's explicit z-index inside a layout, 0 default.
function layoutZIndex(shape: WorkspaceShape | null | undefined): number {
  const value = shape?.["layout-item-z-index"];
  return typeof value === "number" ? value : 0;
}

function isShapeOverShape(
  objects: WorkspaceObjects,
  baseShapeId: string,
  overShapeId: string,
  bottomFrames: boolean,
  chains: Map<string, ParentIndex>,
): boolean {
  const [baseId, indexA, indexB] = baseOf(
    baseShapeId,
    chainOf(objects, baseShapeId, chains),
    overShapeId,
    chainOf(objects, overShapeId, chains),
  );

  if (baseId === baseShapeId) {
    return bottomFrames && isFrameShape(objects[baseShapeId] ?? null);
  }
  if (baseId === overShapeId) {
    return !bottomFrames || !isFrameShape(objects[baseId] ?? null);
  }

  const base = objects[baseId];
  if (hasAutoLayout(base)) {
    const children = base?.shapes ?? [];
    const zA = layoutZIndex(indexA === undefined ? null : objects[children[indexA]]);
    const zB = layoutZIndex(indexB === undefined ? null : objects[children[indexB]]);
    if (zA === zB) return (indexA ?? 0) > (indexB ?? 0);
    return zA < zB;
  }
  return (indexA ?? 0) < (indexB ?? 0);
}

// shape-tree/sort-z-index with the `{:bottom-frames? mod}` option of the
// hover chain. The order matches the compiled one: the comparator returns a
// positive value when the first id paints above the second.
export function sortZIndexIds(
  objects: WorkspaceObjects,
  ids: readonly string[],
  bottomFrames = false,
): string[] {
  if (ids.length < 2) return [...ids];
  const chains = new Map<string, ParentIndex>();
  return [...ids].sort((a, b) => {
    if (a === b) return 0;
    return isShapeOverShape(objects, a, b, bottomFrames, chains) ? 1 : -1;
  });
}
