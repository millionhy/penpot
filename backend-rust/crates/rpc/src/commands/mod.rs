//! Command ports that need a store, as opposed to the M3 skeleton samples.

use errors::Cause;
use transit::Value;

pub mod auth;
pub mod dashboard;
pub mod projects;
pub mod templates;

/// Build the `ex-data` map [`Cause::error`] carries.
pub(crate) fn cause(kind: &str, code: &str, hint: Option<&str>) -> Cause {
    let mut entries = vec![
        (Value::kw("type"), Value::kw(kind)),
        (Value::kw("code"), Value::kw(code)),
    ];
    if let Some(hint) = hint {
        entries.push((Value::kw("hint"), Value::str(hint)));
    }
    Cause::error(Value::map(entries))
}

pub(crate) fn authentication_required() -> Cause {
    cause("authentication", "authentication-required", None)
}

pub(crate) fn params_validation() -> Cause {
    cause("validation", "params-validation", None)
}

pub(crate) fn not_found() -> Cause {
    cause("not-found", "object-not-found", Some("not found"))
}
