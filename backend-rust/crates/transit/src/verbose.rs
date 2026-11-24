//! `json-verbose` writer.
//!
//! `backend/src/app/http.clj` encodes error bodies with
//! `t/encode-str body {:type :json-verbose}`, so an error response is a JSON
//! object (`{"~:type":"~:authentication",…}`), not the compact `["^ ",…]`
//! form. Verbose mode keeps the tag spellings but never allocates cache codes:
//!
//! * maps are JSON objects whose keys are referent strings,
//! * a map with a non-stringable key becomes `{"~#cmap":[…]}`,
//! * tagged values are one-key objects (`{"~#list":[…]}`),
//! * bare arrays stay arrays,
//! * top-level single-character tags still take the `{"~#'": …}` wrapper.
//!
//! The output matches transit-js `writer("json-verbose")` except where Penpot
//! deliberately overrides the handler (for example `Instant` writes `~m`, not
//! the built-in Date `~t`).

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::{
    json::{escape_json_string, fmt_f64},
    value::{Map, Set, Value},
};

/// Encode `value` in transit's verbose JSON form.
#[must_use]
pub fn encode(value: &Value) -> String {
    let mut out = String::new();
    if crate::writer::top_needs_quoting(value) {
        out.push_str("{\"~#'\":");
        marshal(value, &mut out);
        out.push('}');
    } else {
        marshal(value, &mut out);
    }
    out
}

fn marshal(value: &Value, out: &mut String) {
    match value {
        Value::Nil => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Integer(i) => out.push_str(&i.to_string()),
        Value::Double(d) => out.push_str(&fmt_f64(*d)),
        Value::Special(s) => string(&format!("~z{}", s.rep()), out),
        Value::Char(c) => string(&format!("~c{c}"), out),
        Value::BigInteger(rep) => string(&format!("~n{rep}"), out),
        Value::BigDecimal(rep) => string(&format!("~f{rep}"), out),
        Value::Keyword(name) => string(&format!("~:{name}"), out),
        Value::Symbol(name) => string(&format!("~${name}"), out),
        Value::Str(s) => string(&escape_string_literal(s), out),
        Value::Binary(bytes) => string(&format!("~b{}", STANDARD.encode(bytes)), out),
        Value::Uuid(u) => string(&format!("~u{u}"), out),
        Value::Instant(ms) => string(&format!("~m{ms}"), out),
        Value::VerboseInstant(rep) => string(&format!("~t{rep}"), out),
        Value::Uri(uri) => tagged("uri", &Value::Str(uri.clone()), out),
        Value::Duration(ms) => tagged("duration", &Value::Integer(*ms), out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                marshal(item, out);
            }
            out.push(']');
        }
        Value::List(items) => tagged("list", &Value::Array(items.clone()), out),
        Value::Set(items) => tagged("set", &set_as_array(items), out),
        Value::OrderedSet(items) => tagged("ordered-set", &set_as_array(items), out),
        Value::Map(map) => emit_map(map, out),
        Value::OrderedMap(map) => tagged("ordered-map", &flat_pairs(map), out),
        Value::Cmap(pairs) => {
            let rep = Value::Array(
                pairs
                    .iter()
                    .flat_map(|(k, v)| [k.clone(), v.clone()])
                    .collect(),
            );
            tagged("cmap", &rep, out);
        }
        Value::Quoted(inner) => tagged("'", inner, out),
        Value::WithMeta { value, meta } => {
            tagged(
                "with-meta",
                &Value::Array(vec![(**value).clone(), (**meta).clone()]),
                out,
            );
        }
        Value::Pointer { id, meta } => {
            let rep = Value::Array(vec![
                (**id).clone(),
                meta.as_deref().cloned().unwrap_or(Value::Nil),
            ]);
            tagged("penpot/pointer", &rep, out);
        }
        Value::PathData(path) => tagged(
            "penpot/path-data",
            &Value::Binary(path.as_bytes().to_vec()),
            out,
        ),
        Value::ObjectsMap(map) => {
            let rep = Value::Map(
                map.iter()
                    .map(|(k, v)| (k.clone(), Value::Str(crate::encode(v))))
                    .collect(),
            );
            tagged("penpot/objects-map/v2", &rep, out);
        }
        Value::Tagged { tag, rep } => {
            if tag.encode_utf16().count() == 1 {
                if let Value::Str(s) = rep.as_ref() {
                    string(&format!("~{tag}{s}"), out);
                    return;
                }
            }
            tagged(tag, rep, out);
        }
    }
}

/// `emitMap` for verbose output: an object when every key has a referent
/// spelling, a `~#cmap` otherwise.
fn emit_map(map: &Map, out: &mut String) {
    if map.iter().all(|(key, _)| key_referent(key).is_some()) {
        out.push('{');
        for (i, (key, value)) in map.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            // `all` above established that every key has a referent.
            let referent = key_referent(key).unwrap_or_default();
            string(&referent, out);
            out.push(':');
            marshal(value, out);
        }
        out.push('}');
    } else {
        tagged("cmap", &flat_pairs(map), out);
    }
}

/// The referent spelling used for a verbose map key, or `None` when the key
/// is not stringable and the whole map has to become a `~#cmap`.
fn key_referent(value: &Value) -> Option<String> {
    match value {
        Value::Nil => Some("~_".to_owned()),
        Value::Bool(b) => Some(if *b { "~?t" } else { "~?f" }.to_owned()),
        Value::Integer(i) => Some(format!("~i{i}")),
        Value::Double(d) => Some(format!("~d{}", fmt_f64(*d))),
        Value::Special(s) => Some(format!("~z{}", s.rep())),
        Value::Char(c) => Some(format!("~c{c}")),
        Value::BigInteger(rep) => Some(format!("~n{rep}")),
        Value::BigDecimal(rep) => Some(format!("~f{rep}")),
        Value::Keyword(name) => Some(format!("~:{name}")),
        Value::Symbol(name) => Some(format!("~${name}")),
        Value::Str(s) => Some(escape_string_literal(s)),
        Value::Binary(bytes) => Some(format!("~b{}", STANDARD.encode(bytes))),
        Value::Uuid(u) => Some(format!("~u{u}")),
        Value::Instant(ms) => Some(format!("~m{ms}")),
        Value::VerboseInstant(rep) => Some(format!("~t{rep}")),
        Value::Tagged { tag, rep } if tag.encode_utf16().count() == 1 => match rep.as_ref() {
            Value::Str(s) => Some(format!("~{tag}{s}")),
            _ => None,
        },
        _ => None,
    }
}

fn tagged(tag: &str, rep: &Value, out: &mut String) {
    out.push('{');
    string(&format!("~#{tag}"), out);
    out.push(':');
    marshal(rep, out);
    out.push('}');
}

fn string(s: &str, out: &mut String) {
    escape_json_string(s, out);
}

/// Same rule as the compact writer: a literal starting with a transit escape
/// character gets one more `~` so the reader does not parse it as a tag.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn kw(name: &str) -> Value {
        Value::kw(name)
    }

    #[test]
    fn maps_are_objects_and_scalars_keep_their_tags() {
        let value = Value::map([
            (kw("a"), Value::Integer(1)),
            (Value::str("~:b"), Value::Integer(2)),
            (
                kw("nested"),
                Value::map([(
                    kw("x"),
                    Value::array([Value::Integer(1), Value::Integer(2)]),
                )]),
            ),
        ]);
        assert_eq!(
            encode(&value),
            r#"{"~:a":1,"~~:b":2,"~:nested":{"~:x":[1,2]}}"#
        );
    }

    #[test]
    fn collections_are_tagged_objects_and_arrays_stay_arrays() {
        assert_eq!(
            encode(&Value::array([Value::Integer(1), Value::Integer(2)])),
            "[1,2]"
        );
        assert_eq!(
            encode(&Value::vector([Value::Integer(1), Value::Integer(2)])),
            r#"{"~#list":[1,2]}"#
        );
        let set: Set = [Value::Integer(1), Value::Integer(2)].into_iter().collect();
        assert_eq!(encode(&Value::Set(set)), r#"{"~#set":[1,2]}"#);
    }

    #[test]
    fn top_level_scalars_are_quoted() {
        assert_eq!(encode(&Value::Integer(42)), r#"{"~#'":42}"#);
        assert_eq!(encode(&Value::kw("foo/bar")), r#"{"~#'":"~:foo/bar"}"#);
        assert_eq!(
            encode(&Value::Uuid(
                uuid::Uuid::parse_str("5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70").unwrap()
            )),
            r#"{"~#'":"~u5b2a2b4c-9b4d-4a1e-8f6a-2b3c4d5e6f70"}"#
        );
    }

    #[test]
    fn non_stringable_keys_turn_the_map_into_a_cmap() {
        let value = Value::map([
            (kw("a"), Value::Integer(1)),
            (
                Value::vector([Value::Integer(1), Value::Integer(2)]),
                Value::Integer(3),
            ),
        ]);
        assert_eq!(encode(&value), r#"{"~#cmap":["~:a",1,{"~#list":[1,2]},3]}"#);
    }

    #[test]
    fn uri_uses_penpots_multi_character_tag() {
        assert_eq!(
            encode(&Value::Uri("https://example.com/a".to_owned())),
            r#"{"~#uri":"https://example.com/a"}"#
        );
    }

    #[test]
    fn astral_tag_is_not_a_single_character_tag() {
        assert_eq!(
            encode(&Value::tagged("😀", Value::str("x"))),
            r#"{"~#😀":"x"}"#
        );
    }

    #[test]
    fn map_key_referents_cover_nil_bool_and_integers() {
        let value = Value::map([
            (Value::Nil, Value::Integer(1)),
            (Value::Bool(true), Value::Integer(2)),
            (Value::Bool(false), Value::Integer(3)),
            (Value::Integer(7), Value::Integer(4)),
        ]);
        assert_eq!(encode(&value), r#"{"~_":1,"~?t":2,"~?f":3,"~i7":4}"#);
    }

    #[test]
    fn instant_uses_penpots_m_tag() {
        assert_eq!(
            encode(&Value::Instant(1_700_000_000_000)),
            r#"{"~#'":"~m1700000000000"}"#
        );
        assert_eq!(
            encode(&Value::map([(kw("at"), Value::Instant(5))])),
            r#"{"~:at":"~m5"}"#
        );
    }
}
