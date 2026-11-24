//! Transit+JSON writer.
//!
//! Port of `com.cognitect.transit.impl.writer` (`JSONMarshaller` +
//! `writer.marshal` + `WriteCache`) with Penpot's write handlers from
//! `common/src/app/common/transit.cljc`. Output is built as JSON text directly —
//! no `serde_json` intermediate — so number formatting and string escaping match
//! `JSON.stringify` byte for byte (see [`crate::json`]).
//!
//! Rules the golden corpus pins down (`fixtures/transit-corpus.json`):
//!
//! * **Top-level scalars are quoted.** `marshalTop` runs `maybeQuoted`, which
//!   wraps anything whose handler tag is a single character: `42` becomes
//!   `["~#'",42]`, an instant becomes `["~#'","~m1700000000000"]`. Maps, arrays
//!   and multi-character tagged values are written bare.
//! * **Scalars in map-key position are re-tagged** (`~_`, `~?t`, `~i42`,
//!   `~d4.5`), because a JSON slot has to stay distinguishable from a referent.
//! * **One referent cache per document**, generation-bumped after each write, so
//!   a string seen in an earlier document allocates a fresh slot instead of
//!   emitting a dangling code.
//! * **Vectors are `~#list`, arrays are bare.** Writing a [`Value::List`] as a
//!   bare array is what blanks the dashboard; writing a [`Value::Array`] as
//!   `~#list` silently changes what the receiving Clojure code dereferences.

use std::collections::HashMap;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    cache::{idx_to_code, is_cacheable, MAX_CACHE_ENTRIES},
    json::{escape_json_string, fmt_f64},
    value::{Map, Set, Value},
};

/// `caching.WriteCache`.
#[derive(Debug, Default)]
struct WriteCache {
    idx: u32,
    gen: u32,
    entries: HashMap<String, (String, u32)>,
}

impl WriteCache {
    /// `WriteCache.prototype.write`: return the referent itself (first use in
    /// this generation) or its cache code.
    fn write(&mut self, referent: &str, as_map_key: bool) -> String {
        if !is_cacheable(referent, as_map_key) {
            return referent.to_owned();
        }
        // transit-js never increments `cacheSize`, so only the index overflow
        // branch of its reset logic is reachable; mirrored here.
        if usize::try_from(self.idx).unwrap_or(usize::MAX) == MAX_CACHE_ENTRIES {
            self.clear();
        }
        match self.entries.get(referent) {
            None => self.assign(referent),
            // A stale generation means the referent was seen before the cache
            // index restarted: allocate a fresh slot.
            Some((_, entry_gen)) if *entry_gen != self.gen => self.assign(referent),
            Some((code, _)) => code.clone(),
        }
    }

    /// Reserve the next slot for `referent` and emit it in full.
    fn assign(&mut self, referent: &str) -> String {
        let code = idx_to_code(self.idx as usize);
        self.entries.insert(referent.to_owned(), (code, self.gen));
        self.idx += 1;
        referent.to_owned()
    }

    /// `WriteCache.prototype.clear`: restart the index, bump the generation.
    fn clear(&mut self) {
        self.idx = 0;
        self.gen = self.gen.wrapping_add(1);
    }
}

/// Transit+JSON writer.
#[derive(Debug, Default)]
pub struct Writer {
    cache: WriteCache,
}

impl Writer {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Encode one document, applying the top-level quoting rule.
    ///
    /// Infallible: every [`Value`] variant has a wire spelling, and a `Value` a
    /// caller built by hand cannot violate that.
    #[must_use]
    pub fn encode(&mut self, value: &Value) -> String {
        let mut out = String::new();
        // `marshalTop` runs `maybeQuoted`: single-character handler tags are
        // wrapped so the reader still reaches their handler.
        if top_needs_quoting(value) {
            let wrapper = Value::Quoted(Box::new(value.clone()));
            self.marshal(&wrapper, false, &mut out);
        } else {
            self.marshal(value, false, &mut out);
        }
        self.cache.clear();
        out
    }

    /// A cached `~#tag` token as JSON text, e.g. `"~#list"` (or `"^7"` when the
    /// tag string was already emitted in this document).
    fn tag_token(&mut self, tag: &str) -> String {
        // `emitTaggedMap` passes `asMapKey = true` for the tag token, so tag
        // strings are cacheable whenever they are longer than 3 chars.
        let referent = format!("~#{tag}");
        let written = self.cache.write(&referent, true);
        let mut out = String::new();
        escape_json_string(&written, &mut out);
        out
    }

    /// `emitTaggedMap`, non-verbose shape: `["~#tag", rep]`.
    fn tagged_array(&mut self, tag: &str, rep: &Value, out: &mut String) {
        let token = self.tag_token(tag);
        out.push('[');
        out.push_str(&token);
        out.push(',');
        self.marshal(rep, false, out);
        out.push(']');
    }

    /// `emitString(prefix + tag + rep)` then JSON-quote the (possibly coded)
    /// referent.
    fn referent(&mut self, referent: String, as_map_key: bool, out: &mut String) {
        let written = self.cache.write(&referent, as_map_key);
        escape_json_string(&written, out);
    }

    /// `writer.marshal`: dispatch on the value, honouring map-key position.
    ///
    /// One match over every variant, like the JS original: splitting it would
    /// scatter the tag table across several functions.
    #[allow(clippy::too_many_lines)]
    fn marshal(&mut self, value: &Value, as_map_key: bool, out: &mut String) {
        match value {
            Value::Nil => {
                if as_map_key {
                    self.referent("~_".to_owned(), true, out);
                } else {
                    out.push_str("null");
                }
            }
            Value::Bool(b) => {
                if as_map_key {
                    let rep = if *b { "~?t" } else { "~?f" };
                    self.referent(rep.to_owned(), true, out);
                } else {
                    out.push_str(if *b { "true" } else { "false" });
                }
            }
            Value::Integer(i) => {
                if as_map_key {
                    self.referent(format!("~i{i}"), true, out);
                } else {
                    out.push_str(&i.to_string());
                }
            }
            Value::Double(d) => {
                if as_map_key {
                    self.referent(format!("~d{}", fmt_f64(*d)), true, out);
                } else {
                    out.push_str(&fmt_f64(*d));
                }
            }
            Value::Special(s) => self.referent(format!("~z{}", s.rep()), as_map_key, out),
            Value::Char(c) => self.referent(format!("~c{c}"), as_map_key, out),
            Value::BigInteger(rep) => self.referent(format!("~n{rep}"), as_map_key, out),
            Value::BigDecimal(rep) => self.referent(format!("~f{rep}"), as_map_key, out),
            Value::Keyword(name) => self.referent(format!("~:{name}"), as_map_key, out),
            Value::Symbol(name) => self.referent(format!("~${name}"), as_map_key, out),
            Value::Str(s) => {
                // tag "s": no prefix, the literal escaped, cached in key position
                self.referent(escape_string_literal(s), as_map_key, out);
            }
            Value::Binary(bytes) => {
                self.referent(format!("~b{}", STANDARD.encode(bytes)), as_map_key, out);
            }
            Value::Uuid(u) => self.referent(format!("~u{u}"), as_map_key, out),
            Value::Instant(ms) => self.referent(format!("~m{ms}"), as_map_key, out),
            Value::VerboseInstant(rep) => self.referent(format!("~t{rep}"), as_map_key, out),
            // Penpot registers `{:id "uri" :class URI :wfn str}`, so its writer
            // emits `["~#uri","…"]`. transit's own `~r` spelling is accepted on
            // read and normalised to this variant; writing `~r` would hand the
            // JS shell an unresolved TaggedValue, because its reader only
            // registers the `uri` handler.
            Value::Uri(uri) => {
                self.tagged_array("uri", &Value::Str(uri.clone()), out);
            }
            // `{:id "duration" :wfn inst-ms}` — rep is a millisecond integer.
            Value::Duration(ms) => self.tagged_array("duration", &Value::Integer(*ms), out),
            Value::Array(items) => {
                out.push('[');
                for (i, item) in items.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    self.marshal(item, false, out);
                }
                out.push(']');
            }
            Value::List(items) => {
                self.tagged_array("list", &Value::Array(items.clone()), out);
            }
            Value::Set(items) => self.tagged_array("set", &set_as_array(items), out),
            Value::OrderedSet(items) => {
                self.tagged_array("ordered-set", &set_as_array(items), out);
            }
            Value::Map(map) => self.emit_map(map, out),
            Value::OrderedMap(map) => {
                // `:wfn vec` on a map yields a *flat* array of pairs.
                self.tagged_array("ordered-map", &flat_pairs(map), out);
            }
            Value::Cmap(pairs) => {
                // Same flat shape, but `emitMap`'s cmap branch marshals the keys
                // in value position (`asMapKey = false`).
                let rep = Value::Array(
                    pairs
                        .iter()
                        .flat_map(|(k, v)| [k.clone(), v.clone()])
                        .collect(),
                );
                self.tagged_array("cmap", &rep, out);
            }
            Value::Quoted(inner) => {
                // emitQuoted, non-verbose: `["~#'", rep]`. `"~#'"` is 3 chars so
                // it is never cached.
                out.push_str("[\"~#'\"");
                out.push(',');
                self.marshal(inner, false, out);
                out.push(']');
            }
            Value::WithMeta { value, meta } => {
                let rep = Value::Array(vec![(**value).clone(), (**meta).clone()]);
                self.tagged_array("with-meta", &rep, out);
            }
            Value::Pointer { id, meta } => {
                let rep = Value::Array(vec![
                    (**id).clone(),
                    meta.as_deref().cloned().unwrap_or(Value::Nil),
                ]);
                self.tagged_array("penpot/pointer", &rep, out);
            }
            Value::PathData(path) => self.tagged_array(
                "penpot/path-data",
                &Value::Binary(path.as_bytes().to_vec()),
                out,
            ),
            Value::ObjectsMap(map) => {
                // Each value is re-encoded by its own document (`t/encode-str`
                // per shape), which keeps the nested referent caches separate.
                let rep = Value::Map(
                    map.iter()
                        .map(|(k, v)| (k.clone(), encode_nested(v)))
                        .collect(),
                );
                self.tagged_array("penpot/objects-map/v2", &rep, out);
            }
            Value::Tagged { tag, rep } => {
                // emitEncoded: a 1-character tag with a string rep uses the
                // escaped-string form; everything else takes the tagged-array
                // form. "1-character" is a UTF-16 length, like the cache rule:
                // an astral tag is 2 units and therefore takes the array form.
                if tag.encode_utf16().count() == 1 {
                    if let Value::Str(s) = rep.as_ref() {
                        self.referent(format!("~{tag}{s}"), as_map_key, out);
                        return;
                    }
                }
                self.tagged_array(tag, rep, out);
            }
        }
    }

    /// `emitMap`: the compact `["^ ", k, v, …]` form. Keys are marshalled in map
    /// key position (so they get re-tagged and cached), values are not.
    fn emit_map(&mut self, map: &Map, out: &mut String) {
        out.push_str("[\"^ \"");
        for (key, value) in map.iter() {
            out.push(',');
            self.marshal(key, true, out);
            out.push(',');
            self.marshal(value, false, out);
        }
        out.push(']');
    }
}

/// Encode `value` with a throwaway writer.
#[must_use]
pub fn encode(value: &Value) -> String {
    Writer::new().encode(value)
}

/// Encode one nested value of a `penpot/objects-map/v2` rep as the transit
/// *string* the backend expects. `t/encode-str` builds a fresh writer per call,
/// and the value is written as a document of its own — top-level quoting
/// included.
fn encode_nested(value: &Value) -> Value {
    Value::Str(encode(value))
}

/// The tag-length rule behind `maybeQuoted`: single-character handler tags get
/// wrapped at the top level so a reader still reaches their handler.
#[allow(
    clippy::match_same_arms,
    reason = "the list is one variant per line for reviewability"
)]
pub(crate) fn top_needs_quoting(value: &Value) -> bool {
    match value {
        Value::Nil
        | Value::Bool(_)
        | Value::Integer(_)
        | Value::Double(_)
        | Value::Special(_)
        | Value::Char(_)
        | Value::BigInteger(_)
        | Value::BigDecimal(_)
        | Value::Keyword(_)
        | Value::Symbol(_)
        | Value::Str(_)
        | Value::Binary(_)
        | Value::Uuid(_)
        | Value::Instant(_)
        | Value::VerboseInstant(_) => true,
        // URIs go out as the multi-char `~#uri` tag, so they are written bare.
        Value::Uri(_) => false,
        // A 1-character tag carrying a string rep behaves like a scalar.
        Value::Tagged { tag, rep } => {
            tag.encode_utf16().count() == 1 && matches!(rep.as_ref(), Value::Str(_))
        }
        _ => false,
    }
}

/// `writer.escape`: a literal string starting with an escape character is
/// prefixed with `~` so the reader does not parse it as a tag.
fn escape_string_literal(s: &str) -> String {
    match s.chars().next() {
        Some('~' | '^' | '`') => format!("~{s}"),
        _ => s.to_owned(),
    }
}

fn set_as_array(items: &Set) -> Value {
    Value::Array(items.iter().cloned().collect())
}

fn flat_pairs(map: &Map) -> Value {
    let mut items = Vec::with_capacity(map.len() * 2);
    for (k, v) in map.iter() {
        items.push(k.clone());
        items.push(v.clone());
    }
    Value::Array(items)
}
