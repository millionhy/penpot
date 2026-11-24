//! Transit+JSON reader.
//!
//! A line-by-line port of `com.cognitect.transit.impl.decoder.Decoder` plus the
//! handlers Penpot registers in `common/src/app/common/transit.cljc` and the
//! data-side tags of `PLAN.md` §2.1.
//!
//! The input is first parsed as plain JSON (`serde_json`, which caps nesting at
//! 128 levels for us) and then decoded against the tree, so the cache advances
//! at the same points as the JS implementation. Four details separate a faithful
//! port from an approximation:
//!
//! * **`asMapKey` drives cacheability.** In value position only referents that
//!   look like transit syntax (`~:`/`~$`/`~#`) are cached; in key position every
//!   referent longer than 3 chars is. Getting this wrong desynchronises every
//!   later `^code`.
//! * **A plain array rewinds the cache** after the failed tagged-value probe,
//!   exactly like `decodeArray`.
//! * **Tagged reps are probed in both decode modes.** transit-js skips the probe
//!   while inside a tagged rep (`tagValue = true`), which leaks a bare `Tag`
//!   object into the element list for a nested tagged value. Penpot's own
//!   `~#penpot/fills` (`:wfn (vec fills)` in
//!   `common/src/app/common/types/fills/impl.cljc`) has exactly that shape, so we
//!   probe regardless; the deviation is recorded in `TODO-ONLINE.md`.
//! * **A bare `~#tag` token is itself a cacheable referent.** The writer caches
//!   the tag string of a repeated tagged value, so `["^0",[1,2]]` has to resolve
//!   through the cache and still reach the `list` handler. That is why the cache
//!   stores [`Decoded`] (tag *or* value) and not `Value`.
//! * **Nested `penpot/objects-map/v2` values decode through a fresh reader** so
//!   the outer cache survives (the backend does the same via `t/decode-str`).

use base64::{engine::general_purpose::STANDARD, Engine as _};
use serde_json::{Map as JsonObject, Number, Value as Json};
use uuid::Uuid;

use crate::{
    cache::{is_cache_code, is_cacheable, ReadCache},
    error::{Error, Result, TagRef},
    value::{Map, PathData, Set, SpecialDouble, Value},
};

/// Reader entry point. Owns a referent cache.
#[derive(Debug, Default)]
pub struct Reader {
    cache: ReadCache<Decoded>,
}

/// What a referent decodes to: a value, or a bare tag token waiting for its rep.
#[derive(Clone, Debug)]
pub enum Decoded {
    Tag(String),
    Value(Value),
}

impl Decoded {
    #[must_use]
    pub fn into_value(self) -> Value {
        match self {
            Self::Value(v) => v,
            // A bare tag token in a value/key position. The backend never writes
            // this; keeping the tag name beats dropping it.
            Self::Tag(tag) => Value::tagged(tag, Value::Nil),
        }
    }

    #[must_use]
    pub fn as_tag(&self) -> Option<&str> {
        match self {
            Self::Tag(tag) => Some(tag),
            Self::Value(_) => None,
        }
    }
}

impl Reader {
    #[must_use]
    pub fn new() -> Self {
        Self {
            cache: ReadCache::new(),
        }
    }

    /// Decode one document. The cache resets before and after, matching
    /// `Reader.prototype.read` (transit-js clears its cache after every read).
    ///
    /// # Errors
    ///
    /// [`Error::Json`] when the text is not valid JSON, [`Error::TooDeep`] when
    /// it nests past the cap, and the structural variants (`BadRep`,
    /// `OddMapEntries`, `MalformedWithMeta`, `MalformedPointer`,
    /// `MalformedTagged`) when it is valid JSON but not valid transit.
    pub fn decode(&mut self, input: &str) -> Result<Value> {
        let json: Json = serde_json::from_str(input)?;
        self.cache.clear();
        let value = self.node(&json, false, 0)?.into_value();
        self.cache.clear();
        Ok(value)
    }

    /// Decode the value of a nested transit string with an isolated cache.
    fn decode_nested(input: &str) -> Result<Value> {
        Reader::new().decode(input)
    }

    // -- node dispatch (`Decoder.prototype.decode`) ---------------------------

    fn node(&mut self, node: &Json, as_map_key: bool, depth: usize) -> Result<Decoded> {
        if depth > MAX_DEPTH {
            return Err(Error::TooDeep { limit: MAX_DEPTH });
        }
        match node {
            Json::Null => Ok(Decoded::Value(Value::Nil)),
            Json::Bool(b) => Ok(Decoded::Value(Value::Bool(*b))),
            Json::Number(n) => Ok(Decoded::Value(number(n))),
            Json::String(s) => Ok(self.string(s, as_map_key)),
            Json::Array(items) => {
                // `node[0] === "^ "` is the transit map marker; a cache code can
                // never look like it (`isCacheCode` excludes `"^ "`).
                if matches!(items.first(), Some(Json::String(s)) if s == MAP_MARKER) {
                    return Ok(Decoded::Value(self.array_map(items, depth)?));
                }
                self.array(items, as_map_key, depth)
            }
            Json::Object(obj) => self.object(obj, depth),
        }
    }

    /// `decodeString`: cache handling, then `parseString`.
    fn string(&mut self, raw: &str, as_map_key: bool) -> Decoded {
        if is_cacheable(raw, as_map_key) {
            let parsed = parse_referent(raw);
            self.cache.write(parsed)
        } else if is_cache_code(raw) {
            self.cache.read(raw).unwrap_or(Decoded::Value(Value::Nil))
        } else {
            parse_referent(raw)
        }
    }

    // -- arrays ---------------------------------------------------------------

    fn array(&mut self, items: &[Json], as_map_key: bool, depth: usize) -> Result<Decoded> {
        // `decodeArray` records the cache index *before* the probe and restores
        // it afterwards, so a failed probe leaves no trace.
        let mark = self.cache.mark();

        // The tagged-value 2-array probe.
        //
        // transit-js only probes when `tagValue` is false, so a tagged value
        // nested one level inside another tagged rep leaks a bare Tag object
        // into the element list. That breaks Penpot's own `~#penpot/fills`, whose
        // `:wfn (vec fills)` (`common/src/app/common/types/fills/impl.cljc`)
        // makes the rep `["~#list", […]]`. Probing in both modes keeps the nested
        // tag resolved, which is what the Clojure read handlers expect and what
        // lets the document re-encode byte for byte.
        if items.len() == 2 {
            if let Json::String(first) = &items[0] {
                let probe = self.string(first, false);
                if let Some(tag) = probe.as_tag() {
                    let tag = tag.to_owned();
                    let rep = self.node(&items[1], as_map_key, depth + 1)?;
                    // On success the tag's cache slot is kept, like transit-js.
                    return Ok(Decoded::Value(Self::long_handler(&tag, rep.into_value())?));
                }
            }
        }

        // Plain array: rewind, then decode every element including the head.
        self.cache.rewind(mark);
        let mut out = Vec::with_capacity(items.len());
        for item in items {
            out.push(self.node(item, as_map_key, depth + 1)?.into_value());
        }
        Ok(Decoded::Value(Value::Array(out)))
    }

    /// `decodeArrayHash`: `["^ ", k1, v1, k2, v2, …]`.
    fn array_map(&mut self, items: &[Json], depth: usize) -> Result<Value> {
        let rest = &items[1..];
        if rest.len() % 2 != 0 {
            return Err(Error::OddMapEntries(rest.len()));
        }
        let mut map = Map::new();
        for pair in rest.chunks(2) {
            let key = self.node(&pair[0], true, depth + 1)?.into_value();
            let value = self.node(&pair[1], false, depth + 1)?.into_value();
            map.push(key, value);
        }
        Ok(Value::Map(map))
    }

    // -- objects (verbose / tagged-map form) ---------------------------------

    /// `decodeHash`: a JSON object is transit's verbose map form; a 1-key object
    /// whose key decodes to a tag is a tagged value.
    fn object(&mut self, obj: &JsonObject<String, Json>, depth: usize) -> Result<Decoded> {
        if obj.len() == 1 {
            let (raw_key, value) = obj.iter().next().expect("len 1");
            // Keys are decoded in *value* position here, exactly as decodeHash
            // does (`this.decode(key, cache, false, false)`).
            let probe = self.string(raw_key, false);
            if let Some(tag) = probe.as_tag() {
                let tag = tag.to_owned();
                let rep = self.node(value, false, depth + 1)?;
                return Ok(Decoded::Value(Self::long_handler(&tag, rep.into_value())?));
            }
        }

        let mut map = Map::new();
        for (raw_key, value) in obj {
            // decodeHash decodes object keys in map-key position.
            let key = self.string(raw_key, true).into_value();
            let value = self.node(value, false, depth + 1)?.into_value();
            map.push(key, value);
        }
        Ok(Decoded::Value(Value::Map(map)))
    }

    // -- long (multi-character) tag handlers ---------------------------------

    fn long_handler(tag: &str, rep: Value) -> Result<Value> {
        let long = || TagRef::Long(tag.to_owned());
        match tag {
            // `~#'` is a write-side hint only: transit-js's handler is identity,
            // so a quoted value decodes to the value itself.
            "'" | "quoted" => Ok(rep),
            "list" => Ok(match rep {
                Value::Array(items) => Value::List(items),
                other => Value::List(vec![other]),
            }),
            "array" => Ok(match rep {
                Value::Array(items) => Value::Array(items),
                other => Value::Array(vec![other]),
            }),
            "set" => Ok(Value::Set(seq("set", rep)?)),
            "ordered-set" => Ok(Value::OrderedSet(seq("ordered-set", rep)?)),
            "ordered-map" => Ok(Value::OrderedMap(flat_map("ordered-map", rep)?)),
            "cmap" => Ok(Value::Cmap(flat_pairs("cmap", rep)?.into_iter().collect())),
            "with-meta" => match rep {
                Value::Array(items) if items.len() == 2 => {
                    let mut it = items.into_iter();
                    let value = Box::new(it.next().expect("len 2"));
                    let meta = Box::new(it.next().expect("len 2"));
                    Ok(Value::WithMeta { value, meta })
                }
                other => Err(Error::MalformedWithMeta(seq_len(&other))),
            },
            "penpot/pointer" => match rep {
                Value::Array(items) if items.len() == 2 => {
                    let mut it = items.into_iter();
                    let id = Box::new(it.next().expect("len 2"));
                    let meta = it.next().expect("len 2");
                    Ok(Value::Pointer {
                        id,
                        meta: if meta.is_nil() {
                            None
                        } else {
                            Some(Box::new(meta))
                        },
                    })
                }
                Value::Array(items) if items.len() == 1 => Ok(Value::Pointer {
                    id: Box::new(items.into_iter().next().expect("len 1")),
                    meta: None,
                }),
                other => Err(Error::MalformedPointer(seq_len(&other))),
            },
            // The rep is a map of id -> transit-encoded value *string*. Decode
            // each value through a fresh reader so the outer cache survives.
            "penpot/objects-map/v2" => {
                let map = rep.as_map().ok_or_else(|| Error::BadRep {
                    tag: long(),
                    expected: "map",
                    got: shape_name(&rep),
                })?;
                let mut out = Map::new();
                for (key, value) in map.iter() {
                    let decoded = match value {
                        Value::Str(nested) => Reader::decode_nested(nested)?,
                        other => other.clone(),
                    };
                    out.push(key.clone(), decoded);
                }
                Ok(Value::ObjectsMap(out))
            }
            "penpot/path-data" => Ok(match rep {
                // The CLJS write handler ships the packed buffer through the
                // binary tag; a non-binary rep passes through untouched (the same
                // guard the `penpot/path-data` reader in lib/transit.ts applies).
                Value::Binary(bytes) => Value::PathData(PathData::from_bytes(bytes)),
                other => Value::tagged(tag, other),
            }),
            // Verbose JSON spellings of the scalar tags, accepted so a JVM-side
            // writer that prefers them lands on the same variants.
            "uuid" => match rep {
                Value::Str(s) => {
                    parse_uuid(&s)
                        .map(Value::Uuid)
                        .map_err(|reason| Error::InvalidRep {
                            tag: long(),
                            reason,
                        })
                }
                other => Err(Error::BadRep {
                    tag: long(),
                    expected: "string",
                    got: shape_name(&other),
                }),
            },
            "inst" => Ok(Value::VerboseInstant(string_rep(tag, rep)?)),
            // Penpot's handler id. Kept separate from transit's own `~r`
            // spelling only until the writer runs; both decode to `Uri` and
            // re-encode as `~#uri` (see `writer::marshal`).
            "uri" => Ok(Value::Uri(string_rep(tag, rep)?)),
            "duration" => Ok(Value::Duration(match rep {
                Value::Integer(ms) => ms,
                Value::Str(s) => s.parse::<i64>().map_err(|_| Error::InvalidRep {
                    tag: long(),
                    reason: format!("`{s}` is not a millisecond count"),
                })?,
                other => {
                    return Err(Error::BadRep {
                        tag: long(),
                        expected: "integer",
                        got: shape_name(&other),
                    })
                }
            })),
            // Data-side record tags: keep tag + payload (lib/transit.ts registers
            // identity handlers for exactly these).
            _ => Ok(Value::tagged(tag, rep)),
        }
    }
}

/// `~#set` / `~#ordered-set` rep: an array collected into an ordered set.
fn seq(tag: &str, rep: Value) -> Result<Set> {
    match rep {
        Value::Array(items) | Value::List(items) => Ok(items.into_iter().collect()),
        other => Err(Error::BadRep {
            tag: TagRef::Long(tag.to_owned()),
            expected: "array",
            got: shape_name(&other),
        }),
    }
}

/// `~#ordered-map` rep: the same flat array `~#cmap` uses, collected into a map.
fn flat_map(tag: &str, rep: Value) -> Result<Map> {
    Ok(flat_pairs(tag, rep)?.into_iter().collect())
}

/// `~#ordered-map` / `~#cmap` carry a *flat* array `k, v, k, v` (the CLJS write
/// handler is `vec` on the map).
fn flat_pairs(tag: &str, rep: Value) -> Result<Vec<(Value, Value)>> {
    let items = match rep {
        Value::Array(items) | Value::List(items) => items,
        other => {
            return Err(Error::BadRep {
                tag: TagRef::Long(tag.to_owned()),
                expected: "array",
                got: shape_name(&other),
            })
        }
    };
    if items.len() % 2 != 0 {
        return Err(Error::OddMapEntries(items.len()));
    }
    let count = items.len();
    let mut it = items.into_iter();
    let mut out = Vec::with_capacity(count / 2);
    while let Some(key) = it.next() {
        let value = it.next().expect("even length");
        out.push((key, value));
    }
    Ok(out)
}

/// Recursion guard for the decode walk. `serde_json` refuses to build a tree
/// nested deeper than 128 levels, so this is a second line of defence for the
/// walk over the tree.
pub(crate) const MAX_DEPTH: usize = 128;

/// The transit map marker string.
const MAP_MARKER: &str = "^ ";

fn number(n: &Number) -> Value {
    if let Some(i) = n.as_i64() {
        return Value::Integer(i);
    }
    // Everything else is a double, which is what transit-js reaches too: JSON has
    // no int/float split and JS has no integers past 2^53, so an out-of-range
    // integer literal must not turn into a rep-preserving variant that would
    // re-encode as `~n…` instead of the bare number it arrived as.
    n.as_f64().map_or(Value::Nil, Value::Double)
}

fn seq_len(v: &Value) -> usize {
    v.items().map_or(0, |i| i.len())
}

fn string_rep(tag: &str, rep: Value) -> Result<String> {
    match rep {
        Value::Str(s) => Ok(s),
        other => Err(Error::BadRep {
            tag: TagRef::Long(tag.to_owned()),
            expected: "string",
            got: shape_name(&other),
        }),
    }
}

fn parse_uuid(rep: &str) -> std::result::Result<Uuid, String> {
    Uuid::parse_str(rep).map_err(|e| format!("`{rep}` is not a uuid: {e}"))
}

fn shape_name(v: &Value) -> &'static str {
    match v {
        Value::Nil => "nil",
        Value::Bool(_) => "boolean",
        Value::Integer(_) | Value::Double(_) | Value::BigInteger(_) | Value::BigDecimal(_) => {
            "number"
        }
        Value::Str(_) | Value::Keyword(_) | Value::Symbol(_) => "string",
        Value::Binary(_) => "binary",
        Value::Array(_) | Value::List(_) => "array",
        Value::Map(_) | Value::OrderedMap(_) | Value::ObjectsMap(_) => "map",
        _ => "other",
    }
}

/// `parseString`: un-escape a doubled escape char, then dispatch on the tag.
/// A bare `~#tag` token yields [`Decoded::Tag`].
pub(crate) fn parse_referent(raw: &str) -> Decoded {
    let Some(rest) = raw.strip_prefix('~') else {
        return Decoded::Value(Value::Str(raw.to_owned()));
    };
    let Some(c) = rest.chars().next() else {
        // A lone "~": transit-js yields a tag with an empty name and "" rep.
        return Decoded::Value(Value::tagged("", Value::Str(String::new())));
    };
    let tail = &rest[c.len_utf8()..];
    let value = match c {
        // escaped literal string: ~~ / ~^ / ~` -> drop the leading marker
        '~' | '^' | '`' => return Decoded::Value(Value::Str(rest.to_owned())),
        '#' => return Decoded::Tag(tail.to_owned()),
        ':' => Value::Keyword(tail.to_owned()),
        '$' => Value::Symbol(tail.to_owned()),
        '_' => Value::Nil,
        '?' => match tail {
            "t" => Value::Bool(true),
            "f" => Value::Bool(false),
            other => Value::tagged("?", Value::Str(other.to_owned())),
        },
        'b' => STANDARD.decode(tail).map_or_else(
            |_| Value::tagged("b", Value::Str(tail.to_owned())),
            Value::Binary,
        ),
        'i' => match tail.parse::<i64>() {
            Ok(v) => Value::Integer(v),
            // Out of i64 range: hold the raw rep under its own tag, which
            // re-encodes as the same `~i…` text instead of silently switching
            // tag. `~n` is the variant that carries an arbitrary-precision rep.
            Err(_) => Value::tagged("i", Value::Str(tail.to_owned())),
        },
        // `~n` is Penpot's CLJS-only big integer tag (`:rfn js/parseInt`, no
        // `:wfn`). The rep is kept verbatim so it re-encodes byte for byte.
        'n' => Value::BigInteger(tail.to_owned()),
        'd' => match tail.parse::<f64>() {
            Ok(v) => Value::Double(v),
            Err(_) => Value::tagged("d", Value::Str(tail.to_owned())),
        },
        'f' => Value::BigDecimal(tail.to_owned()),
        'c' => Value::Char(tail.chars().next().unwrap_or('\0')),
        'z' => SpecialDouble::from_rep(tail).map_or_else(
            || Value::tagged("z", Value::Str(tail.to_owned())),
            Value::Special,
        ),
        'm' => match tail.parse::<i64>() {
            Ok(ms) => Value::Instant(ms),
            Err(_) => Value::tagged("m", Value::Str(tail.to_owned())),
        },
        't' => Value::VerboseInstant(tail.to_owned()),
        'u' => parse_uuid(tail).map_or_else(
            |_| Value::tagged("u", Value::Str(tail.to_owned())),
            Value::Uuid,
        ),
        // transit's own URI tag. transit-js leaves this as a TaggedValue when
        // no `r` handler is registered, which is why Penpot writes `~#uri`
        // instead; accept both and normalise on write.
        'r' => Value::Uri(tail.to_owned()),
        // Unknown single character tag: defaultHandler -> tagged value.
        other => Value::tagged(other.to_string(), Value::Str(tail.to_owned())),
    };
    Decoded::Value(value)
}

/// Decode `input` with a throwaway reader.
///
/// # Errors
///
/// The same conditions as [`Reader::decode`].
pub fn decode(input: &str) -> Result<Value> {
    Reader::new().decode(input)
}
