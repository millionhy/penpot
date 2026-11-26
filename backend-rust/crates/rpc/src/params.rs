//! Thin parameter schemas and GET query decoding.
//!
//! M3 does not port malli. A command declares a flat `:map` schema with this
//! module, and [`ParamSchema::validate`] checks required fields, closed maps,
//! and the scalar coercions a query string needs (UUID/int/bool/keyword from
//! text). Nested maps and collection-of-map parameters arrive with the
//! command ports that need them.
//!
//! Query strings follow `frontend-nextjs/lib/rpc.ts` (itself a port of
//! `repo.cljs`): a repeated key becomes a vector, everything else stays text.

use std::fmt;

use transit::{Map, Set, Value};

/// The value shapes the thin validator understands.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ParamKind {
    Str,
    /// A trimmed address with exactly one `@` and no whitespace.
    Email,
    Uuid,
    Int,
    Bool,
    Keyword,
    Set(Box<ParamKind>),
    Vec(Box<ParamKind>),
    /// Passed through unchanged.
    Any,
}

/// One field of a [`ParamSchema`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamSpec {
    pub name: String,
    pub kind: ParamKind,
    pub required: bool,
}

impl ParamSpec {
    #[must_use]
    pub fn required(name: impl Into<String>, kind: ParamKind) -> Self {
        Self {
            name: name.into(),
            kind,
            required: true,
        }
    }

    #[must_use]
    pub fn optional(name: impl Into<String>, kind: ParamKind) -> Self {
        Self {
            name: name.into(),
            kind,
            required: false,
        }
    }
}

/// A flat `[:map ...]` schema. Closed by default, like malli.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ParamSchema {
    pub fields: Vec<ParamSpec>,
    pub closed: bool,
}

impl ParamSchema {
    #[must_use]
    pub fn new(fields: impl IntoIterator<Item = ParamSpec>) -> Self {
        Self {
            fields: fields.into_iter().collect(),
            closed: true,
        }
    }

    /// Allow keys that the schema does not declare (malli `{:closed false}`).
    #[must_use]
    pub fn open(mut self) -> Self {
        self.closed = false;
        self
    }

    /// Check and coerce `raw` into a keyword-keyed map.
    ///
    /// # Errors
    ///
    /// [`ValidationError`] for a missing required field, an unknown field in a
    /// closed schema, a non-map input, or a value that cannot be coerced.
    pub fn validate(&self, raw: &Value) -> Result<Value, ValidationError> {
        let Some(map) = raw.as_map() else {
            return Err(ValidationError::new("parameters must be a map"));
        };

        let mut out = Map::new();
        for spec in &self.fields {
            match lookup(map, &spec.name) {
                Some(value) => {
                    let value = coerce(&spec.kind, value).map_err(|reason| {
                        ValidationError::new(format!("{}: {reason}", spec.name))
                    })?;
                    out.insert(Value::kw(spec.name.clone()), value);
                }
                None if spec.required => {
                    return Err(ValidationError::new(format!(
                        "{}: required parameter is missing",
                        spec.name
                    )));
                }
                None => {}
            }
        }

        for (key, value) in map.iter() {
            let Some(name) = key_name(key) else {
                return Err(ValidationError::new(
                    "parameter keys must be keywords or strings",
                ));
            };
            if self.fields.iter().any(|spec| spec.name == name) {
                continue;
            }
            if self.closed {
                return Err(ValidationError::new(format!("{name}: unknown parameter")));
            }
            out.insert(key.clone(), value.clone());
        }

        Ok(Value::Map(out))
    }
}

/// A parameter rejected by [`ParamSchema::validate`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ValidationError {
    message: String,
}

impl ValidationError {
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ValidationError {}

/// Decode a query string into a keyword-keyed map.
///
/// A repeated key becomes a vector (`Value::List`), matching Ring's
/// `query-params` and the client's `URLSearchParams.append`.
#[must_use]
pub fn parse_query(query: &str) -> Value {
    let mut out = Map::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        let key = Value::kw(key.as_ref());
        let next = match out.get(&key).cloned() {
            None => Value::str(value.as_ref()),
            Some(Value::List(mut items)) => {
                items.push(Value::str(value.as_ref()));
                Value::List(items)
            }
            Some(existing) => Value::List(vec![existing, Value::str(value.as_ref())]),
        };
        out.insert(key, next);
    }
    Value::Map(out)
}

/// Merge `query` into `body`; body values win, like Ring's request params.
#[must_use]
pub fn merge_params(query: &Value, body: &Value) -> Value {
    let (Some(query), Some(body)) = (query.as_map(), body.as_map()) else {
        return body.clone();
    };
    let mut out = query.clone();
    for (key, value) in body.iter() {
        out.insert(key.clone(), value.clone());
    }
    Value::Map(out)
}

fn lookup<'a>(map: &'a Map, name: &str) -> Option<&'a Value> {
    map.get_kw(name)
        .or_else(|| map.get(&Value::str(name.to_owned())))
}

fn key_name(key: &Value) -> Option<&str> {
    key.as_keyword().or_else(|| key.as_str())
}

/// `::sm/email`'s shape rules, without the DNS or length corner cases.
fn is_email(text: &str) -> bool {
    if text.is_empty() || text.len() > 254 || text.chars().any(char::is_whitespace) {
        return false;
    }
    let mut parts = text.split('@');
    let (Some(local), Some(domain), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    !local.is_empty() && !domain.is_empty()
}

fn coerce(kind: &ParamKind, value: &Value) -> Result<Value, String> {
    match kind {
        ParamKind::Any => Ok(value.clone()),
        ParamKind::Str => match value {
            Value::Str(text) => Ok(Value::str(text.clone())),
            _ => Err("expected a string".to_owned()),
        },
        ParamKind::Email => match value {
            Value::Str(text) => {
                let text = text.trim();
                if is_email(text) {
                    Ok(Value::str(text.to_owned()))
                } else {
                    Err("expected an email address".to_owned())
                }
            }
            _ => Err("expected an email address".to_owned()),
        },
        ParamKind::Uuid => match value {
            Value::Uuid(uuid) => Ok(Value::Uuid(*uuid)),
            Value::Str(text) => uuid::Uuid::parse_str(text)
                .map(Value::Uuid)
                .map_err(|error| format!("expected a UUID: {error}")),
            _ => Err("expected a UUID".to_owned()),
        },
        ParamKind::Int => match value {
            Value::Integer(number) => Ok(Value::Integer(*number)),
            Value::Str(text) => text
                .trim()
                .parse::<i64>()
                .map(Value::Integer)
                .map_err(|error| format!("expected an integer: {error}")),
            _ => Err("expected an integer".to_owned()),
        },
        ParamKind::Bool => match value {
            Value::Bool(flag) => Ok(Value::Bool(*flag)),
            Value::Str(text) => match text.trim().to_ascii_lowercase().as_str() {
                "true" => Ok(Value::Bool(true)),
                "false" => Ok(Value::Bool(false)),
                _ => Err("expected a boolean".to_owned()),
            },
            _ => Err("expected a boolean".to_owned()),
        },
        ParamKind::Keyword => match value {
            Value::Keyword(name) => Ok(Value::kw(name.clone())),
            Value::Str(text) => Ok(Value::kw(text.trim_start_matches(':'))),
            _ => Err("expected a keyword".to_owned()),
        },
        ParamKind::Set(inner) => match value {
            Value::Set(items) => {
                let mut out = Set::new();
                for item in items.iter() {
                    out.insert(coerce(inner, item)?);
                }
                Ok(Value::Set(out))
            }
            Value::List(items) | Value::Array(items) => {
                let mut out = Set::new();
                for item in items {
                    out.insert(coerce(inner, item)?);
                }
                Ok(Value::Set(out))
            }
            _ => Err("expected a set".to_owned()),
        },
        ParamKind::Vec(inner) => match value {
            Value::List(items) => items
                .iter()
                .map(|item| coerce(inner, item))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::List),
            Value::Array(items) => items
                .iter()
                .map(|item| coerce(inner, item))
                .collect::<Result<Vec<_>, _>>()
                .map(Value::List),
            _ => Err("expected a vector".to_owned()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema() -> ParamSchema {
        ParamSchema::new([
            ParamSpec::required("id", ParamKind::Uuid),
            ParamSpec::optional("limit", ParamKind::Int),
            ParamSpec::optional("tags", ParamKind::Set(Box::new(ParamKind::Str))),
        ])
    }

    #[test]
    fn repeated_query_keys_become_vectors() {
        let params = parse_query("tag=a&tag=b&limit=2");
        assert_eq!(
            params.get_kw("tag"),
            Some(&Value::List(vec![Value::str("a"), Value::str("b")]))
        );
        assert_eq!(params.get_kw("limit"), Some(&Value::str("2")));
    }

    #[test]
    fn query_strings_are_coerced_by_the_schema() {
        let raw = parse_query("id=7d1c3f16-8f1e-4b1a-9e2d-3a4b5c6d7e8f&limit=10&tags=a&tags=b");
        let value = schema().validate(&raw).expect("valid params");
        assert!(matches!(value.get_kw("id"), Some(Value::Uuid(_))));
        assert_eq!(value.get_kw("limit"), Some(&Value::Integer(10)));
        assert_eq!(
            value
                .get_kw("tags")
                .and_then(Value::items)
                .map(|items| items.len()),
            Some(2)
        );
    }

    #[test]
    fn missing_unknown_and_invalid_values_are_rejected() {
        let error = schema()
            .validate(&Value::map([(Value::kw("id"), Value::str("nope"))]))
            .expect_err("bad uuid");
        assert!(error.message().starts_with("id:"));

        let error = schema().validate(&Value::map([])).expect_err("missing id");
        assert!(error.message().contains("required"));

        let error = schema()
            .validate(&Value::map([
                (
                    Value::kw("id"),
                    Value::str("7d1c3f16-8f1e-4b1a-9e2d-3a4b5c6d7e8f"),
                ),
                (Value::kw("extra"), Value::Integer(1)),
            ]))
            .expect_err("closed map");
        assert!(error.message().contains("unknown parameter"));
    }

    #[test]
    fn open_schemas_keep_unknown_keys() {
        let raw = Value::map([
            (
                Value::kw("id"),
                Value::str("7d1c3f16-8f1e-4b1a-9e2d-3a4b5c6d7e8f"),
            ),
            (Value::kw("extra"), Value::Integer(1)),
        ]);
        let value = schema().open().validate(&raw).expect("open schema");
        assert_eq!(value.get_kw("extra"), Some(&Value::Integer(1)));
    }

    #[test]
    fn body_values_win_when_merging() {
        let query = parse_query("a=query&b=q");
        let body = Value::map([(Value::kw("a"), Value::str("body"))]);
        let merged = merge_params(&query, &body);
        assert_eq!(merged.get_kw("a"), Some(&Value::str("body")));
        assert_eq!(merged.get_kw("b"), Some(&Value::str("q")));
    }
}
