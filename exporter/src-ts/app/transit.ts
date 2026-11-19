// app.common.transit and app.util.transit, Node side.
//
// Two writers coexist in the CLJS exporter and the split matters on the wire:
// HTTP error bodies and the legacy export answer use the verbose JSON form
// (app.util.transit), while redis job records and the websocket updates use the
// compact form (app.common.transit). Readers normalize maps to plain objects
// with string keys, uuids to strings and instants to Date, like the F1.1 codec
// of the Next shell.
//
// The CLJS job records carry keyword keys (:state, :profile-id...), so the
// encoder keeps a `keywordMap` helper for every record built here.

import transit from "transit-js";

type Dict = Record<string, unknown>;

const readerOptions = {
  handlers: {
    ":": (rep: string) => rep,
    u: (rep: string) => rep,
    m: (rep: string) => new Date(Number.parseInt(rep, 10)),
    n: (rep: string) => Number.parseInt(rep, 10),
    duration: (rep: unknown) => Number(rep),
    uri: (rep: string) => rep,
    "ordered-map": (rep: unknown) => pairsToObject(rep),
    "ordered-set": (rep: unknown) => (Array.isArray(rep) ? rep : []),
    set: (rep: unknown) => (Array.isArray(rep) ? rep : []),
    list: (rep: unknown) => (Array.isArray(rep) ? rep : []),
    "penpot/pointer": (rep: unknown) => {
      const pair = Array.isArray(rep) ? rep : [];
      return { id: String(pair[0]), metadata: pair[1] };
    },
    "penpot/path-data": (rep: unknown) => pathDataBytes(rep),
    // Page scenes arrive with the records tagged (`~#shape`, `~#matrix`,
    // `~#point`, `~#rect`). The CLJS reader revived them as records; every
    // consumer here reads their plain map, so each tag unwraps to its value.
    shape: (rep: unknown) => rep,
    matrix: (rep: unknown) => rep,
    point: (rep: unknown) => rep,
    rect: (rep: unknown) => rep,
  },
  mapBuilder: {
    init: () => ({}) as Dict,
    add: (map: Dict, key: unknown, value: unknown) => {
      map[String(key)] = value;
      return map;
    },
    finalize: (map: Dict) => map,
  },
};

// The CLJS PathData handler writes its raw segment buffer as a transit binary
// (`~b`): Node's reader hands over a Buffer and the browser one a Uint8Array.
// The wasm path setter wants the bytes, so every accepted shape becomes a plain
// copy of them.
export function pathDataBytes(rep: unknown): Uint8Array {
  if (rep instanceof Uint8Array) return new Uint8Array(rep);
  if (rep instanceof ArrayBuffer) return new Uint8Array(rep.slice(0));
  if (ArrayBuffer.isView(rep)) {
    const view = rep as ArrayBufferView;
    const bytes = new Uint8Array(view.byteLength);
    bytes.set(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    return bytes;
  }
  // Older readers decode `~b` to a binary string, one char per byte.
  if (typeof rep === "string") {
    return Uint8Array.from(rep, (char) => char.charCodeAt(0) & 0xff);
  }
  throw new Error("invalid path data");
}

function pairsToObject(pairs: unknown): Dict {
  const out: Dict = {};
  if (Array.isArray(pairs)) {
    for (const entry of pairs) {
      if (Array.isArray(entry) && entry.length >= 2) out[String(entry[0])] = entry[1];
    }
  }
  return out;
}

// t/decode-str builds a fresh reader per call; the shared reader clears its
// cache after every read, so nesting one inside another would corrupt it.
export function decode<T = unknown>(text: string): T {
  return transit.reader("json", readerOptions).read(text) as T;
}

const compact = transit.writer("json");
const verbose = transit.writer("json-verbose");

export interface EncodeOptions {
  verbose?: boolean;
}

export function encode(value: unknown, options: EncodeOptions = {}): string {
  const writer = options.verbose === true ? verbose : compact;
  return writer.write(value);
}

// A transit map with keyword keys. transit-js's transit.map() takes no
// variadic arguments, so entries are set one by one; undefined values are
// dropped, which is what d/without-nils did at the call sites.
export function keywordMap(entries: Dict): unknown {
  const map = transit.map();
  for (const key of Object.keys(entries)) {
    const value = entries[key];
    if (value === undefined) continue;
    map.set(transit.keyword(key), value);
  }
  return map;
}

export function keyword(name: string): unknown {
  return transit.keyword(name);
}

export function uuid(value: string): unknown {
  return transit.uuid(value);
}

// A transit set. The get-page RPC takes `object-id` as a set of uuids, and the
// backend reads the same tag the CLJS exporter writes.
export function set(values: readonly unknown[]): unknown {
  return transit.set([...values]);
}

// The verbose form of one error/validation body, matching
// app.util.transit/encode in app.handlers/on-error.
export function encodeVerbose(value: unknown): string {
  return verbose.write(value);
}
