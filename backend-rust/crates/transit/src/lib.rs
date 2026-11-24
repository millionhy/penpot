//! Transit+JSON codec with Penpot's tag semantics.
//!
//! The Clojure/ClojureScript backend speaks
//! [`application/transit+json`](https://github.com/cognitect/transit-format) on
//! `/api/main/methods/*` (see `backend/src/app/http/transit.clj` and
//! `common/src/app/common/transit.cljc`). Everything that crosses the RPC
//! boundary — request bodies, response bodies, `task.props`, session payload
//! bytes — is transit, which is why this crate is the first milestone of
//! `backend-rust` (`PLAN.md` §5).
//!
//! The codec is a port of the exact library the Penpot frontend bundles
//! (`transit-js`), so wire behaviour is asserted against that implementation
//! rather than against the prose spec:
//!
//! * `fixtures/gen-transit-corpus.mjs` runs transit-js as an **oracle** and
//!   writes `fixtures/transit-corpus.json`.
//! * `tests/golden_corpus.rs` decodes each golden sample and re-encodes it,
//!   comparing bytes with the oracle output.
//!
//! # Value model
//!
//! [`Value`] is hand-rolled (decision #3 in `PLAN.md` §8) because transit
//! distinguishes pairs that JSON collapses. The two that break things when
//! merged:
//!
//! * [`Value::Keyword`] vs [`Value::Str`] — command params whose schema is
//!   `[:map-of :keyword …]` are rejected when keys arrive as strings.
//! * [`Value::List`] (a Clojure **vector**, on the wire as `["~#list",[…]]`) vs
//!   [`Value::Array`] (a bare JSON transit array). Every collection answer of
//!   the backend arrives wrapped in `~#list`; a reader that flattens the two
//!   variants cannot serve `get-teams` (`PLAN.md` §2.1, F5.1 field evidence).
//!
//! ```
//! use transit::{decode, encode, Value};
//!
//! let value = decode(r#"["^ ","~:id",1]"#).unwrap();
//! assert_eq!(value.get_kw("id"), Some(&Value::Integer(1)));
//! assert_eq!(encode(&value), r#"["^ ","~:id",1]"#);
//! ```
//!
//! # Errors
//!
//! Malformed input yields a structured [`Error`]; the decoder never
//! panics. Nesting is capped so a hostile document cannot grow the stack.
//!
//! # Known gaps
//!
//! Wire forms that need a live backend to settle are listed in
//! `TODO-ONLINE.md` next to this crate rather than guessed at here. The file
//! data blob itself is Fressian (`app.common.fressian`, JVM-only) and is out of
//! scope for this stage (`PLAN.md` §6).

mod cache;
mod error;
pub mod json;
mod reader;
mod value;
mod writer;

pub use cache::{is_cache_code, is_cacheable, MAX_CACHE_ENTRIES, MIN_SIZE_CACHEABLE};
pub use error::{Error, Result, TagRef};
pub use reader::{decode, Reader};
pub use value::{CmapEntry, Map, PathData, PathSegment, SegmentKind, Set, SpecialDouble, Value};
pub use writer::{encode, Writer};

/// Encode `value` with a throwaway writer.
///
/// A [`Writer`] keeps one referent cache; reusing it across a document is what
/// produces the `^N` references, so callers that encode many documents over a
/// session should keep one writer alive.
#[must_use]
pub fn encode_with(writer: &mut Writer, value: &Value) -> String {
    writer.encode(value)
}

/// Crate version, re-exported for diagnostics.
pub const VERSION: &str = env!("CARGO_PKG_VERSION");
