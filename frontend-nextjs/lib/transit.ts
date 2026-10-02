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
    // Pointer [id metadata] (backend pointer-map serialization)
    "penpot/pointer": (rep: unknown) => {
      const pair = Array.isArray(rep) ? rep : [];
      return new Pointer(String(pair[0]), pair[1]);
    },
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

export function decodeTransit<T = unknown>(text: string): T {
  return reader.read(text) as T;
}

export function encodeTransit(value: unknown): string {
  return writer.write(value);
}

// Encode a plain params object as a transit map whose keys are keywords, which
// is what the Clojure RPC handlers expect (http/transit-data in repo.cljs).
// NOTE: transit-js's transit.map() takes NO variadic key/value arguments; the
// map must be filled with .set(). Values may be transit scalars (see uuid())
// when a command expects e.g. a uuid instead of a plain string.
export function encodeParams(params: Record<string, unknown>): string {
  const map = transit.map();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined) continue;
    map.set(transit.keyword(key), value);
  }
  return writer.write(map);
}

export function keyword(name: string): unknown {
  return transit.keyword(name);
}

export function uuid(value: string): unknown {
  return transit.uuid(value);
}

// js/Date is written natively as "~m<millis>" by transit-js, matching the
// instant write handler in app.common.transit.
export function instant(value: Date): unknown {
  return value;
}