//! Error type for the Transit codec.
//!
//! Every failure mode is a structured value: the codec never panics on
//! malformed input, and the RPC layer maps these onto an HTTP 400 with a
//! transit `ex-data` body (see `crates/errors`).

use thiserror::Error;

/// A tag name that could not be interpreted.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TagRef {
    /// A single character tag written in the escaped-string form (`~:foo`).
    Short(String),
    /// A multi character tag written in the tagged form (`["~#list",…]`).
    Long(String),
}

impl std::fmt::Display for TagRef {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Short(t) => write!(f, "~{t}"),
            Self::Long(t) => write!(f, "~#{t}"),
        }
    }
}

#[derive(Debug, Error)]
pub enum Error {
    #[error("input is not valid JSON: {0}")]
    Json(#[from] serde_json::Error),

    #[error("transit document nests deeper than the limit of {limit} levels")]
    TooDeep { limit: usize },

    #[error("tag {tag} expects a {expected} representation, got {got}")]
    BadRep {
        tag: TagRef,
        expected: &'static str,
        got: &'static str,
    },

    #[error("invalid representation for tag {tag}: {reason}")]
    InvalidRep { tag: TagRef, reason: String },

    #[error("a tagged value must be a 2 element array or a 1 key object, got {0} element(s)")]
    MalformedTagged(usize),

    #[error("a transit map must be encoded as an array starting with the \"^ \" marker")]
    MalformedMap,

    #[error("transit map must carry an even number of entries after the marker, got {0}")]
    OddMapEntries(usize),

    #[error("`~#with-meta` expects [value, meta], got {0} element(s)")]
    MalformedWithMeta(usize),

    #[error("`~#penpot/pointer` expects [id, meta], got {0} element(s)")]
    MalformedPointer(usize),

    #[error("`~#cmap` expects an array of [key, value] pairs")]
    MalformedCmap,

    #[error("cannot encode {0} in this transit flavour")]
    Unsupported(String),

    #[error("base64 payload for {0} is invalid")]
    BadBase64(&'static str),
}

pub type Result<T> = std::result::Result<T, Error>;
