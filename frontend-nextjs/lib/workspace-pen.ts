// The pen tool (第3项): the click-by-click path builder of
// data/workspace/path/drawing.cljs.
//
// Ported from:
// - frontend/src/app/main/data/workspace/path/drawing.cljs (start-edition,
//   add-node, close-path-drag-start, finish-path, handle-drawing-end and
//   clean-drawn-content);
// - frontend/src/app/main/data/workspace/path/helpers.cljs (append-node,
//   position-fixed-angle);
// - common/src/app/common/types/path/segment.cljc (next-node, append-segment)
//   and path.cljc (points->content, update-geometry);
// - common/src/app/common/types/shape.cljc (setup-path and
//   minimal-path-attrs: no fills, a 1px centered black stroke).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
//
// Deviations from the CLJS original, documented:
// - The draft keeps explicit in/out handles per node (absolute world points)
//   instead of the CLJS prev-handler chain. A press that drags sets the
//   outgoing handle of the new node to the drag point and mirrors it into
//   the incoming one; a plain click leaves both null and the next segment is
//   a straight line-to. The CLJS models the same gesture with one handler
//   and reconstructs the other, so the drawn geometry matches.
// - Shift snaps the handle and the rubber band to 15 degrees around the
//   node (position-fixed-angle); the CLJS also snaps the insert point, which
//   this port does not.
// - A closing node is emitted as a segment back to the first node followed
//   by close-path: the packed close-path carries no coordinates, so the
//   drawn geometry of a curve closing segment comes from the explicit
//   segment before it.

import { PathData, type PathSegmentSpec } from "@/lib/transit";
import { IDENTITY_TRANSFORM, type WorkspaceShape } from "@/lib/workspace";
import type { DrawPoint } from "@/lib/workspace-draw";
import {
  contentRect,
  rectPoints,
  segmentsToSvgPath,
} from "@/lib/workspace-path";

// drawing.cljs draw-insert-threshold, in screen pixels: a press closer than
// this to the previous node reuses it instead of adding a new one. The
// canvas divides by the zoom before comparing world points.
export const PEN_INSERT_THRESHOLD = 16;

// The closing target of close-path-drag-start, in screen pixels: a press on
// the first node closes the draft.
export const PEN_CLOSE_THRESHOLD = 12;

// drawing.cljs: a path with fewer nodes than this is dropped on finish
// (handle-drawing-end checks (> (count content) 1)).
const MIN_NODES = 2;

// Two nodes closer than this (world units) are the same node: the click and
// the double click of a finish land twice on the same point.
const MERGE_DISTANCE = 0.001;

// shape.cljc minimal-path-attrs: paths use a centered 1px black stroke and
// no fill (clr/black is #000000).
const PEN_STROKE = {
  "stroke-style": "solid",
  "stroke-alignment": "center",
  "stroke-width": 1,
  "stroke-color": "#000000",
  "stroke-opacity": 1,
} as const;

export interface PenNode {
  point: DrawPoint;
  // The absolute positions of the handles; null on a corner side.
  in: DrawPoint | null;
  out: DrawPoint | null;
}

export interface PenDraft {
  nodes: PenNode[];
  closed: boolean;
}

export function penNode(point: DrawPoint): PenNode {
  return { point: { ...point }, in: null, out: null };
}

// The handles of a node after a press-drag: the drag point is the outgoing
// handle and its mirror around the node the incoming one (the CLJS sets the
// pair from the same drag).
export function withDragHandle(node: PenNode, drag: DrawPoint): PenNode {
  return {
    point: node.point,
    out: { ...drag },
    in: { x: 2 * node.point.x - drag.x, y: 2 * node.point.y - drag.y },
  };
}

// position-fixed-angle: keep the radius of `point` around `origin` and snap
// the angle to 15 degrees.
export function penFixedAngle(origin: DrawPoint, point: DrawPoint): DrawPoint {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const radius = Math.sqrt(dx * dx + dy * dy);
  if (radius === 0) return { ...point };
  const step = Math.PI / 12;
  const angle = step * Math.round(Math.atan2(dy, dx) / step);
  return {
    x: origin.x + radius * Math.cos(angle),
    y: origin.y + radius * Math.sin(angle),
  };
}

// clean-drawn-content (segment/merge-coincident-nodes): drop a node that
// repeats the previous one, and the last one when it repeats the first of a
// closed draft (the double click that finished the path lands twice).
export function cleanPenNodes(nodes: readonly PenNode[], closed: boolean): PenNode[] {
  const out: PenNode[] = [];
  for (const node of nodes) {
    const previous = out[out.length - 1];
    if (
      previous !== undefined &&
      Math.hypot(node.point.x - previous.point.x, node.point.y - previous.point.y) <=
        MERGE_DISTANCE
    ) {
      continue;
    }
    out.push(node);
  }
  if (closed && out.length > 2) {
    const first = out[0];
    const last = out[out.length - 1];
    if (
      Math.hypot(last.point.x - first.point.x, last.point.y - first.point.y) <=
      MERGE_DISTANCE
    ) {
      out.pop();
    }
  }
  return out;
}

// seg.cljc append-node -> next-node: a curve-to when either side carries a
// handle, a line-to otherwise.
function segmentBetween(previous: PenNode, next: PenNode): PathSegmentSpec {
  if (previous.out !== null || next.in !== null) {
    return {
      command: "curve-to",
      x: next.point.x,
      y: next.point.y,
      c1x: previous.out?.x ?? previous.point.x,
      c1y: previous.out?.y ?? previous.point.y,
      c2x: next.in?.x ?? next.point.x,
      c2y: next.in?.y ?? next.point.y,
    };
  }
  return { command: "line-to", x: next.point.x, y: next.point.y };
}

// The content of the draft: a move-to, one segment per following node, and
// for a closed draft the segment back to the first node plus close-path.
export function penSegments(nodes: readonly PenNode[], closed: boolean): PathSegmentSpec[] {
  if (nodes.length === 0) return [];
  const segments: PathSegmentSpec[] = [
    { command: "move-to", x: nodes[0].point.x, y: nodes[0].point.y },
  ];
  for (let index = 1; index < nodes.length; index += 1) {
    segments.push(segmentBetween(nodes[index - 1], nodes[index]));
  }
  if (closed && nodes.length > 1) {
    segments.push(segmentBetween(nodes[nodes.length - 1], nodes[0]));
    segments.push({ command: "close-path" });
  }
  return segments;
}

// The half-finished content the overlay draws: the committed nodes plus the
// rubber band from the last node to the pointer. With fewer than two nodes
// the band is a move-to only, and the overlay draws the node dots.
export function penPreviewSegments(
  nodes: readonly PenNode[],
  cursor: DrawPoint | null,
): PathSegmentSpec[] {
  if (nodes.length === 0) return [];
  const segments = penSegments(nodes, false);
  if (cursor === null) return segments;
  const last = nodes[nodes.length - 1];
  const distance = Math.hypot(cursor.x - last.point.x, cursor.y - last.point.y);
  // position-fixed-angle only applies while the pointer is away from the
  // node; a cursor right on it would otherwise collapse the band.
  if (distance < 1e-9) return segments;
  segments.push(segmentBetween(last, penNode(cursor)));
  return segments;
}

export function penPreviewPath(nodes: readonly PenNode[], cursor: DrawPoint | null): string {
  return segmentsToSvgPath(penPreviewSegments(nodes, cursor));
}

// cts/setup-path over the draft: the packed content, its selrect and the
// rect corners as `points`. Answers null when the cleaned draft has fewer
// than two nodes or a malformed coordinate.
export function createPenShape(
  draft: PenDraft,
  parentId: string,
  id: string,
): WorkspaceShape | null {
  const nodes = cleanPenNodes(draft.nodes, draft.closed);
  if (nodes.length < MIN_NODES) return null;
  const segments = penSegments(nodes, draft.closed);
  const rect = contentRect(segments);
  if (rect === null) return null;
  return {
    id,
    type: "path",
    name: "Path",
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
      x2: rect.x + rect.width,
      y2: rect.y + rect.height,
    },
    points: rectPoints(rect),
    content: PathData.fromSegments(segments),
    transform: { ...IDENTITY_TRANSFORM },
    "transform-inverse": { ...IDENTITY_TRANSFORM },
    rotation: 0,
    proportion: 1,
    "proportion-lock": false,
    fills: [],
    strokes: [{ ...PEN_STROKE }],
    "grow-type": "fixed",
  };
}
