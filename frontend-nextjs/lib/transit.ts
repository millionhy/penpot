// Transit codec. The Clojure backend speaks application/transit+json on
// /api/main/methods/* (app.common.transit in the CLJS frontend). transit-js is
// the same Cognitect library the CLJS build uses, so keywords, uuids, instants
// and tagged values round-trip identically.
//
// TODO(Phase-F): port the custom read/write handlers from
// common/src/app/common/transit.cljc (uuid, instant, keyword namespaces,
// file/change tags). The scaffold covers the keyword-keyed maps used by the
// auth/profile/teams commands.

import transit from "transit-js";

const reader = transit.reader("json");
const writer = transit.writer("json");

export function decodeTransit<T = unknown>(text: string): T {
  return reader.read(text) as T;
}

export function encodeTransit(value: unknown): string {
  return writer.write(value);
}

// Encode a plain params object as a transit map whose keys are keywords, which
// is what the Clojure RPC handlers expect (http/transit-data in repo.cljs).
export function encodeParams(params: Record<string, unknown>): string {
  const kv: unknown[] = [];
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined) continue;
    kv.push(transit.keyword(key));
    kv.push(value);
  }
  const map = transit.map.apply(null, kv);
  return writer.write(map);
}

export function keyword(name: string): unknown {
  return transit.keyword(name);
}

export function uuid(value: string): unknown {
  return transit.uuid(value);
}