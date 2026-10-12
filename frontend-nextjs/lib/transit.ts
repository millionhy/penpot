// Transit codec. The Clojure backend speaks application/transit+json on
// /api/main/methods/* (app.common.transit in the CLJS frontend). transit-js is
// the same Cognitect library the CLJS build uses, so keywords, uuids, instants
// and tagged values round-trip identically.
//
// F1.1: ports the read handlers registered in common/src/app/common/transit.cljc
// (uuid, instant, bigint-ish "n", duration, uri, ordered-map, ordered-set,
// penpot/pointer), normalized to plain JS values at this boundary: maps become
// ordinary objects with string keys, uuids become strings, instants ("~m"
// millis) become Dates, ordered collections become insertion-ordered objects
// or arrays. The CLJS frontend consumes transit Maps and native types
// directly; TS pages consume plain JS instead.
//
// Still TODO(Phase-F, needed by F6/F9): the file-data write handlers used by
// the workspace/viewer (points, matrices, change vectors) and "~#with-meta"
// forms; port them together with the commands that carry them.

import transit from "transit-js";

interface MutableRecord {
  [key: string]: unknown;
}

// Backend pointer-map marker (tag "penpot/pointer", rep [id metadata]).
export class Pointer {
  id: string;
  meta: unknown;
  constructor(id: string, meta: unknown) {
    this.id = id;
    this.meta = meta;
  }
}

export function isPointer(value: unknown): value is Pointer {
  return value instanceof Pointer;
}

// PathData (app.common.types.path.impl): the penpot/path-data tagged value
// carries packed path segments, 28 little-endian bytes each: an int16
// command (1 move-to, 2 line-to, 3 curve-to, 4 close-path) plus float32
// coordinates (curve-to uses all six c1x c1y c2x c2y x y, move/line-to the
// trailing x y, close-path none). The CLJS write handler ships the buffer
// through the transit binary tag ("~b", base64), which transit-js already
// decodes to a Uint8Array when the handler below runs — the same value
// from-bytes receives. The class keeps the bytes and reads segments
// lazily; toSegments / toString mirror read-segment / to-string in
// app.common.types.path.impl, which reads through app.common.buffer
// (little-endian in the CLJS build).
const SEGMENT_U8_SIZE = 28;
// sm/max-safe-int and sm/min-safe-int (app.common.schema): the CLJS
// normalize-coord clamps coordinates to these bounds.
const MAX_SAFE_COORD = 2147483647;
const MIN_SAFE_COORD = -2147483648;

export interface PathSegment {
  command: "move-to" | "line-to" | "curve-to" | "close-path";
  params: Record<string, number>;
}

function clampCoord(value: number): number {
  if (value > MAX_SAFE_COORD) return MAX_SAFE_COORD;
  if (value < MIN_SAFE_COORD) return MIN_SAFE_COORD;
  return value;
}

export class PathData {
  readonly bytes: Uint8Array;
  readonly count: number;
  private readonly view: DataView;

  constructor(bytes: Uint8Array) {
    this.bytes = bytes;
    this.count = Math.floor(bytes.byteLength / SEGMENT_U8_SIZE);
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  // read-segment: returns null for corrupted/unknown segment types (the
  // CLJS seq skips those entries as well).
  private readSegment(index: number): PathSegment | null {
    const offset = index * SEGMENT_U8_SIZE;
    switch (this.view.getInt16(offset, true)) {
      case 1:
        return {
          command: "move-to",
          params: {
            x: clampCoord(this.view.getFloat32(offset + 20, true)),
            y: clampCoord(this.view.getFloat32(offset + 24, true)),
          },
        };
      case 2:
        return {
          command: "line-to",
          params: {
            x: clampCoord(this.view.getFloat32(offset + 20, true)),
            y: clampCoord(this.view.getFloat32(offset + 24, true)),
          },
        };
      case 3:
        return {
          command: "curve-to",
          params: {
            x: clampCoord(this.view.getFloat32(offset + 20, true)),
            y: clampCoord(this.view.getFloat32(offset + 24, true)),
            c1x: clampCoord(this.view.getFloat32(offset + 4, true)),
            c1y: clampCoord(this.view.getFloat32(offset + 8, true)),
            c2x: clampCoord(this.view.getFloat32(offset + 12, true)),
            c2y: clampCoord(this.view.getFloat32(offset + 16, true)),
          },
        };
      case 4:
        return { command: "close-path", params: {} };
      default:
        return null;
    }
  }

  toSegments(): PathSegment[] {
    const out: PathSegment[] = [];
    for (let index = 0; index < this.count; index += 1) {
      const segment = this.readSegment(index);
      if (segment !== null) out.push(segment);
    }
    return out;
  }

  // to-string: the SVG path form (M / L / C / Z), the raw float32 values
  // like the CLJS appends them.
  toString(): string {
    let out = "";
    for (let index = 0; index < this.count; index += 1) {
      const offset = index * SEGMENT_U8_SIZE;
      const f = (delta: number): number => this.view.getFloat32(offset + delta, true);
      switch (this.view.getInt16(offset, true)) {
        case 1:
          out += "M" + f(20) + "," + f(24);
          break;
        case 2:
          out += "L" + f(20) + "," + f(24);
          break;
        case 3:
          out +=
            "C" +
            f(4) + "," + f(8) + "," +
            f(12) + "," + f(16) + "," +
            f(20) + "," + f(24);
          break;
        case 4:
          out += "Z";
          break;
        default:
          break;
      }
    }
    return out;
  }
}

export function isPathData(value: unknown): value is PathData {
  return value instanceof PathData;
}

function pairsToObject(pairs: unknown): MutableRecord {
  const out: MutableRecord = {};
  if (Array.isArray(pairs)) {
    for (const entry of pairs) {
      if (Array.isArray(entry) && entry.length >= 2) {
        out[String(entry[0])] = entry[1];
      }
    }
  }
  return out;
}

// transit-js reader options: plain-object maps + scalar normalization.
const readerOptions = {
  handlers: {
    // keyword scalars ("~:foo") -> string
    ":": (rep: string) => rep,
    // "~u<uuid>" -> string (CLJS uses parse-uuid; TS pages use strings)
    u: (rep: string) => rep,
    // "~m<millis>" -> Date (app.common.transit instant handler)
    m: (rep: string) => new Date(Number.parseInt(rep, 10)),
    // "~n<int>" big integer strings -> number (cljs "n" handler)
    n: (rep: string) => Number.parseInt(rep, 10),
    // java.time.Duration millis -> number
    duration: (rep: unknown) => Number(rep),
    // lambdaisland URI -> string
    uri: (rep: string) => rep,
    // LinkedMap (vec of [k v] pairs) -> insertion-ordered plain object
    "ordered-map": (rep: unknown) => pairsToObject(rep),
    // LinkedSet / transit set -> array (insertion order)
    "ordered-set": (rep: unknown) => (Array.isArray(rep) ? rep : []),
    set: (rep: unknown) => (Array.isArray(rep) ? rep : []),
    // "~#list" wraps every vector answer (get-teams, get-projects,
    // get-team-recent-files, ...); the CLJS reader makes it a cljs List, the
    // shell normalizes it to an array like the other collections.
    list: (rep: unknown) => (Array.isArray(rep) ? rep : []),
    // Pointer [id metadata] (backend pointer-map serialization)
    "penpot/pointer": (rep: unknown) => {
      const pair = Array.isArray(rep) ? rep : [];
      return new Pointer(String(pair[0]), pair[1]);
    },
    // "~#penpot/objects-map/v2": the page objects of the fdata format. The
    // rep is uuid -> transit-encoded shape string (app.common.types.objects_map
    // decodes each value lazily through t/decode-str); the shell decodes every
    // value eagerly into a plain objects map.
    "penpot/objects-map/v2": (rep: unknown) => {
      const out: MutableRecord = {};
      if (rep !== null && typeof rep === "object" && !Array.isArray(rep)) {
        for (const [key, value] of Object.entries(rep as MutableRecord)) {
          out[key] = typeof value === "string" ? decodeTransitString(value) : value;
        }
      }
      return out;
    },
    // "~#shape" / "~#matrix" / "~#point" / "~#rect" / "~#penpot/fills":
    // the record types of app.common.types.shape, geom.{matrix,point,rect}
    // and types.fills. Their JSON read handlers (map->Shape, pos->Matrix,
    // map->Point, map->Rect, from-plain) rewrap the same data; the shell
    // keeps plain maps and vectors instead of record instances.
    shape: (rep: unknown) => rep,
    matrix: (rep: unknown) => rep,
    point: (rep: unknown) => rep,
    rect: (rep: unknown) => rep,
    "penpot/fills": (rep: unknown) => (Array.isArray(rep) ? rep : []),
    // "penpot/path-data": the packed path segments of types.path.impl. The
    // CLJS write handler ships the bytes through the transit binary tag
    // ("~b", base64), which transit-js has decoded to a Uint8Array by the
    // time this handler runs (from-bytes receives the same); wrap it in a
    // PathData. Non-binary reps pass through untouched.
    "penpot/path-data": (rep: unknown) => (rep instanceof Uint8Array ? new PathData(rep) : rep),
  },
  mapBuilder: {
    init: () => ({} as MutableRecord),
    add: (map: MutableRecord, key: unknown, value: unknown) => {
      map[String(key)] = value;
      return map;
    },
    finalize: (map: MutableRecord) => map,
  },
};

const reader = transit.reader("json", readerOptions);
const writer = transit.writer("json");

// t/decode-str in app.common.transit builds a fresh reader for every call.
// The nested decode of the objects-map shapes must do the same: the shared
// `reader` clears its cache after each read, so a nested read through it
// would corrupt the cache references of the outer document mid-decode.
function decodeTransitString(text: string): unknown {
  return transit.reader("json", readerOptions).read(text);
}

export function decodeTransit<T = unknown>(text: string): T {
  return reader.read(text) as T;
}

export function encodeTransit(value: unknown): string {
  return writer.write(value);
}

// A transit map with keyword keys, recursively composable: for command params
// whose backend schema is [:map-of :keyword ...] (e.g. the nested
// :custom-shortcuts prop) a plain JS object would arrive with string keys and
// fail validation, so the nested maps are built with this too.
// NOTE: transit-js's transit.map() takes NO variadic key/value arguments; the
// map must be filled with .set(). Values may be transit scalars (see uuid())
// when a command expects e.g. a uuid instead of a plain string.
export function keywordMap(entries: Record<string, unknown>): unknown {
  const map = transit.map();
  for (const key of Object.keys(entries)) {
    const value = entries[key];
    if (value === undefined) continue;
    map.set(transit.keyword(key), value);
  }
  return map;
}

// Encode a plain params object as a transit map whose keys are keywords, which
// is what the Clojure RPC handlers expect (http/transit-data in repo.cljs).
export function encodeParams(params: Record<string, unknown>): string {
  return writer.write(keywordMap(params));
}

export function keyword(name: string): unknown {
  return transit.keyword(name);
}

export function uuid(value: string): unknown {
  return transit.uuid(value);
}

// Some command params are sets on the wire (move-files :ids is
// [::sm/set ...] on the backend). transit-js cannot write a JS Set, but its
// own set constructor produces the same "~#set" form the CLJS writer emits
// for the #{} literals in data/dashboard.cljs.
export function set(values: Iterable<unknown>): unknown {
  return transit.set([...values]);
}

// js/Date is written natively as "~m<millis>" by transit-js, matching the
// instant write handler in app.common.transit.
export function instant(value: Date): unknown {
  return value;
}