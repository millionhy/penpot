// Transit codec. The Clojure backend speaks application/transit+json on
// /api/main/methods/* (app.common.transit in the CLJS frontend). transit-js is
// the same Cognitect library the CLJS build uses, so keywords, uuids, instants
// and tagged values round-trip identically.
//
// Decoding is normalized to plain JS values at this boundary: keyword-keyed
// transit maps become ordinary objects with string keys, uuids ("~u") become
// strings and instants ("~m" millis) become Dates. The CLJS frontend consumes
// transit Maps directly; TS pages consume plain objects instead.
//
// TODO(Phase-F): port the remaining custom read/write handlers from
// common/src/app/common/transit.cljc (file/change tags, points, etc.) as the
// migrated commands start needing them.

import transit from "transit-js";

interface MutableRecord {
  [key: string]: unknown;
}

// transit-js reader options: plain-object maps + scalar normalization.
const readerOptions = {
  handlers: {
    // "~u<uuid>" -> string
    u: (rep: string) => rep,
    // "~m<millis>" -> Date
    m: (rep: string) => new Date(Number.parseInt(rep, 10)),
    // keyword scalars ("~:foo") -> string
    ":": (rep: string) => rep,
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