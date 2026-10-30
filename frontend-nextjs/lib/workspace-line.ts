// The line and arrow tools (F9.5): the press-and-drag branch of the
// workspace drawing handlers.
//
// Ported from:
// - frontend/src/app/main/data/workspace/drawing/line.cljs (snap-to-angle,
//   the 10-screen-pixel filter of handle-drawing, the two-node content built
//   by update-endpoint/setup-frame and the arrow stroke of arrow-strokes);
// - common/src/app/common/types/path.cljc (points->content, calc-selrect);
// - common/src/app/common/types/shape.cljc (setup-path and
//   minimal-path-attrs: no fills, a 1px centered black stroke).
//
// Kept free of JSX and of the CLJS runtime so vitest exercises every branch.
//
// Deviations from the CLJS original, documented:
// - The shape is built once, on the release, from the two final points. The
//   CLJS rebuilds the content on every mouse frame while the preview shape
//   lives in :workspace-drawing; here the dashed overlay line is the preview.
// - No pixel grid or snap points, like the box tools of this port.

import { PathData } from "@/lib/transit";
import { IDENTITY_TRANSFORM, type WorkspaceShape } from "@/lib/workspace";
import type { DrawPoint } from "@/lib/workspace-draw";
import { pathSegmentsFromPoints, pointsRect, rectPoints } from "@/lib/workspace-path";

// line.cljs snap-step-deg: Shift snaps the end point to the nearest 15
// degrees around the press point.
export const LINE_SNAP_STEP_DEG = 15;

// handle-drawing: (> (* (distance point start) zoom) 10).
const LINE_THRESHOLD = 10;

// shape.cljc minimal-path-attrs: paths use a centered 1px black stroke and
// no fill (clr/black is #000000).
const LINE_STROKE = {
  "stroke-style": "solid",
  "stroke-alignment": "center",
  "stroke-width": 1,
  "stroke-color": "#000000",
  "stroke-opacity": 1,
} as const;

// line.cljs arrow-strokes: the arrow variant adds a triangular cap on the
// end node (stroke-caps-marker of common.types.stroke).
const ARROW_CAP = "triangle-arrow";

// line.cljs snap-to-angle: keep the radius of `point` around `origin` and
// round the angle to the nearest step.
export function snapToAngle(
  origin: DrawPoint,
  point: DrawPoint,
  stepDeg: number = LINE_SNAP_STEP_DEG,
): DrawPoint {
  const dx = point.x - origin.x;
  const dy = point.y - origin.y;
  const radius = Math.sqrt(dx * dx + dy * dy);
  const angle = Math.atan2(dy, dx);
  const step = (Math.PI * stepDeg) / 180;
  const snapped = step * Math.round(angle / step);
  return {
    x: origin.x + radius * Math.cos(snapped),
    y: origin.y + radius * Math.sin(snapped),
  };
}

// The live end of a line drag: null while the pointer sits within 10 screen
// pixels of the press point (the CLJS filters those frames out, so the
// preview only starts past the threshold). Shift snaps the end point.
export function lineEndPoint(
  origin: DrawPoint,
  point: DrawPoint,
  zoom: number,
  shift: boolean,
): DrawPoint | null {
  const distance = Math.hypot(point.x - origin.x, point.y - origin.y);
  if (!(distance * zoom > LINE_THRESHOLD)) return null;
  return shift ? snapToAngle(origin, point) : { x: point.x, y: point.y };
}

// cts/setup-path over the two points: a move-to plus one line-to, the
// selrect of that content and the four rect corners as `points`. Answers
// null for a zero-length drag, which the CLJS finalize also drops.
export function createLineShape(
  start: DrawPoint,
  end: DrawPoint,
  parentId: string,
  id: string,
  arrow = false,
): WorkspaceShape | null {
  if (start.x === end.x && start.y === end.y) return null;
  const rect = pointsRect([start, end]);
  if (rect === null) return null;
  const content = PathData.fromSegments(pathSegmentsFromPoints([start, end]));
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
    content,
    transform: { ...IDENTITY_TRANSFORM },
    "transform-inverse": { ...IDENTITY_TRANSFORM },
    rotation: 0,
    proportion: 1,
    "proportion-lock": false,
    fills: [],
    strokes: [arrow ? { ...LINE_STROKE, "stroke-cap-end": ARROW_CAP } : { ...LINE_STROKE }],
    "grow-type": "fixed",
  };
}
