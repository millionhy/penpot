// The geometry segment of the workspace style panel (F9.9): the x/y, width,
// height and rotation values the panel shows, and the one transform a
// committed edit becomes.
//
// Ported from:
// - frontend/src/app/main/data/workspace.cljs (update-dimensions,
//   update-positions, increase-rotation);
// - frontend/src/app/main/ui/workspace/sidebar/options/menus/measures.cljs
//   (the values block: the origin is the top-left of the points bounding box,
//   the size comes from the selrect, the rotation is the stored attr).
//
// The edit is expressed as a world matrix over the existing shape, so the
// attrs it writes are exactly the ones a resize/rotate gesture writes:
// selrect, points, transform, transform-inverse, rotation, x/y/width/height
// (or the packed path content). The caller sends the resulting mod-obj
// through the shared write path and hands the new record to wasm.
//
// Deviations from the CLJS original, documented (AD12):
// - Only the single-selection path exists, like the rest of the panel: the
//   mixed-value editing of a multi selection is a later slice.
// - The segment is hidden for text and svg-raw (is-transformable-shape):
//   their position-data is not recomputed here, and writing the raw geometry
//   would make the canvas disagree with the model.
// - The flex rules (position disabled inside a non-absolute flex child,
//   width/height disabled for auto/fill sizing) land with the layout
//   segment, not here.
// - No proportion-lock toggle, frame presets, orientation switch or
//   fit-content: those need the layout and text layers.

import type { UpdateFileModObjChange } from "@/lib/transit";
import type { WorkspaceShape } from "@/lib/workspace";
import { buildStyleChange } from "@/lib/workspace-style";
import {
  IDENTITY_MATRIX,
  applyTransformToShape,
  isTransformableShape,
  multiplyMatrix,
  rotationMatrix,
  scaleMatrix,
  transformShapePatch,
  translationMatrix,
  type GeometryRect,
  type Matrix6,
  type Point,
} from "@/lib/workspace-transform";

// The panel minimum of the CLJS size inputs (min 0.01).
export const MIN_SIZE = 0.01;

// Float noise below this does not count as a change: a field that keeps its
// displayed value must not send a commit.
const EPSILON = 1e-6;

export interface ShapeGeometry {
  // The painted origin: the top-left of the points bounding box, like
  // grc/points->rect in the measures menu.
  x: number;
  y: number;
  // The untransformed size (the selrect keeps the size before rotation).
  width: number;
  height: number;
  rotation: number;
}

export interface GeometryTarget {
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  rotation?: number;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function numberAt(record: Record<string, unknown>, key: string): number | null {
  const value = record[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

// The stored selrect with its derived edges, or null when the shape has none
// (a shape the renderer cannot place).
export function selrectOf(shape: WorkspaceShape): GeometryRect | null {
  const record = recordOf(shape["selrect"]);
  if (record === null) return null;
  const x = numberAt(record, "x");
  const y = numberAt(record, "y");
  const width = numberAt(record, "width");
  const height = numberAt(record, "height");
  if (x === null || y === null || width === null || height === null) return null;
  return { x, y, width, height, x1: x, y1: y, x2: x + width, y2: y + height };
}

// The four stored points, or the selrect corners when the shape carries none.
function pointsOf(shape: WorkspaceShape, selrect: GeometryRect): Point[] {
  const points = shape["points"];
  if (Array.isArray(points) && points.length >= 4) {
    const out: Point[] = [];
    for (const item of points) {
      const record = recordOf(item);
      if (record === null) break;
      const x = numberAt(record, "x");
      const y = numberAt(record, "y");
      if (x === null || y === null) break;
      out.push({ x, y });
    }
    if (out.length >= 4) return out;
  }
  return [
    { x: selrect.x, y: selrect.y },
    { x: selrect.x + selrect.width, y: selrect.y },
    { x: selrect.x + selrect.width, y: selrect.y + selrect.height },
    { x: selrect.x, y: selrect.y + selrect.height },
  ];
}

function boundsOf(points: readonly Point[]): { x: number; y: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const point of points) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
  }
  return { x: minX, y: minY };
}

// The values the panel renders. Null when the shape has no selrect, which
// also hides the segment (nothing to scale or rotate around).
export function geometryOf(shape: WorkspaceShape): ShapeGeometry | null {
  const selrect = selrectOf(shape);
  if (selrect === null) return null;
  const bounds = boundsOf(pointsOf(shape, selrect));
  return {
    x: roundTo(bounds.x),
    y: roundTo(bounds.y),
    width: roundTo(selrect.width),
    height: roundTo(selrect.height),
    rotation: roundTo(typeof shape["rotation"] === "number" ? shape["rotation"] : 0),
  };
}

// Whether the panel may edit the geometry: the same gate the transform
// handles use (a blocked shape or a type whose geometry this slice cannot
// rewrite stays read-only).
export function geometryEditable(shape: WorkspaceShape): boolean {
  return isTransformableShape(shape) && selrectOf(shape) !== null;
}

// The two-decimal show of the CLJS inputs (fixed-decimal-value with the
// default 2); the stored value keeps full precision.
function roundTo(value: number): number {
  return Math.round(value * 100) / 100;
}

// mod 360 into the -180..180 range, the CLJS normalize-rotation of the
// rotation input.
function normalizeDegrees(value: number): number {
  const mod = ((value % 360) + 360) % 360;
  return mod > 180 ? mod - 360 : mod;
}

function changed(a: number, b: number): boolean {
  return Math.abs(a - b) > EPSILON;
}

// The matrix and rotation delta one panel edit becomes. The steps run in the
// panel order: rotation around the selection center, size around the selrect
// top-left (the origin the x/y fields show), then a translation that lands
// the painted origin on the requested x/y. Null when the shape cannot be
// edited or a step has no geometry to work with.
//
// The commit path reads the matrix directly (the resize spreads it to the
// subtree, see lib/workspace-constraints.ts); buildGeometryChange keeps the
// mod-obj built from it.
export interface GeometryTransform {
  matrix: Matrix6;
  rotationDelta: number;
}

export function geometryTransform(
  shape: WorkspaceShape,
  target: GeometryTarget,
): GeometryTransform | null {
  const current = geometryOf(shape);
  const selrect = selrectOf(shape);
  if (current === null || selrect === null || !isTransformableShape(shape)) return null;

  let matrix: Matrix6 = IDENTITY_MATRIX;
  let rotationDelta = 0;

  const rotation =
    typeof target.rotation === "number" && Number.isFinite(target.rotation)
      ? target.rotation
      : current.rotation;
  if (changed(rotation, current.rotation)) {
    rotationDelta = normalizeDegrees(rotation - current.rotation);
    if (changed(rotationDelta, 0)) {
      const center: Point = {
        x: selrect.x + selrect.width / 2,
        y: selrect.y + selrect.height / 2,
      };
      matrix = multiplyMatrix(
        multiplyMatrix(translationMatrix(center.x, center.y), rotationMatrix(rotationDelta)),
        translationMatrix(-center.x, -center.y),
      );
    }
  }

  const width =
    typeof target.width === "number" && Number.isFinite(target.width)
      ? Math.max(target.width, MIN_SIZE)
      : current.width;
  const height =
    typeof target.height === "number" && Number.isFinite(target.height)
      ? Math.max(target.height, MIN_SIZE)
      : current.height;
  const scaleX = width / current.width;
  const scaleY = height / current.height;
  if (changed(scaleX, 1) || changed(scaleY, 1)) {
    // change-dimensions-modifiers keeps the first point: the scale runs in
    // world axes around the rotated top-left corner.
    const origin = pointsOf(shape, selrect)[0];
    matrix = multiplyMatrix(
      multiplyMatrix(
        multiplyMatrix(translationMatrix(origin.x, origin.y), scaleMatrix(scaleX, scaleY)),
        translationMatrix(-origin.x, -origin.y),
      ),
      matrix,
    );
  }

  const wantX = typeof target.x === "number" && Number.isFinite(target.x) ? target.x : null;
  const wantY = typeof target.y === "number" && Number.isFinite(target.y) ? target.y : null;
  if (wantX !== null || wantY !== null) {
    const moved = geometryOf(applyTransformToShape(shape, matrix, rotationDelta));
    if (moved === null) return null;
    const dx = wantX === null ? 0 : wantX - moved.x;
    const dy = wantY === null ? 0 : wantY - moved.y;
    if (changed(dx, 0) || changed(dy, 0)) {
      matrix = multiplyMatrix(translationMatrix(dx, dy), matrix);
    }
  }

  return { matrix, rotationDelta };
}

// One mod-obj for a geometry edit, or null when nothing would change (a
// re-typed value, a missing selrect, a non-transformable shape).
export function buildGeometryChange(
  shape: WorkspaceShape,
  target: GeometryTarget,
  pageId: string,
): UpdateFileModObjChange | null {
  const gesture = geometryTransform(shape, target);
  if (gesture === null) return null;
  const patch = transformShapePatch(shape, gesture.matrix, gesture.rotationDelta);
  if (Object.keys(patch).length === 0) return null;
  return buildStyleChange(shape.id, pageId, patch);
}
