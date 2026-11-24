#!/usr/bin/env node
// Transit+JSON golden corpus generator (PLAN.md §4, M1 T1.5).
//
// transit-js is the same library the Penpot CLJS frontend bundles, so it acts
// as the oracle for wire form. This script writes fixtures/transit-corpus.json:
// each entry pairs a JS expression with the exact text transit-js produced.
// crates/transit/tests/golden_corpus.rs decodes every `wire` and re-encodes it,
// asserting the bytes equal `expect_wire`. `expect_wire` is derived rather than
// hand-waved: it is what transit-js itself produces when it reads the document
// and writes it again, so the Rust codec is pinned against the oracle's own
// canonical form. `canonical` is true when that equals `wire` (the input was
// already a fixed point); `expectSource` records how the expectation was got.
//
// Usage (from backend-rust/):  node fixtures/gen-transit-corpus.mjs
// Point REQUIRE_FROM at any package.json whose node_modules holds transit-js if
// the default location is not there.

import { createRequire } from "module";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const require = createRequire(
  process.env.REQUIRE_FROM ??
    resolve(HERE, "../../frontend-nextjs/package.json"),
);
const transit = require("transit-js");

const writer = transit.writer("json");
const {
  keyword,
  map,
  uuid,
  date,
  bigInt,
  bigDec,
  symbol,
  list,
  set,
  tagged,
  uri,
} = transit;

const cases = [];
const reader = transit.reader("json");

// The canonical form of a document is whatever the oracle itself produces when it
// reads the document and writes it again. transit-js throws for a couple of
// degenerate inputs (a bare Tag object leaks into its writer), and our model
// normalises a few JVM spellings differently on purpose; those cases are pinned
// in EXPECTS.
function canonicalize(wire) {
  try {
    return writer.write(reader.read(wire));
  } catch {
    return null;
  }
}

// Our model's intentional normalisations, keyed by case name.
const EXPECTS = {
  // The reader folds the JVM verbose spellings onto the canonical scalar tags.
  "uuid-verbose-tag": '["~#\'","~u5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"]',
  "inst-verbose-tag": '["~#\'","~t2023-11-14T22:13:20.000Z"]',
  // An unwritten cache slot reads as nil; we write it back as the `~_` key.
  "cache-code-never-written": '["^ ","~:key000",1,"~_",2]',
  // transit-js cannot re-encode either of these (the leaked Tag makes its writer
  // throw), so the expectation is hand-pinned.
  "lone-tilde": '["~#",""]',
  "nested-quoted-vector": '["~#list",[1,2]]',
};

function finish() {
  for (const c of cases) {
    const derived = canonicalize(c.wire);
    c.expect_wire = EXPECTS[c.name] ?? derived ?? c.wire;
    c.canonical = c.expect_wire === c.wire;
    c.expectSource = EXPECTS[c.name]
      ? "hand-pinned (intentional normalisation)"
      : derived === null
        ? "hand-pinned (oracle writer throws)"
        : "oracle read+write";
  }
}

/** Encode `value` with the oracle and record one corpus entry. */
function record(name, note, value, opts = {}) {
  const wire = writer.write(value);
  cases.push({
    name,
    note,
    wire,
    oracle: `transit.writer("json").write(<${name}>)`,
    ...(opts.expect !== undefined ? { expect: opts.expect } : {}),
  });
  return wire;
}

/** Push a hand-written wire form (a shape transit-js cannot emit). */
function raw(name, note, wire, opts = {}) {
  cases.push({
    name,
    note,
    wire,
    oracle: "hand-written",
    ...(opts.expect !== undefined ? { expect: opts.expect } : {}),
  });
}

// ---------------------------------------------------------------------------
// 1. Ground scalars. Every one of them is quoted at the top level by
//    `marshalTop`/`maybeQuoted` (single-character handler tag).
// ---------------------------------------------------------------------------
record("nil", "null is a 1-char tag (_), so it is quoted", null);
record("true", "booleans become ~?t/~?f in key position", true);
record("false", "the false spelling is 'f'", false);
record("integer", "integers cross as bare JSON numbers", 42);
record("negative-integer", "sign kept", -7);
record("zero", "0", 0);
record("double", "4.5", 4.5);
record("integral-double", "JS has no int/double split: 3.0 prints as 3", 3.0);
record("double-fraction", "0.1", 0.1);
record("double-precision", "1/7 shortest round-trip digits", 1 / 7);
record("double-1e20", "fixed notation while k <= 21", 1e20);
record("double-1e21", "exponential above 1e21, with e+", 1e21);
record("double-1e-6", "fixed notation down to 1e-6", 1e-6);
record("double-1e-7", "exponential below 1e-6", 1e-7);
record("double-negative-zero", "JSON.stringify(-0) is 0", -0, {
  note: "-0 collapses to 0 on the wire, so decode sees Integer(0)",
});
record("double-infinity", "special doubles take the ~z tag", Infinity);
record("double-negative-infinity", "~z-INF", -Infinity);
record("double-nan", "~zNaN", NaN);

// ---------------------------------------------------------------------------
// 2. Strings: escaping, short vs long, unicode.
// ---------------------------------------------------------------------------
record("string", "plain string", "hello");
record("string-short", "2 chars", "ab");
record("string-empty", "empty string", "");
record("string-tilde", "leading ~ is escaped by doubling it", "~:hello");
record("string-caret", "leading ^ is escaped with a ~ prefix", "^hello");
record("string-backtick", "leading ` is escaped with a ~ prefix", "`hello");
record("string-inner-tilde", "only the first char matters", "a~b");
record("string-quote", "JSON escape for the double quote", 'a"b');
record("string-backslash", "JSON escape for the backslash", "a\\b");
record("string-tab", "\\t short escape", "a\tb");
record("string-newline", "\\n short escape", "a\nb");
record("string-control", "other control chars use \\u00xx", "a\u{0b}b");
record("string-unicode", "non-ASCII is not escaped", "café☃");
record("keyword", "keyword with a namespace slash", keyword("foo/bar"));
record("keyword-simple", "plain keyword", keyword("a"));
record("symbol", "~$ tag", symbol("sym"));

// ---------------------------------------------------------------------------
// 3. Penpot scalar tags (app.common.transit.cljc).
// ---------------------------------------------------------------------------
record("uuid", "~u tag", uuid("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"));
record("instant", "~m epoch millis", new Date(1700000000000));
record("instant-epoch", "~m0", new Date(0));
record("bigint", "~n arbitrary precision integer", bigInt("12345678901234567890"));
record("bigdec", "~f arbitrary precision decimal", bigDec("3.14159265358979323846"));
record("uri", "Penpot registers the multi-char tag ~#uri", uri("https://example.com/a"));

// ---------------------------------------------------------------------------
// 4. Collections.
// ---------------------------------------------------------------------------
record("array", "a JS array is a transit array: bare JSON", [1, 2, 3]);
record("array-empty", "empty array", []);
record("array-mixed", "heterogeneous", [1, "two", keyword("three"), true, null]);
record("list", "transit list ~#list", list([1, 2, 3]));
record("list-empty", "empty vector", list([]));
record("set", "transit set ~#set", set([1, 2]));
record("set-empty", "empty set", set([]));
record("ordered-set", "Penpot's ~#ordered-set (lambdaisland LinkedSet)", tagged("ordered-set", [1, 2, 3]));
record("ordered-map", "~#ordered-map rep is a FLAT array of pairs", tagged("ordered-map", [keyword("a"), 1, keyword("b"), 2]));
record("cmap", "~#cmap rep is a flat array too", tagged("cmap", [list([1, 2]), "x"]));

// ---------------------------------------------------------------------------
// 5. Maps.
// ---------------------------------------------------------------------------
record("map-empty", "the marker alone", map());
record("map-keyword", "keyword keys", map([keyword("a"), 1, keyword("b"), "x"]));
record("map-string", "plain string keys", map(["k1", "v1"]));
record("map-nested", "nested map", map([keyword("a"), 1, keyword("b"), map([keyword("c"), "x"])]));
record("map-of-list", "a vector inside a map", map([keyword("items"), list([1, 2])]));
record("map-many-keys", "ten keys, order preserved", map(
  Array.from({ length: 10 }, (_, i) => [keyword("key" + i), i]),
));

// ---------------------------------------------------------------------------
// 6. Referent cache. These are the cases that catch a wrong cache policy:
//    the writer caches map keys longer than 3 chars, and in value position only
//    referents that look like transit syntax (~: / ~$ / ~#).
// ---------------------------------------------------------------------------
record("cache-keyword-key", "a repeated long keyword key becomes ^N", map([
  keyword("aaaaaaaa"), map([keyword("x"), 1]),
  keyword("bbbbbbbb"), map([keyword("y"), 2]),
  keyword("aaaaaaaa"), map([keyword("z"), 3]),
]));
record("cache-keyword-value", "keyword values are cacheable (~: prefix)", map([
  keyword("k1"), keyword("vvvvvv"),
  keyword("k2"), keyword("vvvvvv"),
]));
record("cache-string-key", "plain strings are cached only in key position", map([
  "kkkkkkkk", "vvvvvv",
  "jjjjjjjj", "wwwwww",
  "kkkkkkkk", "zzzzzz",
]));
record("cache-uuid-value-not-cached", "UUIDs never get a cache slot (~u is not syntax)", map([
  keyword("a"), uuid("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"),
  keyword("b"), uuid("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"),
]));
record("cache-instant-value-not-cached", "~m is not cacheable either", map([
  keyword("a"), new Date(1700000000000),
  keyword("b"), new Date(1700000000000),
]));
record("cache-in-vector", "the vector rep caches its keyword items", map([
  keyword("arr"), list([keyword("shared"), keyword("shared")]),
  keyword("after"), keyword("shared"),
]));
record("cache-tag-token", "a repeated ~#list tag becomes a cache code", list([list([1, 2]), 3]));
record("cache-many-entries", "45 keys forces two-character cache codes", map(
  Array.from({ length: 45 }, (_, i) => [keyword("name" + String(i).padStart(3, "0")), keyword("name" + String(i).padStart(3, "0"))]),
));
record("cache-short-key-not-cached", "keys of 3 or fewer chars are never cached", map([
  keyword("ab"), 1,
  keyword("cd"), 2,
  keyword("ab"), 3,
]));
record("cache-duplicate-symbol", "symbols cache like keywords", map([
  keyword("a"), symbol("shared_symbol"),
  keyword("b"), symbol("shared_symbol"),
]));

// ---------------------------------------------------------------------------
// 7. Tagged / quoted forms.
// ---------------------------------------------------------------------------
record("tagged-unknown-long", "an unknown multi-char tag stays a tagged value", tagged("custom/thing", map([keyword("a"), 1])));
record("tagged-unknown-short", "a 1-char tag with a string rep uses the ~qabc form", tagged("q", "abc"));
record("tagged-shape", "Penpot record tag (identity handler in lib/transit.ts)", tagged("shape", map([keyword("id"), "s1", keyword("type"), keyword("frame"), keyword("name"), "Board"])));
record("tagged-point", "geom point record", tagged("point", [1.5, 2.5]));
record("tagged-matrix", "geom matrix record", tagged("matrix", map([keyword("a"), 1, keyword("b"), 0])));
record("tagged-rect", "geom rect record", tagged("rect", map([keyword("x"), 0, keyword("y"), 0, keyword("width"), 100, keyword("height"), 50])));
record("tagged-fills", "~#penpot/fills wraps a vector", tagged("penpot/fills", list([map([keyword("fillColor"), "#ff0000"]) ])));
record("pointer", "~#penpot/pointer rep is [id meta]", tagged("penpot/pointer", [uuid("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"), map([keyword("type"), keyword("shape")])]));
record("pointer-no-meta", "nil meta decodes to no meta", tagged("penpot/pointer", [uuid("00000000-0000-0000-0000-000000000000"), null]));
record("duration", "JVM Duration, rep is millis", tagged("duration", 1500));
record("with-meta-nested", "~#with-meta rep is [value meta]", tagged("with-meta", [list([1, 2]), map([keyword("a"), 1])]));

// ---------------------------------------------------------------------------
// 8. penpot/path-data: packed 28-byte little-endian segments over ~b binary.
// ---------------------------------------------------------------------------
function pathBytes(writers) {
  const bytes = new Uint8Array(writers.length * 28);
  const view = new DataView(bytes.buffer);
  writers.forEach((write, index) => write(view, index * 28));
  return bytes;
}
const moveTo = (v, o, x, y) => { v.setInt16(o, 1, true); v.setFloat32(o + 20, x, true); v.setFloat32(o + 24, y, true); };
const lineTo = (v, o, x, y) => { v.setInt16(o, 2, true); v.setFloat32(o + 20, x, true); v.setFloat32(o + 24, y, true); };
const curveTo = (v, o, c1x, c1y, c2x, c2y, x, y) => {
  v.setInt16(o, 3, true);
  v.setFloat32(o + 4, c1x, true); v.setFloat32(o + 8, c1y, true);
  v.setFloat32(o + 12, c2x, true); v.setFloat32(o + 16, c2y, true);
  v.setFloat32(o + 20, x, true); v.setFloat32(o + 24, y, true);
};
const closePath = (v, o) => v.setInt16(o, 4, true);

const path4 = pathBytes([
  (v, o) => moveTo(v, o, 10, 20),
  (v, o) => lineTo(v, o, 30, 40),
  (v, o) => curveTo(v, o, 1, 2, 3, 4, 5, 6),
  closePath,
]);
record("path-data", "the four segment kinds", tagged("penpot/path-data", path4), {
  expect: { svg: "M10,20L30,40C1,2,3,4,5,6Z" },
});
record("path-data-empty", "a zero-length buffer", tagged("penpot/path-data", new Uint8Array(0)));
record("path-data-clamped", "coords beyond the safe-int bounds are clamped on read", tagged("penpot/path-data", pathBytes([
  (v, o) => moveTo(v, o, 3e9, -3e9),
])));
// transit.binary() is the *read* side constructor (it takes base64 text); the
// writer consumes a Uint8Array directly through transit-js's binary handler.
record("binary-empty", "empty binary", new Uint8Array(0));
record("binary-full-range", "base64 padding and high bytes", new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255]));

// ---------------------------------------------------------------------------
// 9. penpot/objects-map/v2: values are nested transit strings, and the outer
//    document must not lose its cache positions (lib/transit.ts asserts the
//    same invariant for the shell).
// ---------------------------------------------------------------------------
const shapeString = '["~#shape",["^ ","~:id","s1","~:type","~:frame","~:name","Board"]]';
const objectsMapDoc = () => map([
  keyword("objects"),
  tagged("penpot/objects-map/v2", map([keyword("s1"), shapeString])),
  keyword("aa"), "1",
  keyword("bb"), "2",
  keyword("again"), map([keyword("s1"), "plain"]),
]);
record("objects-map", "nested transit string under a uuid-ish key", objectsMapDoc());
record("objects-map-two-shapes", "two nested docs", map([
  keyword("objects"),
  tagged("penpot/objects-map/v2", map([
    keyword("s1"), shapeString,
    keyword("s2"), '["~#shape",["^ ","~:id","s2","~:type","~:rect"]]',
  ])),
]));

// ---------------------------------------------------------------------------
// 10. Hand-written forms: things only the JVM/CLJ side or a hostile producer
//     sends. transit-js cannot emit them, so the text is pinned directly.
// ---------------------------------------------------------------------------
raw("verbose-map-object", "a JSON object is the verbose map form; the writer normalises to ^ ",
  '{"a":1,"b":true}');
raw("verbose-tagged-object", "a 1-key object whose key is a tag is a tagged value",
  '{"~#list":[1,2]}');
raw("cache-code-never-written", "reading an unwritten slot yields nil (transit-js yields undefined)",
  '["^ ","~:key000",1,"^49",2]');
raw("lone-tilde", "a bare ~ decodes to a tag with an empty name", '"~"');
raw("escaped-double-tilde", "~~~x unescapes to ~~x", '"~~~x"');
raw("uuid-verbose-tag", "the JVM may spell UUIDs as ~#uuid (T1.6 / C2)",
  '["~#uuid","5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"]');
raw("inst-verbose-tag", "and instants as ~#inst (T1.6 / C2)",
  '["~#inst","2023-11-14T22:13:20.000Z"]');
raw("transit-r-uri", "transit's own single-char URI tag must decode like ~#uri",
  '"~rhttps://example.com/a"');
raw("nested-quoted-vector", "a quoted vector at top level", '["~#\'",["~#list",[1,2]]]');
raw("map-with-quoted-key", "quoted keyword as a map key", '["^ ",["~#\'","~:a"],1]');

// ---------------------------------------------------------------------------
// 11. Realistic RPC payload shapes (dashboard-ish), exercising the writer under
//     load so cache codes and every tag family show up in one document.
// ---------------------------------------------------------------------------
record("rpc-get-teams", "a vector of maps, the get-teams answer shape", list([
  map([
    keyword("id"), uuid("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"),
    keyword("name"), "Acme Inc",
    keyword("created-at"), new Date(1700000000000),
    keyword("is-membership-admin"), false,
  ]),
  map([
    keyword("id"), uuid("00000000-0000-0000-0000-000000000000"),
    keyword("name"), "Acme Inc",
    keyword("created-at"), new Date(1700000000000),
    keyword("is-membership-admin"), true,
  ]),
]));
record("rpc-params-keyword-nested", "command params: keyword keys all the way down", map([
  keyword("id"), uuid("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"),
  keyword("session-id"), uuid("11111111-1111-1111-1111-111111111111"),
  keyword("revn"), 3,
  keyword("vern"), 12,
  keyword("changes"), list([
    map([
      keyword("type"), keyword("mov-objects"),
      keyword("page-id"), uuid("22222222-2222-2222-2222-222222222222"),
      keyword("parent-id"), uuid("33333333-3333-3333-3333-333333333333"),
      keyword("shapes"), list([uuid("44444444-4444-4444-4444-444444444444")]),
    ]),
  ]),
]));
record("rpc-error-body", "an ex-data shaped error payload", map([
  keyword("type"), keyword("verification/error"),
  keyword("code"), keyword("wrong-credentials"),
  keyword("hint"), "Email or password is wrong",
]));
record("rpc-204-empty", "the empty answer is nil", null);

// ---------------------------------------------------------------------------

const ORACLE_VERSION = (() => {
  try {
    return require("transit-js/package.json").version ?? "unknown";
  } catch {
    return "unknown";
  }
})();

const out = {
  generatedBy: "backend-rust/fixtures/gen-transit-corpus.mjs",
  oracle: "transit-js " + ORACLE_VERSION,
  note: "wire is byte-exact oracle output; expect_wire is the canonical form (oracle read+write, or hand-pinned where its writer throws or we normalise on purpose)",
  cases,
};

finish();

const target = resolve(HERE, "transit-corpus.json");
writeFileSync(target, JSON.stringify(out, null, 2) + "\n", "utf8");
const canonical = cases.filter((c) => c.canonical).length;
const pinned = cases.filter((c) => c.expectSource.startsWith("hand-pinned"));
console.log(`wrote ${cases.length} cases to ${target}`);
console.log(`  already canonical: ${canonical}/${cases.length}`);
console.log(`  hand-pinned expectation: ${pinned.length} (${pinned.map((c) => c.name).join(", ")})`);
