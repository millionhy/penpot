// Workspace drawing geometry (F9.5): the pure model behind the box tools.
// Ported from:
// - frontend/src/app/main/data/workspace/drawing/box.cljs (adjust-ratio,
//   the 10-screen-pixel threshold of handle-drawing, the initial shape of
//   setup-shape and the parent resolution through top-nested-frame +
//   get-first-valid-parent);
// - frontend/src/app/main/data/workspace/drawing/common.cljs
//   (click-draw-box: a 100 x 100 rect centered on the press point);
// - common/src/app/common/types/shape.cljc (setup-shape: the minimal attrs
//   per type, the selrect/points of setup-rect and the proportions);
// - common/src/app/common/types/shape_tree.cljc (add-shape: the append, the
//   id/parent-id/frame-id overrides and the missing-parent normalization);
// - common/src/app/common/types/container.cljc
//   (get-first-valid-parent) and component.cljc (in-component-copy?,
//   is-variant-container?).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
//
// Deviations from the CLJS original, documented:
// - No snap points, pixel grid or grow-type: the drag follows the raw world
//   point and the shape keeps the setup-shape defaults.
// - No layout drop-index/drop-cell: new shapes always append to the parent
//   (F9.5 AD12.11).
// - No frame absorption of the shapes already inside the new frame
//   (move-shapes-into-frame); that is a later slice (F9.5 AD12.2).

import { ZERO_UUID } from "@/lib/file-data";
import { IDENTITY_TRANSFORM, type WorkspaceDrawTool } from "@/lib/workspace";
import type { WorkspaceObjects, WorkspaceShape } from "@/lib/workspace";
import { insertChildren } from "@/lib/workspace-order";
import {
  TEXT_DEFAULT_ATTRS,
  TEXT_DEFAULT_FILLS,
  type TextGrowType,
} from "@/lib/workspace-text";

// The minimum drag, in screen pixels, before the preview starts
// (handle-drawing: (> (* (distance point initial) zoom) 10)).
const DRAW_THRESHOLD = 10;

// grc/make-rect clamps both sides to 0.01.
const MIN_SIZE = 0.01;

// click-draw-box: the default width/height of a click draw.
const CLICK_DRAW_SIZE = 100;

// shape/attrs.cljc default-color (colors.cljc gray-20) and clr/white.
const DEFAULT_FILL = "#B1B2B5";
const FRAME_FILL = "#FFFFFF";

export interface DrawRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface DrawPoint {
  x: number;
  y: number;
}

export interface DrawModifiers {
  // Shift: keep a square (adjust-ratio).
  square: boolean;
  // Alt: mirror the end point about the origin.
  center: boolean;
}

// mth/sign: zero keeps its sign of zero, i.e. 0.
function sign(value: number): number {
  if (value > 0) return 1;
  if (value < 0) return -1;
  return 0;
}

// box.cljs adjust-ratio: widen the shorter axis to the longer one, keeping
// the direction of the shorter delta. A zero delta stays zero (sign(0) = 0).
// The CLJS reads the vector as (gpt/to-vec point initial), i.e. initial -
// point, which flips both signs.
function adjustRatio(point: DrawPoint, origin: DrawPoint): DrawPoint {
  const dx = Math.abs(origin.x - point.x);
  const dy = Math.abs(origin.y - point.y);
  const sx = sign(origin.x - point.x);
  const sy = sign(origin.y - point.y);
  if (dx > dy) return { x: point.x, y: point.y - sy * (dx - dy) };
  if (dy > dx) return { x: point.x - sx * (dy - dx), y: point.y };
  return { x: point.x, y: point.y };
}

// grc/make-rect over two points: positive sides, 0.01 floor.
function makeRect(p1: DrawPoint, p2: DrawPoint): DrawRect {
  const x1 = Math.min(p1.x, p2.x);
  const y1 = Math.min(p1.y, p2.y);
  const x2 = Math.max(p1.x, p2.x);
  const y2 = Math.max(p1.y, p2.y);
  return {
    x: x1,
    y: y1,
    width: Math.max(x2 - x1, MIN_SIZE),
    height: Math.max(y2 - y1, MIN_SIZE),
  };
}

// The live draw rect: null while the pointer has not moved more than 10
// screen pixels from the press point. `square` is Shift (adjust-ratio),
// `center` is Alt (the press point becomes the center, so the opposite
// corner mirrors the end point about it).
export function drawRectFromPoints(
  origin: DrawPoint,
  point: DrawPoint,
  zoom: number,
  modifiers: DrawModifiers,
): DrawRect | null {
  const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
  if (!(distance * zoom > DRAW_THRESHOLD)) return null;
  const end = modifiers.square ? adjustRatio(point, origin) : point;
  const start = modifiers.center
    ? { x: 2 * origin.x - end.x, y: 2 * origin.y - end.y }
    : origin;
  return makeRect(start, end);
}

// common.cljs click-draw-box: a 100 x 100 rect centered on the press point.
export function clickDrawRect(center: DrawPoint): DrawRect {
  return {
    x: center.x - CLICK_DRAW_SIZE / 2,
    y: center.y - CLICK_DRAW_SIZE / 2,
    width: CLICK_DRAW_SIZE,
    height: CLICK_DRAW_SIZE,
  };
}

// ctk/in-component-copy? / ctk/is-variant-container? use CLJS truthiness.
function truthy(value: unknown): boolean {
  return value !== null && value !== undefined && value !== false;
}

// ctn/get-first-valid-parent: climb out of component copies (a shape-ref)
// and variant containers so a draw never alters an instance structure.
// Answers null when the chain leaves the objects map (or on a cycle).
export function firstValidParent(
  objects: WorkspaceObjects,
  id: string,
): WorkspaceShape | null {
  const seen = new Set<string>();
  let current = id;
  for (;;) {
    if (seen.has(current)) return null;
    seen.add(current);
    const shape = objects[current];
    if (shape === undefined || shape === null) return null;
    if (!truthy(shape["shape-ref"]) && !truthy(shape["is-variant-container"])) return shape;
    const parentId = shape["parent-id"];
    if (typeof parentId !== "string") return null;
    current = parentId;
  }
}

// cts/setup-shape over a draw rect: the minimal attrs of the type, the
// geometry of setup-rect and the constant proportions. The matrices are
// {a..f} maps (F9.5 AD3), never arrays. A text draw passes the grow-type the
// CLJS handle-finish-drawing picks: auto-width for a click, fixed for a
// dragged box.
export function createDrawShape(
  tool: WorkspaceDrawTool,
  rect: DrawRect,
  parentId: string,
  id: string,
  growType: TextGrowType = "fixed",
): WorkspaceShape {
  const type = tool === "ellipse" ? "circle" : tool;
  const name =
    tool === "frame"
      ? "Board"
      : tool === "rect"
        ? "Rectangle"
        : tool === "text"
          ? "Text"
          : "Ellipse";
  const x2 = rect.x + rect.width;
  const y2 = rect.y + rect.height;
  const shape: WorkspaceShape = {
    id,
    type,
    name,
    "parent-id": parentId,
    "frame-id": parentId,
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
      x2,
      y2,
    },
    points: [
      { x: rect.x, y: rect.y },
      { x: x2, y: rect.y },
      { x: x2, y: y2 },
      { x: rect.x, y: y2 },
    ],
    transform: { ...IDENTITY_TRANSFORM },
    "transform-inverse": { ...IDENTITY_TRANSFORM },
    rotation: 0,
    proportion: 1,
    "proportion-lock": false,
    fills:
      tool === "text"
        ? TEXT_DEFAULT_FILLS.map((fill) => ({ ...fill }))
        : [{ "fill-color": tool === "frame" ? FRAME_FILL : DEFAULT_FILL, "fill-opacity": 1 }],
    strokes: [],
  };

  if (tool === "text") {
    return { ...shape, ...TEXT_DEFAULT_ATTRS, "grow-type": growType };
  }

  if (tool === "frame") {
    return {
      ...shape,
      shapes: [],
      "hide-fill-on-export": false,
      "hide-in-viewer": parentId !== ZERO_UUID,
      r1: 0,
      r2: 0,
      r3: 0,
      r4: 0,
    };
  }

  if (tool === "rect") return { ...shape, r1: 0, r2: 0, r3: 0, r4: 0 };
  return shape;
}

// shape_tree.cljc add-shape over the JS model: the shape takes the change
// id, the normalized parent/frame ids and joins the parent's children. A
// missing parent normalizes to the root (uuid/zero), like the backend. A
// missing index appends at the tail; an index follows the insert-at-index
// rule of the CLJS (0 is the bottom). The input objects map and every
// untouched shape stay shared.
export function applyAddShape(
  objects: WorkspaceObjects,
  shape: WorkspaceShape,
  parentId: string,
  index?: number,
): WorkspaceObjects {
  const parent = objects[parentId];
  const resolvedParentId = parent === undefined || parent === null ? ZERO_UUID : parentId;
  const next: WorkspaceObjects = { ...objects };
  next[shape.id] = {
    ...shape,
    id: shape.id,
    "parent-id": resolvedParentId,
    "frame-id": resolvedParentId,
  };
  const resolvedParent = next[resolvedParentId];
  if (resolvedParent !== undefined && resolvedParent !== null) {
    const children = resolvedParent.shapes;
    const list = Array.isArray(children) ? children : [];
    if (!list.includes(shape.id)) {
      next[resolvedParentId] = {
        ...resolvedParent,
        shapes:
          typeof index === "number"
            ? insertChildren(list, index, [shape.id])
            : [...list, shape.id],
      };
    }
  }
  return next;
}
