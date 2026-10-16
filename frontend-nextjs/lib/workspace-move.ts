// Workspace move geometry (F9.3): the pure rules behind the move drag —
// the move-set expansion, the per-type translation, the model application
// and the update-file change building (T3), the reparent target
// resolution + mov-objects building (T4) and the post-commit model
// application + wasm geometry slice (T5). Ported from:
// - common/src/app/common/geom/shapes/transforms.cljc (apply-transform /
//   apply-transform-move: points + selrect + x/y/width/height with the
//   position-data and the path-content branches);
// - common/src/app/common/types/path/impl.cljc (impl-transform over the
//   packed 28-byte segments; SEGMENT-U8-SIZE and the 1/2/3/4 type enum);
// - common/src/app/common/buffer.cljc (the little-endian float read/write
//   the packed format uses);
// - common/src/app/common/geom/rect.cljc (points->rect / make-rect: the
//   translated selrect carries x/y/x1/y1/x2/y2; width/height stay);
// - common/src/app/common/types/shape_tree.cljc (get-frames-by-position /
//   sort-z-index-objects / top-nested-frame, clipped-by-ancestor? and the
//   get-base + is-shape-over-shape? z-order comparison);
// - common/src/app/common/geom/shapes/intersect.cljc (has-point?: the
//   fast box / even-odd polygon branches) and app.common.math
//   (almost-zero?);
// - frontend/src/app/main/data/workspace/transforms.cljs
//   (cleanup-invalid-moving-shapes reduced to the non-layout path);
//   common/src/app/common/files/changes_builder.cljc (change-parent: the
//   reversed shapes and the omitted index); common/src/app/common/files/
//   changes.cljc (process-change :mov-objects: the all-shapes validity
//   gate, the append-at-the-end, the previous-parent removal and the
//   update-frame-id rule — frames keep their subtree, other shapes
//   rewrite it).
//
// Only translations reach these functions (the drag emits a plain dx/dy
// vector, AD2/AD4), so the generic flip/rotation machinery of
// apply-transform is not ported: the matrix is always (1,0,0,1,dx,dy) and
// adding dx/dy per component is its exact image.
//
// Deviations from the CLJS original, documented:
// - The move set expands over the JS model (shape.shapes of the
//   lib/workspace objects), not getChildrenIdsWithSelf over the wasm-side
//   cljs snapshot: the snapshot freezes at load and goes stale after the
//   first commit (review R2); the JS model is the interaction truth.
// - The patch carries only the attributes a translation changes (x/y,
//   selrect, points, position-data, content). The CLJS assocs width/height
//   on the generic branch too, but a translation leaves them unchanged and
//   the update-shapes diff drops them again (AD4).
// - The reparent walk drops the layout and component branches of the
//   CLJS: no layout z-index in the frame sort (plain sibling order), no
//   exclude-frames-siblings, no position-absolute cleanup, no
//   in-component-copy cleanup and no find-valid-parent-and-frame-ids
//   navigation. Plain frames over plain shapes take the same path as the
//   original; the richer structures are not reachable from the F9.3 UI.
// - The blocked frames always drop out (the read-only? true path is not
//   ported).

import { ZERO_UUID } from "@/lib/file-data";
import {
  isPathData,
  PathData,
  type UpdateFileModObjChange,
  type UpdateFileMovObjectsChange,
  type UpdateFileSetOperation,
} from "@/lib/transit";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { getParentId, getParentIds, isFrameShape, orderedUnique } from "@/lib/workspace-selection";

// --- Packed path content (types/path/impl.cljc) ------------------------------

// SEGMENT-U8-SIZE: the packed segment stride, in bytes.
const SEGMENT_U8_SIZE = 28;

// The segment-type enum of the packed buffer (impl-walk): the short at
// offset 0. A close-path segment carries no coordinates.
const MOVE_TO = 1;
const LINE_TO = 2;
const CURVE_TO = 3;

// The float slots of a 28-byte segment: the curve handles as x/y pairs at
// 4/8 and 12/16, the endpoint as an x/y pair at 20/24.
const C1X = 4;
const C1Y = 8;
const C2X = 12;
const C2Y = 16;
const END_X = 20;
const END_Y = 24;

// impl-transform over a buffer copy: move/line segments translate their
// endpoint; curve segments their two handles and the endpoint; close
// segments have no coordinates. The floats are little-endian (the packed
// format of app.common.buffer); a trailing partial segment stays untouched,
// like the CLJS size count (floor of bytes / SEGMENT-U8-SIZE).
function translatePathBytes(bytes: Uint8Array, dx: number, dy: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  const count = Math.floor(out.byteLength / SEGMENT_U8_SIZE);
  const shift = (offset: number, delta: number): void => {
    view.setFloat32(offset, view.getFloat32(offset, true) + delta, true);
  };
  for (let index = 0; index < count; index++) {
    const offset = index * SEGMENT_U8_SIZE;
    const type = view.getUint16(offset, true);
    if (type === MOVE_TO || type === LINE_TO) {
      shift(offset + END_X, dx);
      shift(offset + END_Y, dy);
    } else if (type === CURVE_TO) {
      shift(offset + C1X, dx);
      shift(offset + C1Y, dy);
      shift(offset + C2X, dx);
      shift(offset + C2Y, dy);
      shift(offset + END_X, dx);
      shift(offset + END_Y, dy);
    }
  }
  return out;
}

// --- Attribute readers -------------------------------------------------------

export interface Selrect {
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: unknown;
}

export interface PositionItem {
  x: number;
  y: number;
  [key: string]: unknown;
}

function selrectOf(shape: WorkspaceShape): Selrect | null {
  const selrect = shape["selrect"];
  if (selrect === null || typeof selrect !== "object") return null;
  const { x, y, width, height } = selrect as Record<string, unknown>;
  if (
    typeof x !== "number" ||
    typeof y !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return null;
  }
  return selrect as Selrect;
}

function pointsOf(shape: WorkspaceShape): PositionItem[] | null {
  const points = shape["points"];
  if (!Array.isArray(points)) return null;
  const out: PositionItem[] = [];
  for (const point of points as unknown[]) {
    if (point === null || typeof point !== "object") return null;
    const { x, y } = point as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number") return null;
    out.push(point as PositionItem);
  }
  return out;
}

function positionDataOf(shape: WorkspaceShape): PositionItem[] | null {
  const data = shape["position-data"];
  if (!Array.isArray(data)) return null;
  const out: PositionItem[] = [];
  for (const item of data as unknown[]) {
    if (item === null || typeof item !== "object") return null;
    const { x, y } = item as Record<string, unknown>;
    if (typeof x !== "number" || typeof y !== "number") return null;
    out.push(item as PositionItem);
  }
  return out;
}

// The packed content bytes of a path/bool shape; null when the content is
// missing, empty or already in a non-packed representation.
function contentBytesOf(shape: WorkspaceShape): Uint8Array | null {
  const content = shape["content"];
  if (!isPathData(content)) return null;
  return content.bytes;
}

// The translated selrect: x/y/x1/y1/x2/y2 shift, width/height stay; keys
// absent from the original stay absent (partial rects stay partial).
function translateSelrect(selrect: Selrect, dx: number, dy: number): Selrect {
  const out: Selrect = { ...selrect };
  const shiftX = (key: string): void => {
    const value = out[key];
    if (typeof value === "number") out[key] = value + dx;
  };
  const shiftY = (key: string): void => {
    const value = out[key];
    if (typeof value === "number") out[key] = value + dy;
  };
  for (const key of ["x", "x1", "x2"]) shiftX(key);
  for (const key of ["y", "y1", "y2"]) shiftY(key);
  return out;
}

// --- The move set ------------------------------------------------------------

// The ids a drag translates: every selected shape plus the whole subtree of
// every container in it, deduplicated keeping the first-occurrence order
// (the getChildrenIdsWithSelf merge of apply-transform-move). The walk is
// cycle-safe: a malformed self-reference stops instead of looping.
export function resolveMoveSet(
  selection: readonly string[],
  objects: WorkspaceObjects,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const visit = (id: string): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const shape = objects[id];
    if (shape === undefined || shape === null) return;
    result.push(id);
    const children = shape.shapes;
    if (!Array.isArray(children)) return;
    for (const childId of children) {
      if (typeof childId === "string") visit(childId);
    }
  };
  for (const id of selection) visit(id);
  return result;
}

// --- Translation -------------------------------------------------------------

// The update-shapes-style diff of one shape under a translation: only the
// attributes that change (the update-shapes diff of the CLJS would drop
// nothing else).
export type ShapePatch = Record<string, unknown>;

// apply-transform-move, reduced to its translation projection:
// - text: the position-data items shift their x/y (transform-position-data
//   touches no other key);
// - path/bool: the packed content translates (impl-transform) and — like
//   the generic branch below — selrect and points follow;
// - everything else: x/y come from the translated selrect.
export function moveShapePatch(shape: WorkspaceShape, dx: number, dy: number): ShapePatch {
  const patch: ShapePatch = {};
  const type = shape.type;
  const selrect = selrectOf(shape);

  if (type === "text") {
    const data = positionDataOf(shape);
    if (data !== null) {
      patch["position-data"] = data.map((item) => ({ ...item, x: item.x + dx, y: item.y + dy }));
    }
  }

  if (type === "path" || type === "bool") {
    const bytes = contentBytesOf(shape);
    if (bytes !== null) {
      patch["content"] = new PathData(translatePathBytes(bytes, dx, dy));
    }
  } else if (selrect !== null) {
    patch["x"] = selrect.x + dx;
    patch["y"] = selrect.y + dy;
  }

  if (selrect !== null) patch["selrect"] = translateSelrect(selrect, dx, dy);
  const points = pointsOf(shape);
  if (points !== null) {
    patch["points"] = points.map((point) => ({ ...point, x: point.x + dx, y: point.y + dy }));
  }
  return patch;
}

// The moved copy of one shape: the patch applied over the original (the
// CLJS assoc chain); unrelated attributes and the original object stay
// untouched.
export function translateShape(shape: WorkspaceShape, dx: number, dy: number): WorkspaceShape {
  return { ...shape, ...moveShapePatch(shape, dx, dy) };
}

// The moved copy of the objects map: only the move set is replaced; every
// other entry keeps its reference, so untouched shapes stay shared.
export function applyMove(
  objects: WorkspaceObjects,
  moveSet: readonly string[],
  dx: number,
  dy: number,
): WorkspaceObjects {
  if (dx === 0 && dy === 0) return objects;
  const out: WorkspaceObjects = { ...objects };
  for (const id of orderedUnique(moveSet)) {
    const shape = out[id];
    if (shape === undefined || shape === null) continue;
    out[id] = translateShape(shape, dx, dy);
  }
  return out;
}

// --- Change building (T3) -----------------------------------------------------

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

// The per-attribute comparison of update-shapes: a value equal to the one
// already on the shape is dropped from the operations. Numbers compare by
// strict equality (a zero delta component therefore stays home), the
// selrect/points/position-data structures deeply, and two packed contents
// byte-wise — a translation that float-rounds back to the same bytes
// resends nothing.
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (isPathData(a) || isPathData(b)) {
    return isPathData(a) && isPathData(b) && bytesEqual(a.bytes, b.bytes);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((entry, index) => sameValue(entry, b[index]));
  }
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);
    return (
      keys.length === Object.keys(right).length &&
      keys.every((key) => key in right && sameValue(left[key], right[key]))
    );
  }
  return false;
}

// The update-file changes of one move (AD5): one mod-obj per moved shape
// whose patch still differs from the current model, its operations
// carrying only the changed attributes. The val of a content operation
// stays a PathData; lib/transit's encodeUpdateFile tags it on the wire.
export function buildMoveChanges(
  objects: WorkspaceObjects,
  moveSet: readonly string[],
  dx: number,
  dy: number,
  pageId: string,
): UpdateFileModObjChange[] {
  const changes: UpdateFileModObjChange[] = [];
  for (const id of orderedUnique(moveSet)) {
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    const patch = moveShapePatch(shape, dx, dy);
    const operations: UpdateFileSetOperation[] = [];
    for (const attr of Object.keys(patch)) {
      const value = patch[attr];
      if (sameValue(shape[attr], value)) continue;
      operations.push({ type: "set", attr, val: value });
    }
    if (operations.length === 0) continue;
    changes.push({ type: "mod-obj", "page-id": pageId, id, operations });
  }
  return changes;
}

// --- Reparent target resolution (T4) ----------------------------------------

// math.cljc almost-zero?: a rotation below this stays on the fast box
// branch of has-point?.
const ALMOST_ZERO = 1e-4;

// intersect.cljc intersect-ray?: the segment a-b against the horizontal ray
// from the position to the right, with the CLJS half-open crossing rule.
function intersectRay(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): boolean {
  if ((y1 <= py && y2 > py) || (y1 > py && y2 <= py)) {
    const vt = (py - y1) / (y2 - y1);
    const ix = x1 + vt * (x2 - x1);
    return px < ix;
  }
  return false;
}

// intersect.cljc slow-has-point?: the even-odd test over the closed polygon
// of the shape points (points->lines closes the loop).
function polygonHasPoint(points: readonly PositionItem[], x: number, y: number): boolean {
  let crossings = 0;
  for (let index = 0; index < points.length; index += 1) {
    const from = points[index];
    const to = points[(index + 1) % points.length];
    if (intersectRay(x, y, from.x, from.y, to.x, to.y)) crossings += 1;
  }
  return crossings % 2 === 1;
}

// intersect.cljc has-point?: the fast axis-aligned box (closed bounds) for
// unrotated shapes, the even-odd polygon otherwise. Frames are never
// path/bool/circle, so only the rotation decides the branch here.
function hasPoint(shape: WorkspaceShape, x: number, y: number): boolean {
  const rotation = shape["rotation"];
  if (typeof rotation === "number" && !(Math.abs(rotation) < ALMOST_ZERO)) {
    const points = pointsOf(shape);
    return points !== null && polygonHasPoint(points, x, y);
  }
  const sx = shape["x"];
  const sy = shape["y"];
  const width = shape["width"];
  const height = shape["height"];
  if (
    typeof sx !== "number" ||
    typeof sy !== "number" ||
    typeof width !== "number" ||
    typeof height !== "number"
  ) {
    return false;
  }
  return x >= sx && x <= sx + width && y >= sy && y <= sy + height;
}

// shape_tree.cljc clipped-by-ancestor?: a non-root frame ancestor with the
// content-hide flag (show-content not truthy) that does not contain the
// position clips its subtree away for hit testing.
function clippedByAncestor(
  objects: WorkspaceObjects,
  shapeId: string,
  x: number,
  y: number,
): boolean {
  for (const ancestorId of getParentIds(objects, shapeId)) {
    if (ancestorId === ZERO_UUID) continue;
    const ancestor = objects[ancestorId];
    if (ancestor === undefined || ancestor === null || !isFrameShape(ancestor)) continue;
    const showContent = ancestor["show-content"];
    const hides = showContent === null || showContent === undefined || showContent === false;
    if (hides && !hasPoint(ancestor, x, y)) return true;
  }
  return false;
}

// --- Z-order comparison (shape_tree.cljc get-base / is-shape-over-shape?) ---

interface ParentChain {
  // Ancestor ids, nearest first (zero included).
  parents: string[];
  // parent-id -> position of the child within that parent.
  indices: Map<string, number>;
}

// helpers.cljc get-parent-ids-with-index over the JS model, cycle-safe.
function parentChainOf(objects: WorkspaceObjects, id: string): ParentChain {
  const parents: string[] = [];
  const indices = new Map<string, number>();
  const seen = new Set<string>([id]);
  let current = id;
  for (;;) {
    const parentId = getParentId(objects, current);
    if (parentId === null || parentId === current || seen.has(parentId)) break;
    const parent = objects[parentId];
    if (parent === undefined || parent === null) break;
    parents.push(parentId);
    seen.add(parentId);
    const children = parent.shapes;
    indices.set(parentId, Array.isArray(children) ? children.indexOf(current) : -1);
    current = parentId;
  }
  return { parents, indices };
}

// get-base: the nearest common ancestor of the two chains (zero when none)
// and each id's position under it.
function baseOf(
  idA: string,
  chainA: ParentChain,
  idB: string,
  chainB: ParentChain,
): [string, number, number] {
  const parentsA = [idA, ...chainA.parents];
  const parentsB = new Set<string>([idB, ...chainB.parents]);
  let baseId = ZERO_UUID;
  for (const candidate of parentsA) {
    if (parentsB.has(candidate)) {
      baseId = candidate;
      break;
    }
  }
  return [baseId, chainA.indices.get(baseId) ?? -1, chainB.indices.get(baseId) ?? -1];
}

// is-shape-over-shape? with bottom-frames? false: true when idA paints
// below idB. A shared parent compares the sibling positions; the layout
// z-index branch of the original stays out (no layout support in F9.3).
function isBelow(idA: string, chainA: ParentChain, idB: string, chainB: ParentChain): boolean {
  const [baseId, indexA, indexB] = baseOf(idA, chainA, idB, chainB);
  if (baseId === idA) return false;
  if (baseId === idB) return true;
  return indexA < indexB;
}

// sort-z-index-objects: ascending over the comparator below leaves the
// top-most frame first (the walk of top-nested-frame starts there).
function sortFramesTopFirst(
  objects: WorkspaceObjects,
  frames: WorkspaceShape[],
): WorkspaceShape[] {
  const chains = new Map<string, ParentChain>();
  const chainOf = (id: string): ParentChain => {
    let chain = chains.get(id);
    if (chain === undefined) {
      chain = parentChainOf(objects, id);
      chains.set(id, chain);
    }
    return chain;
  };
  return frames.sort((a, b) => {
    if (a.id === b.id) return 0;
    return isBelow(a.id, chainOf(a.id), b.id, chainOf(b.id)) ? 1 : -1;
  });
}

// shape_tree.cljc get-frames-by-position + top-nested-frame: the deepest
// frame under the position. Every hit is sorted top-first, the frames of
// a live move and the hidden/blocked ones drop out (the read-only? false
// path), and the walk descends the child chain of the top-most survivor
// to its deepest hit. Returns the frame id, or ZERO_UUID when nothing
// hits (the root frame of the CLJS).
export function topNestedFrameAt(
  objects: WorkspaceObjects,
  position: { x: number; y: number },
  excluded: ReadonlySet<string> = new Set<string>(),
): string {
  const frames = sortFramesTopFirst(
    objects,
    Object.values(objects).filter(
      (shape) =>
        shape !== null &&
        shape !== undefined &&
        isFrameShape(shape) &&
        shape.id !== ZERO_UUID &&
        hasPoint(shape, position.x, position.y) &&
        !clippedByAncestor(objects, shape.id, position.x, position.y),
    ),
  );
  const hits = frames.filter(
    (frame) => !excluded.has(frame.id) && frame["hidden"] !== true && frame["blocked"] !== true,
  );
  const frameSet = new Set(hits.map((frame) => frame.id));
  let current: WorkspaceShape | undefined = hits[0];
  for (;;) {
    if (current === undefined) return ZERO_UUID;
    let childId: string | null = null;
    const children: string[] | undefined = current.shapes;
    if (Array.isArray(children)) {
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const candidate: unknown = children[index];
        if (typeof candidate === "string" && frameSet.has(candidate)) {
          childId = candidate;
          break;
        }
      }
    }
    if (childId === null) return current.id;
    const child: WorkspaceShape | undefined = objects[childId];
    current = child === undefined || child === null ? undefined : child;
  }
}

// --- Reparent change building (T4) ------------------------------------------

// transforms.cljs cleanup-invalid-moving-shapes reduced to the F9.3 path
// (no components, no layouts): the selection-level ids lose every id whose
// ancestor is also in the set (clean-loops), and the shapes already owned
// by the target frame drop out (the non-layout frame-id branch).
export function reparentRoots(
  objects: WorkspaceObjects,
  selection: readonly string[],
  targetFrameId: string,
): string[] {
  const roots = orderedUnique(selection);
  const rootSet = new Set(roots);
  const result: string[] = [];
  for (const id of roots) {
    const shape = objects[id];
    if (shape === undefined || shape === null) continue;
    if (getParentIds(objects, id).some((parentId) => rootSet.has(parentId))) continue;
    if (shape["frame-id"] === targetFrameId) continue;
    result.push(id);
  }
  return result;
}

// changes_builder.cljc change-parent: {:type :mov-objects :page-id ..
// :parent-id .. :shapes [<reversed ids>]} with no index (append at the
// tail) and ZERO_UUID as the root frame. Null when the cleanup leaves
// nothing to move.
export function buildReparentChange(
  objects: WorkspaceObjects,
  selection: readonly string[],
  targetFrameId: string,
  pageId: string,
): UpdateFileMovObjectsChange | null {
  const roots = reparentRoots(objects, selection, targetFrameId);
  if (roots.length === 0) return null;
  return {
    type: "mov-objects",
    "page-id": pageId,
    "parent-id": targetFrameId,
    shapes: roots.slice().reverse(),
  };
}

// --- Model application (T5) ---------------------------------------------------

// True when `targetId` is `rootId` itself or anywhere in its subtree (the
// invalid-targets set of the backend's is-valid-move?).
function subtreeHas(objects: WorkspaceObjects, rootId: string, targetId: string): boolean {
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const id = stack.pop() as string;
    if (seen.has(id)) continue;
    seen.add(id);
    if (id === targetId) return true;
    const children = objects[id]?.shapes;
    if (!Array.isArray(children)) continue;
    for (const childId of children) {
      if (typeof childId === "string") stack.push(childId);
    }
  }
  return false;
}

// The update-frame-id of the backend: the moved root takes the new
// frame-id; a moved frame keeps its subtree (its children already point
// at it) while any other shape rewrites the whole subtree. Cycle-safe:
// the backend does not guard, a malformed tree must not hang the shell.
function setFrameIdDeep(
  objects: WorkspaceObjects,
  id: string,
  frameId: string,
  seen: Set<string>,
): void {
  if (seen.has(id)) return;
  seen.add(id);
  const shape = objects[id];
  if (shape === undefined || shape === null) return;
  objects[id] = { ...shape, "frame-id": frameId };
  if (isFrameShape(shape)) return;
  const children = shape.shapes;
  if (!Array.isArray(children)) return;
  for (const childId of children) {
    if (typeof childId === "string") setFrameIdDeep(objects, childId, frameId, seen);
  }
}

// The mov-objects effect over the JS model: the commit replaces
// objectsRef/indexRef/store.objects with this result (AD9) so the next
// gesture resolves targets against the committed state. Mirrors
// process-change :mov-objects: the same `objects` reference comes back
// when the backend would skip the change entirely (no shapes, a missing
// root or target, or a root whose subtree contains the target — the
// all-shapes validity gate), otherwise: append to the new parent, set
// parent-id, detach from the previous parent (skipped when unchanged)
// and rewrite the frame-id. `roots` is the change's shape list; the
// upstream alignment (reparentRoots) keeps it free of nesting and of
// current-parent duplicates.
export function applyReparent(
  objects: WorkspaceObjects,
  roots: readonly string[],
  targetFrameId: string,
): WorkspaceObjects {
  if (roots.length === 0) return objects;
  const parent = objects[targetFrameId];
  if (parent === undefined || parent === null) return objects;
  for (const rootId of roots) {
    const root = objects[rootId];
    if (root === undefined || root === null) return objects;
    if (subtreeHas(objects, rootId, targetFrameId)) return objects;
  }
  // frame-id = (if (frame-shape? parent) (:id parent) (:frame-id parent)).
  const newFrameId = isFrameShape(parent)
    ? targetFrameId
    : typeof parent["frame-id"] === "string"
      ? (parent["frame-id"] as string)
      : ZERO_UUID;
  const next: WorkspaceObjects = { ...objects };
  // add-to-parent: append-at-the-end over the target children.
  const targetChildren = parent.shapes;
  next[targetFrameId] = {
    ...parent,
    shapes: Array.isArray(targetChildren) ? [...targetChildren, ...roots] : [...roots],
  };
  for (const rootId of roots) {
    const original = objects[rootId];
    // update-parent-id.
    const current = next[rootId] ?? original;
    next[rootId] = { ...current, "parent-id": targetFrameId };
    // remove-from-old-parent, skipped when the parent does not change
    // (the CLJS reads the previous parent from the pre-change snapshot).
    const oldParentId = original["parent-id"];
    if (typeof oldParentId === "string" && oldParentId !== targetFrameId) {
      const oldParent = next[oldParentId];
      if (oldParent !== undefined && oldParent !== null && Array.isArray(oldParent.shapes)) {
        next[oldParentId] = {
          ...oldParent,
          shapes: oldParent.shapes.filter((childId) => childId !== rootId),
        };
      }
    }
    // update-frame-id: the root and, unless it is a frame, its subtree.
    setFrameIdDeep(next, rootId, newFrameId, new Set<string>());
  }
  return next;
}

// --- Wasm geometry slice (T5) -------------------------------------------------

// The selrect + path content of one moved shape, shaped for the post-commit
// push of lib/render-wasm/modifiers (AD7, pushShapeGeometry). The selrect
// prefers the x1/y1/x2/y2 corners and falls back to x/y + width/height;
// path/bool shapes carry their translated packed content.
export interface MovedGeometry {
  selrect: { x1: number; y1: number; x2: number; y2: number };
  pathContent?: Uint8Array;
}

export function movedGeometry(
  shape: WorkspaceShape,
  dx: number,
  dy: number,
): MovedGeometry | null {
  const selrect = selrectOf(shape);
  if (selrect === null) return null;
  const moved = translateSelrect(selrect, dx, dy);
  const numberOr = (value: unknown, fallback: number): number =>
    typeof value === "number" ? value : fallback;
  const x = numberOr(moved.x, 0);
  const y = numberOr(moved.y, 0);
  const x1 = numberOr(moved.x1, x);
  const y1 = numberOr(moved.y1, y);
  const x2 = numberOr(moved.x2, x + numberOr(moved.width, 0));
  const y2 = numberOr(moved.y2, y + numberOr(moved.height, 0));
  const geometry: MovedGeometry = { selrect: { x1, y1, x2, y2 } };
  if (shape.type === "path" || shape.type === "bool") {
    const bytes = contentBytesOf(shape);
    if (bytes !== null) geometry.pathContent = translatePathBytes(bytes, dx, dy);
  }
  return geometry;
}
