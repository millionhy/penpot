// Path-content helpers for the bounds slice: the subpath split and the
// open-path test of app.common.types.path.
//
// calculate-padding needs `shape-with-open-path?` because a stroke aligned
// `:inner` only adds width to an open path, and the cap-marker margin only
// applies to open paths. The test walks the subpaths after close-subpaths
// joined the ones whose endpoints meet, exactly like the CLJS:
//
//   (and (= :path (:type shape))
//        (not (->> shape
//                  :content
//                  (maybe-close)
//                  (subpath/get-subpaths)
//                  (every? subpath/is-closed?))))
//
// The prepared maps of the viewer only feed the hotspot layer, so the merge
// below keeps the endpoints and drops the segment data: `is-closed?` reads
// from/to alone, and `subpaths-join` only changes which endpoint pair the
// merged subpath reports.

const SEGMENT_U8_SIZE = 28;

export interface PathSegmentLike {
  command: string;
  params: Record<string, number>;
}

interface SubpathPoint {
  x: number;
  y: number;
}

// The endpoint pair of one subpath. The CLJS subpath carries :from/:to and
// the command data; only the pair reaches is-closed?.
interface Subpath {
  from: SubpathPoint;
  to: SubpathPoint;
}

// subpath/pt=: two points are the same when they sit closer than 0.1.
function ptEq(a: SubpathPoint, b: SubpathPoint): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) < 0.1;
}

// segment->point: the trailing x/y of a segment; close-path has no params
// and add-subpath-command replaces it with a line-to first.
function segmentPoint(segment: PathSegmentLike): SubpathPoint | null {
  const params = segment.params;
  if (params === null || typeof params !== "object" || Object.keys(params).length === 0) {
    return null;
  }
  const x = params.x;
  const y = params.y;
  if (typeof x !== "number" || typeof y !== "number") return null;
  return { x, y };
}

function readPackedSegment(view: DataView, offset: number): PathSegmentLike | null {
  const command = view.getInt16(offset, true);
  const point = { x: view.getFloat32(offset + 20, true), y: view.getFloat32(offset + 24, true) };
  switch (command) {
    case 1:
      return { command: "move-to", params: point };
    case 2:
      return { command: "line-to", params: point };
    case 3:
      return {
        command: "curve-to",
        params: {
          c1x: view.getFloat32(offset + 4, true),
          c1y: view.getFloat32(offset + 8, true),
          c2x: view.getFloat32(offset + 12, true),
          c2y: view.getFloat32(offset + 16, true),
          ...point,
        },
      };
    case 4:
      return { command: "close-path", params: {} };
    default:
      return null;
  }
}

// The packed content layout (impl.cljc, 28 bytes per segment, little
// endian): int16 command, four float32 control-point coordinates, then the
// trailing x y. PathData decodes the same words; unwrapping the bytes here
// keeps the engine free of the transit module.
function unpackSegments(bytes: Uint8Array): PathSegmentLike[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: PathSegmentLike[] = [];
  for (let offset = 0; offset + SEGMENT_U8_SIZE <= bytes.byteLength; offset += SEGMENT_U8_SIZE) {
    const segment = readPackedSegment(view, offset);
    if (segment !== null) out.push(segment);
  }
  return out;
}

// The content of a path or bool shape: a decoded PathData (toSegments), an
// already unpacked segment array, or the packed bytes.
export function pathSegments(content: unknown): PathSegmentLike[] {
  if (Array.isArray(content)) {
    return content.filter(
      (value): value is PathSegmentLike =>
        value !== null && typeof value === "object" && typeof (value as PathSegmentLike).command === "string",
    );
  }
  if (content instanceof Uint8Array) return unpackSegments(content);
  if (content instanceof ArrayBuffer) return unpackSegments(new Uint8Array(content));
  if (
    content !== null &&
    typeof content === "object" &&
    typeof (content as { toSegments?: unknown }).toSegments === "function"
  ) {
    const segments = (content as { toSegments: () => unknown }).toSegments();
    return Array.isArray(segments) ? pathSegments(segments) : [];
  }
  return [];
}

// get-subpaths: a move-to opens a subpath, every other command extends the
// last one, and commands before the first move-to are dropped.
function subpathsOf(segments: readonly PathSegmentLike[]): Subpath[] {
  const out: Subpath[] = [];
  for (const segment of segments) {
    if (segment.command === "move-to") {
      const point = segmentPoint(segment) ?? { x: 0, y: 0 };
      out.push({ from: point, to: point });
      continue;
    }
    const last = out[out.length - 1];
    if (last === undefined) continue;
    // add-subpath-command: close-path walks back to the start point.
    if (segment.command === "close-path") {
      if (!ptEq(last.from, last.to)) last.to = last.from;
      continue;
    }
    const point = segmentPoint(segment);
    if (point !== null) last.to = point;
  }
  return out;
}

function isClosed(subpath: Subpath): boolean {
  return ptEq(subpath.from, subpath.to);
}

// merge-paths: fold every subpath that touches the candidate into it. The
// result reports whether anything merged so the caller can re-scan, like the
// CLJS `(if (= current new-current) ...)` check.
function mergePaths(candidate: Subpath, subpaths: readonly Subpath[]): {
  candidate: Subpath;
  rest: Subpath[];
  merged: boolean;
} {
  let current = { from: candidate.from, to: candidate.to };
  let merged = false;
  const rest: Subpath[] = [];

  for (const other of subpaths) {
    if (isClosed(other)) {
      // An already closed subpath is never merged.
      rest.push(other);
      continue;
    }
    if (ptEq(current.to, other.from)) {
      current = { from: current.from, to: other.to };
      merged = true;
    } else if (ptEq(current.from, other.to)) {
      // subpaths-join other candidate: the candidate keeps its end point.
      current = { from: other.from, to: current.to };
      merged = true;
    } else if (ptEq(current.to, other.to)) {
      // join candidate (reverse other): the reversed subpath ends where the
      // original starts.
      current = { from: current.from, to: other.from };
      merged = true;
    } else if (ptEq(current.from, other.from)) {
      // join (reverse other) candidate: starts where the original ends.
      current = { from: other.to, to: current.to };
      merged = true;
    } else {
      rest.push(other);
    }
  }

  return { candidate: current, rest, merged };
}

// close-subpaths: repeatedly merge touching subpaths until none is left to
// merge. A subpath that already closes is kept as it is.
function closeSubpaths(subpaths: readonly Subpath[]): Subpath[] {
  const out: Subpath[] = [];
  let queue = Array.from(subpaths);
  let current = queue.shift();

  while (current !== undefined) {
    if (isClosed(current)) {
      out.push(current);
      current = queue.shift();
      continue;
    }
    const result = mergePaths(current, queue);
    if (!result.merged) {
      out.push(current);
      queue = result.rest;
      current = queue.shift();
      continue;
    }
    // A merge changes the endpoints, so the candidate has to be scanned
    // again against what is left.
    current = result.candidate;
    queue = result.rest;
  }

  return out;
}

// shape-with-open-path?: no close-subpaths for svg imports (the `svg-attrs`
// key is present, even when nil), every other path closes its subpaths
// first. Empty content counts as closed, like `(every? ... [])`.
export function shapeWithOpenPath(shape: Record<string, unknown>): boolean {
  if (shape.type !== "path") return false;
  const segments = pathSegments(shape.content);
  const subpaths = Object.prototype.hasOwnProperty.call(shape, "svg-attrs")
    ? subpathsOf(segments)
    : closeSubpaths(subpathsOf(segments));
  return !subpaths.every(isClosed);
}
