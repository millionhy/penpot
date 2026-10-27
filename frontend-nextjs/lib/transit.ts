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
//
// F7.3: the plugin sandbox (SES) cannot survive the transit-js guid caches
// on Date and Uint8Array; see the SES compatibility section below.

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

// --- SES compatibility (plugin sandbox) ------------------------------------
//
// F7.3: the plugin sandbox repairs the JS intrinsics with SES
// (repairIntrinsics in @penpot/plugins-runtime, run when the runtime module
// evaluates) and it deletes every unrecognized own property of the
// intrinsics, throwing when one resists deletion. Building the transit
// writer registers its default handler table, and the registration tags
// every constructor it meets with a `transit$guid$<uuid>` cache id — Date
// and Uint8Array among them — storing it with a defineProperty call that
// misses `configurable:true`. The sandbox always boots after the RPC layer,
// so without the flag the repair would die on those two caches and the
// runtime never initialize. The property name is minted inside transit-js
// and is not exported, so the writer build runs under
// withDeletableTransitGuids, which adds the missing flag to exactly that
// property. The boot then calls resetTransitGuids right after the import
// (see lib/plugin-runtime.ts): the repair has deleted the caches, and the
// handler table of the previous writer keys on them, so the writer must be
// rebuilt before the first plugin open hardens the intrinsics — a first
// lazy re-add after that would throw on the frozen constructor.
const TRANSIT_GUID_PREFIX = "transit$guid$";

function withDeletableTransitGuids<T>(build: () => T): T {
  const original = Object.defineProperty;
  const guarded = (target: object, key: PropertyKey, attributes: PropertyDescriptor): object => {
    if (
      typeof target === "function" &&
      typeof key === "string" &&
      key.startsWith(TRANSIT_GUID_PREFIX)
    ) {
      attributes = { ...attributes, configurable: true };
    }
    return original(target, key, attributes);
  };
  Object.defineProperty = guarded as typeof Object.defineProperty;
  try {
    return build();
  } finally {
    Object.defineProperty = original;
  }
}

function buildJsonWriter() {
  return withDeletableTransitGuids(() => transit.writer("json"));
}

let writer = buildJsonWriter();

// Rebuilds the guid caches and swaps the shared writer, whose handler table
// no longer matches the cache ids the sandbox deleted.
export function resetTransitGuids(): void {
  writer = buildJsonWriter();
}

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

// --- update-file write side (F9.3 AD6) ---------------------------------------
//
// The workspace move commit encodes its params here instead of through
// encodeParams: the change vector nests keyword-keyed maps, transit uuids
// and the penpot/path-data tagged binary, none of which a plain JS object
// can express. T1 probed the tagged route: transit.tagged ships the bytes
// through the binary tag ("~b", base64), the exact form the CLJS write
// handler of app.common.transit emits and the "penpot/path-data" read
// handler above consumes back. The shape mirrors the CLJS changes of
// app.main.data.workspace.persistence / app.common.files.changes; the
// backend schema re-validates it on arrival (schema:change /
// schema:operation in app.common.files.changes).
//
// A selrect rides the "rect" record tag and every point of "points" the
// "point" tag (the CLJS records write through t/add-handlers!, whose id is
// the wire tag): the backend schema checks record instances (rect? and
// point? in app.common.geom.{rect,point} are `instance?` tests), so a
// plain keyword map decodes to a plain map and the file update rejects it
// (the T3 E2E got "invalid shape found" until this was fixed; AD6 had
// assumed the structure check). A transform rides "matrix" under the same
// instance check, and add-obj carries the whole shape under "shape" so the
// backend rebuilds a Shape record. A position-data item on the other hand
// is a plain map on both sides and stays untagged.

// One {:type :set :attr <kw> :val <v>} operation of a mod-obj change;
// attr is the attribute keyword as a string and val its raw JS value.
export interface UpdateFileSetOperation {
  type: "set";
  attr: string;
  val: unknown;
}

// {:type :mod-obj :page-id <uuid> :id <uuid> :operations [<set>...]}:
// replaces attributes of one shape.
export interface UpdateFileModObjChange {
  type: "mod-obj";
  "page-id": string;
  id: string;
  operations: UpdateFileSetOperation[];
}

// {:type :add-obj :id <uuid> :obj <shape> :page-id <uuid> :frame-id <uuid>
//  :parent-id <uuid> [:index <int>]}: inserts one new shape (F9.5). The
// change id follows the shape id; a missing index makes ctst/add-shape
// append at the tail of the parent, while an index places the shape at that
// position of the current children list (0 is the bottom).
export interface UpdateFileAddObjChange {
  type: "add-obj";
  id: string;
  obj: Readonly<Record<string, unknown>>;
  "page-id": string;
  "frame-id": string;
  "parent-id": string;
  index?: number;
}

// {:type :mov-objects :page-id <uuid> :parent-id <uuid> :shapes [<uuid>..]
//  [:index <int>]}: re-parents or re-orders shapes (T4). The ids ride in
// reverse order like change-parent, no index means append at the tail, and
// an index follows the insert-at-index rule (0 is the bottom, ids already in
// the list move to the requested position). ZERO_UUID is the root frame.
export interface UpdateFileMovObjectsChange {
  type: "mov-objects";
  "page-id": string;
  "parent-id": string;
  shapes: string[];
  index?: number;
}

// {:type :del-obj :page-id <uuid> :id <uuid>}: removes one shape and its
// subtree. The F9.7 undo stack produces it as the inverse of a draw; the
// backend ctst/delete-shape handles the recursion.
export interface UpdateFileDelObjChange {
  type: "del-obj";
  "page-id": string;
  id: string;
}

// {:type :add-page :id <uuid> :name <string>}: adds an empty page (F9.13).
// The backend process-change :add-page builds ctp/make-empty-page from the
// name, so the change carries no objects and the shell clones the root it
// already knows for its local model.
export interface UpdateFileAddPageChange {
  type: "add-page";
  id: string;
  name: string;
}

// {:type :mod-page :id <uuid> :name <string>}: renames a page. Only the name
// is sent; the background and pixel-grid keys stay untouched.
export interface UpdateFileModPageChange {
  type: "mod-page";
  id: string;
  name: string;
}

// {:type :del-page :id <uuid>}: removes the page and its pages-index entry.
export interface UpdateFileDelPageChange {
  type: "del-page";
  id: string;
}

export type UpdateFilePageChange =
  | UpdateFileAddPageChange
  | UpdateFileModPageChange
  | UpdateFileDelPageChange;

export type UpdateFileChange =
  | UpdateFileAddObjChange
  | UpdateFileModObjChange
  | UpdateFileMovObjectsChange
  | UpdateFileDelObjChange
  | UpdateFilePageChange;

export interface UpdateFileParams {
  id: string;
  "session-id": string;
  revn: number;
  vern: number;
  changes: UpdateFileChange[];
}

// Keys whose values the CLJS file-data holds as uuids (::sm/uuid in the
// backend schemas) but this boundary normalizes to strings (the "u" reader
// handler above): the *-ref-id / *-ref-file pairs of the text attrs and
// fills (app.common.types.text / fills; a span of a text position-data
// carries them under its :fills), the id of a fill-image
// (app.common.types.color) and the shape links. The shape links matter for
// add-obj: :parent-id and :frame-id sit on the shape map itself, and the
// old pattern skipped them, leaving plain strings the backend ::sm/uuid
// check rejects. A plain string fails the uuid check of the backend on
// arrival, so the writer re-tags them; the uuid-form guard keeps string
// lookalikes (e.g. a "font-id" naming a font, see text-font-attrs)
// untagged.
const UUID_VALUE_KEY =
  /^(id|parent-id|frame-id|component-id|page-id|shape-ref|.+-ref-id|.+-ref-file)$/;

// Values the CLJS file-data holds as keywords (::sm/one-of in the backend
// schemas) but this boundary normalizes to strings (the ":" reader handler
// above): the shape and gradient :type, the stroke enums, the blend mode,
// the shadow grow type, the shadow :style, the layout-item sizing
// (fix/auto/fill), the layout and layout-item enums, and the constraints.
// A plain "rect" fails ::sm/one-of on arrival and the wasm stroke alignment
// falls to its default branch, so the writer re-tags them. A plain string
// layout value fails validate-shape the same way (schema:layout-attrs and
// schema:layout-child-attrs are one-of sets of keywords), which made every
// layout commit answer 500.
// :style rides the shadow commit (drop-shadow / inner-shadow), which is the
// only attr of that name in the model; a grid track carries its enum under
// :type, so the track lists need no entry of their own.
const KEYWORD_VALUE_KEY =
  /^(type|style|stroke-style|stroke-alignment|stroke-cap-start|stroke-cap-end|blend-mode|grow-type|layout-item-h-sizing|layout-item-v-sizing|layout|layout-flex-dir|layout-grid-dir|layout-gap-type|layout-wrap-type|layout-padding-type|layout-align-items|layout-align-content|layout-justify-items|layout-justify-content|layout-item-margin-type|layout-item-align-self|constraints-h|constraints-v)$/;
const UUID_FORM = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function encodeUpdateAttrEntry(key: string, value: unknown): unknown {
  if (typeof value === "string") {
    if (UUID_VALUE_KEY.test(key) && UUID_FORM.test(value)) return uuid(value);
    if (KEYWORD_VALUE_KEY.test(key)) return keyword(value);
  }
  // layout-grid-cells is a uuid -> grid cell map (schema:grid-cell) whose
  // keys, :id and :shapes are uuids and whose position / align-self /
  // justify-self are keywords; the generic recursion would send strings for
  // all three.
  if (key === "layout-grid-cells") return encodeGridCellsValue(value);
  // The record-valued attrs keep their instance tags through set/mod-obj
  // as well (the resize gesture updates selrect and points through them).
  if (key === "selrect") return encodeRecordValue("rect", value);
  if (key === "points") return encodePointsValue(value);
  if (key === "transform" || key === "transform-inverse") return encodeMatrixValue(value);
  return encodeUpdateAttrValue(value);
}

// One grid cell map of a layout frame. The backend validates the whole shape
// after a mod-obj (changes.cljc process-operations) and schema:grid-cell
// checks the uuid keys and the two enum keywords, so a string-keyed map would
// reject the commit; the wasm bridge decodes the same form back for
// set-grid-layout-cells.
function encodeGridCellsValue(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return encodeUpdateAttrValue(value);
  }
  const map = transit.map();
  for (const [id, cell] of Object.entries(value as MutableRecord)) {
    if (cell === null || typeof cell !== "object" || Array.isArray(cell)) continue;
    const entries: Record<string, unknown> = {};
    for (const [attr, entry] of Object.entries(cell as MutableRecord)) {
      entries[attr] = encodeGridCellEntry(attr, entry);
    }
    map.set(uuid(id), keywordMap(entries));
  }
  return map;
}

// The uuid links and the enum values of one cell; the numbers and the area
// name pass through.
function encodeGridCellEntry(attr: string, value: unknown): unknown {
  if (attr === "id") return typeof value === "string" ? uuid(value) : value;
  if (attr === "shapes") {
    return Array.isArray(value) ? value.map((id) => uuid(String(id))) : value;
  }
  if (attr === "position" || attr === "align-self" || attr === "justify-self") {
    return typeof value === "string" ? keyword(value) : value;
  }
  return value;
}

// The generic val recursion: packed path content rides the tagged binary;
// vectors map element-wise (position-data); keyword-keyed maps become
// transit maps (the position-data items, whose uuid refs re-tag through
// encodeUpdateAttrEntry); scalars pass through.
function encodeUpdateAttrValue(value: unknown): unknown {
  if (isPathData(value)) return transit.tagged("penpot/path-data", value.bytes);
  if (Array.isArray(value)) return value.map(encodeUpdateAttrValue);
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as MutableRecord).map(([key, entry]) => [
      key,
      encodeUpdateAttrEntry(key, entry),
    ]);
    return keywordMap(Object.fromEntries(entries));
  }
  return value;
}

// One record value (the Rect / Point defrecords of app.common.geom): tag +
// keyword-keyed map, the exact form the CLJS write handler emits, so the
// backend read handler (map->Rect / map->Point) rebuilds a record instance.
function encodeRecordValue(tag: string, value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return encodeUpdateAttrValue(value);
  }
  const entries = Object.entries(value as MutableRecord).map(([key, entry]) => [
    key,
    encodeUpdateAttrValue(entry),
  ]);
  return transit.tagged(tag, keywordMap(Object.fromEntries(entries)));
}

function encodePointsValue(value: unknown): unknown {
  if (!Array.isArray(value)) return encodeUpdateAttrValue(value);
  return value.map((point) => encodeRecordValue("point", point));
}

// A transform is a Matrix record on the CLJS side and pos->Matrix reads
// (get m :a) ... (get m :f), so an array rep would decode into a matrix of
// zeros: reject it instead of writing a shape that validates but renders
// wrong.
function encodeMatrixValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    throw new Error(
      "transform attrs must be an {a..f} map; pos->Matrix reads :a..:f and an array decodes to zeros",
    );
  }
  return encodeRecordValue("matrix", value);
}

// The val of a set operation, encoded for the attr it targets (see the
// selrect/points note above).
function encodeSetOperation(operation: UpdateFileSetOperation): unknown {
  return keywordMap({
    type: keyword("set"),
    attr: keyword(operation.attr),
    val: encodeUpdateAttrEntry(operation.attr, operation.val),
  });
}

function encodeShapeChildren(value: unknown): unknown {
  if (!Array.isArray(value)) return encodeUpdateAttrValue(value);
  return value.map((id) => uuid(String(id)));
}

// One shape map as the backend's add-obj change carries it (and as the wasm
// bridge uploads it): keyword keys, uuid links, enum values as keywords, the
// selrect/points/matrix records tagged, children as a uuid array, and the
// whole map wrapped in the "shape" tag so create-shape
// (app.common.types.shape) rebuilds a Shape record on the backend.
export function encodeShapeValue(shape: Readonly<Record<string, unknown>>): unknown {
  const entries = Object.entries(shape).map(([key, value]) => [
    key,
    key === "shapes" ? encodeShapeChildren(value) : encodeUpdateAttrEntry(key, value),
  ]);
  return transit.tagged("shape", keywordMap(Object.fromEntries(entries)));
}

// Public wrapper over the attribute recursion for callers outside this
// module (the wasm shape upload encodes fills/strokes props with it).
export function encodeAttrValue(value: unknown): unknown {
  return encodeUpdateAttrValue(value);
}

function encodeUpdateChange(change: UpdateFileChange): unknown {
  if (change.type === "add-page") {
    return keywordMap({
      type: keyword("add-page"),
      id: uuid(change.id),
      name: change.name,
    });
  }
  if (change.type === "mod-page") {
    return keywordMap({
      type: keyword("mod-page"),
      id: uuid(change.id),
      name: change.name,
    });
  }
  if (change.type === "del-page") {
    return keywordMap({
      type: keyword("del-page"),
      id: uuid(change.id),
    });
  }
  if (change.type === "add-obj") {
    return keywordMap({
      type: keyword("add-obj"),
      id: uuid(change.id),
      obj: encodeShapeValue(change.obj),
      "page-id": uuid(change["page-id"]),
      "frame-id": uuid(change["frame-id"]),
      "parent-id": uuid(change["parent-id"]),
      // keywordMap drops undefined entries, so an append stays index-free.
      index: change.index,
    });
  }
  if (change.type === "mov-objects") {
    return keywordMap({
      type: keyword("mov-objects"),
      "page-id": uuid(change["page-id"]),
      "parent-id": uuid(change["parent-id"]),
      shapes: change.shapes.map((id) => uuid(id)),
      index: change.index,
    });
  }
  if (change.type === "del-obj") {
    return keywordMap({
      type: keyword("del-obj"),
      "page-id": uuid(change["page-id"]),
      id: uuid(change.id),
    });
  }
  return keywordMap({
    type: keyword("mod-obj"),
    "page-id": uuid(change["page-id"]),
    id: uuid(change.id),
    operations: change.operations.map(encodeSetOperation),
  });
}

// The pre-encoded body of one update-file commit (AD5):
// {:id uuid :session-id uuid :revn int :vern int :changes [<change>...]}
// with keyword keys, ready for lib/rpc's cmdEncoded.
export function encodeUpdateFile(params: UpdateFileParams): string {
  return writer.write(
    keywordMap({
      id: uuid(params.id),
      "session-id": uuid(params["session-id"]),
      revn: params.revn,
      vern: params.vern,
      changes: params.changes.map(encodeUpdateChange),
    }),
  );
}