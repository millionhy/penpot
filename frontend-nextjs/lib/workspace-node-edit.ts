// Node editing of a path shape (F9.13).
//
// The model is the same drafting shape the pen tool uses, so the two share
// one representation: a list of anchors, each carrying its incoming and
// outgoing absolute control points, plus the flags that tell where a subpath
// starts and where it closes. Segment order and the closing segment are
// rebuilt from that list, which keeps content, geometry and the overlay in
// step:
//
// - parse: content -> anchors. A segment that lands on the subpath start
//   right before a close-path is the explicit closing segment the drawing
//   tools emit; it folds into the first anchor (as its incoming handle)
//   instead of adding a duplicate node, so both encodings parse the same;
// - rebuild: anchors -> content. The closing segment is emitted only when the
//   last anchor carries an out handle (a curved close); otherwise close-path
//   alone keeps the straight edge, so a save-and-reparse round trip is
//   stable;
// - hit test: nearest anchor or handle within a screen-pixel radius;
// - commit: one mod-obj with the new content, the selrect and the four
//   geometry attributes (path/update-geometry over a fresh transform).
//
// Scope (documented): path shapes only — a bool recomputes its content from
// its children, so editing its nodes would be overwritten — and no node
// insertion or segment splitting, which need the intersect helpers of
// app.common.types.path.bool.

import { PathData, type PathSegmentSpec, type UpdateFileChange } from "@/lib/transit";
import { contentRect, rectPoints } from "@/lib/workspace-path";
import type { DrawPoint } from "@/lib/workspace-draw";
import type { WorkspaceShape } from "@/lib/workspace";

// The hit radius in screen pixels: a press this close to a node or a handle
// grabs it instead of starting a marquee or a move.
export const NODE_HIT_RADIUS = 6;

// Two coordinates closer than this are the same point (the parser folds the
// closing segment on exact duplicates only, like the pen cleaner).
const SAME_POINT = 1e-6;

export interface EditNode {
  point: DrawPoint;
  in: DrawPoint | null;
  out: DrawPoint | null;
  // The anchor opens a subpath (a move-to).
  start: boolean;
  // The anchor closes its subpath (the close-path that follows it).
  close: boolean;
}

function samePoint(a: DrawPoint, b: DrawPoint): boolean {
  return Math.abs(a.x - b.x) < SAME_POINT && Math.abs(a.y - b.y) < SAME_POINT;
}

// content -> anchors. Unknown or malformed segments are skipped, so a
// corrupted shape edits what it can instead of throwing.
export function pathEditNodes(content: PathData): EditNode[] {
  const segments = content.toSegments();
  const nodes: EditNode[] = [];
  let current: EditNode | null = null;
  let subpathStart: EditNode | null = null;
  for (let at = 0; at < segments.length; at += 1) {
    const segment = segments[at];
    const closes = segments[at + 1]?.command === "close-path";
    switch (segment.command) {
      case "move-to": {
        const anchor: EditNode = {
          point: { x: segment.params.x ?? 0, y: segment.params.y ?? 0 },
          in: null,
          out: null,
          start: true,
          close: false,
        };
        nodes.push(anchor);
        current = anchor;
        subpathStart = anchor;
        break;
      }
      case "line-to": {
        const point = { x: segment.params.x ?? 0, y: segment.params.y ?? 0 };
        // The explicit closing segment of the drawing tools: fold it into the
        // first anchor instead of adding a duplicate node.
        if (closes && subpathStart !== null && samePoint(point, subpathStart.point)) break;
        const anchor: EditNode = { point, in: null, out: null, start: false, close: false };
        nodes.push(anchor);
        current = anchor;
        break;
      }
      case "curve-to": {
        const point = { x: segment.params.x ?? 0, y: segment.params.y ?? 0 };
        const c1 = { x: segment.params.c1x ?? point.x, y: segment.params.c1y ?? point.y };
        const c2 = { x: segment.params.c2x ?? point.x, y: segment.params.c2y ?? point.y };
        if (closes && subpathStart !== null && samePoint(point, subpathStart.point)) {
          // A curved close: the handles land on the first and the last anchor.
          if (current !== null) current.out = c1;
          subpathStart.in = c2;
          break;
        }
        if (current !== null) current.out = c1;
        const anchor: EditNode = { point, in: c2, out: null, start: false, close: false };
        nodes.push(anchor);
        current = anchor;
        break;
      }
      case "close-path": {
        if (subpathStart !== null) subpathStart.close = true;
        current = subpathStart;
        break;
      }
    }
  }
  return nodes;
}

// anchors -> content: one move-to per subpath, a line-to for a corner, a
// curve-to when either side carries a handle, and close-path at the end of a
// closed subpath. A closed subpath whose last anchor carries an out handle
// also gets the explicit closing segment, so the curve survives the rebuild.
export function nodesToSegments(nodes: readonly EditNode[]): PathSegmentSpec[] {
  const segments: PathSegmentSpec[] = [];
  let subpathFirst: EditNode | null = null;
  let previous: EditNode | null = null;
  const closeSubpath = (): void => {
    if (subpathFirst === null) return;
    if (!subpathFirst.close) return;
    const last = previous;
    if (last !== null && last !== subpathFirst && last.out !== null) {
      segments.push({
        command: "curve-to",
        c1x: last.out.x,
        c1y: last.out.y,
        c2x: subpathFirst.in === null ? subpathFirst.point.x : subpathFirst.in.x,
        c2y: subpathFirst.in === null ? subpathFirst.point.y : subpathFirst.in.y,
        x: subpathFirst.point.x,
        y: subpathFirst.point.y,
      });
    }
    segments.push({ command: "close-path" });
  };
  for (const node of nodes) {
    if (node.start || subpathFirst === null) {
      closeSubpath();
      segments.push({ command: "move-to", x: node.point.x, y: node.point.y });
      subpathFirst = node;
      previous = node;
      continue;
    }
    const from = previous;
    if (from !== null && (from.out !== null || node.in !== null)) {
      segments.push({
        command: "curve-to",
        c1x: from.out === null ? from.point.x : from.out.x,
        c1y: from.out === null ? from.point.y : from.out.y,
        c2x: node.in === null ? node.point.x : node.in.x,
        c2y: node.in === null ? node.point.y : node.in.y,
        x: node.point.x,
        y: node.point.y,
      });
    } else {
      segments.push({ command: "line-to", x: node.point.x, y: node.point.y });
    }
    previous = node;
  }
  closeSubpath();
  return segments;
}

export function contentFromNodes(nodes: readonly EditNode[]): PathData {
  return PathData.fromSegments(nodesToSegments(nodes));
}

// The SVG `d` of the edited anchors, for the overlay preview.
export function nodesToSvgPath(nodes: readonly EditNode[]): string {
  let out = "";
  for (const segment of nodesToSegments(nodes)) {
    switch (segment.command) {
      case "move-to":
        out += `M${segment.x ?? 0},${segment.y ?? 0}`;
        break;
      case "line-to":
        out += `L${segment.x ?? 0},${segment.y ?? 0}`;
        break;
      case "curve-to":
        out +=
          `C${segment.c1x ?? 0},${segment.c1y ?? 0} ` +
          `${segment.c2x ?? 0},${segment.c2y ?? 0} ` +
          `${segment.x ?? 0},${segment.y ?? 0}`;
        break;
      case "close-path":
        out += "Z";
        break;
    }
  }
  return out;
}

// A new anchor list with one anchor and its two handles translated.
export function moveNode(nodes: readonly EditNode[], index: number, dx: number, dy: number): EditNode[] {
  return nodes.map((node, at) => {
    if (at !== index) return node;
    return {
      ...node,
      point: { x: node.point.x + dx, y: node.point.y + dy },
      in: node.in === null ? null : { x: node.in.x + dx, y: node.in.y + dy },
      out: node.out === null ? null : { x: node.out.x + dx, y: node.out.y + dy },
    };
  });
}

// A new anchor list with one handle moved. `mirror` keeps the opposite handle
// opposite around the anchor (a smooth node, the pen default); without it the
// handles move apart (a corner).
export function moveHandle(
  nodes: readonly EditNode[],
  index: number,
  kind: "in" | "out",
  point: DrawPoint,
  mirror: boolean,
): EditNode[] {
  return nodes.map((node, at) => {
    if (at !== index) return node;
    const moved: EditNode = { ...node, [kind]: { ...point } };
    if (mirror) {
      const opposite = kind === "in" ? "out" : "in";
      moved[opposite] = {
        x: 2 * node.point.x - point.x,
        y: 2 * node.point.y - point.y,
      };
    }
    return moved;
  });
}

// A new anchor list without one anchor. A subpath left with fewer than two
// anchors disappears (its remaining anchor goes with it); the result may be
// empty, and the caller then drops the edit instead of committing a shape
// with no geometry.
export function deleteNode(nodes: readonly EditNode[], index: number): EditNode[] {
  const next = nodes.filter((_, at) => at !== index);
  if (next.length === 0) return [];
  // Group by subpath and drop the groups that cannot form a segment.
  const groups: EditNode[][] = [];
  for (const node of next) {
    if (node.start || groups.length === 0) groups.push([node]);
    else groups[groups.length - 1].push(node);
  }
  return groups.filter((group) => group.length >= 2).flat();
}

// Whether a shape can be edited node by node: a path with packed content.
export function isEditablePath(shape: WorkspaceShape): boolean {
  return shape.type === "path" && shape.content instanceof PathData;
}

// The nearest anchor within the hit radius (screen pixels), or -1.
export function hitNode(
  nodes: readonly EditNode[],
  point: DrawPoint,
  zoom: number,
): number {
  let best = -1;
  let bestDistance = NODE_HIT_RADIUS / zoom;
  nodes.forEach((node, index) => {
    const distance = Math.hypot(node.point.x - point.x, node.point.y - point.y);
    if (distance <= bestDistance) {
      best = index;
      bestDistance = distance;
    }
  });
  return best;
}

// The nearest handle within the hit radius. The anchors win a tie, so the
// caller tests the handles first (a handle may sit on top of a neighbour).
export interface HandleHit {
  index: number;
  kind: "in" | "out";
}

export function hitHandle(
  nodes: readonly EditNode[],
  point: DrawPoint,
  zoom: number,
): HandleHit | null {
  let best: HandleHit | null = null;
  let bestDistance = NODE_HIT_RADIUS / zoom;
  nodes.forEach((node, index) => {
    for (const kind of ["in", "out"] as const) {
      const handle = node[kind];
      if (handle === null) continue;
      const distance = Math.hypot(handle.x - point.x, handle.y - point.y);
      if (distance <= bestDistance) {
        best = { index, kind };
        bestDistance = distance;
      }
    }
  });
  return best;
}

// The mod-obj of an edit: path/update-geometry packs the new content into
// the shape record, and the four geometry attributes follow the new box so
// the selection, the constraints and the wasm all read the same rect.
export function buildNodeEditChange(
  shape: WorkspaceShape,
  nodes: readonly EditNode[],
  pageId: string,
): UpdateFileChange | null {
  if (nodes.length < 2) return null;
  const segments = nodesToSegments(nodes);
  const rect = contentRect(segments);
  if (rect === null) return null;
  const content = PathData.fromSegments(segments);
  const points = rectPoints(rect);
  const operations: Array<{ type: "set"; attr: string; val: unknown }> = [
    { type: "set", attr: "content", val: content },
    { type: "set", attr: "x", val: rect.x },
    { type: "set", attr: "y", val: rect.y },
    { type: "set", attr: "width", val: rect.width },
    { type: "set", attr: "height", val: rect.height },
    {
      type: "set",
      attr: "selrect",
      val: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        x1: rect.x,
        y1: rect.y,
        x2: rect.x + rect.width,
        y2: rect.y + rect.height,
      },
    },
    { type: "set", attr: "points", val: points },
  ];
  return { type: "mod-obj", "page-id": pageId, id: shape.id, operations };
}
