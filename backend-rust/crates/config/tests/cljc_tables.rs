//! Diff the Rust tables against their Clojure(Script) sources.
//!
//! The Clojure files are the source of truth. These tests strip `;` comments
//! and compare:
//!
//! * [`ALL_FLAGS`] / [`DEFAULT_FLAGS`] with `common/src/app/common/flags.cljc`;
//! * [`KNOWN_KEYS`] and its decoded [`ValueKind`] with the `schema:config`
//!   entries of `backend/src/app/config.clj`. Schema keys that this crate does
//!   not read yet are listed in [`PENDING_KEYS`] so that adding one on either
//!   side fails here until both are updated.

use std::collections::BTreeSet;
use std::path::PathBuf;

use config::{ValueKind, ALL_FLAGS, DEFAULT_FLAGS, KNOWN_KEYS, PENDING_KEYS};

fn source(relative: &[&str]) -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join(relative.iter().collect::<PathBuf>());
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    text.lines()
        .map(|line| line.split(';').next().unwrap_or_default())
        .collect::<Vec<_>>()
        .join("\n")
}

fn flags_source() -> String {
    source(&["common", "src", "app", "common", "flags.cljc"])
}

fn config_source() -> String {
    source(&["backend", "src", "app", "config.clj"])
}

fn block<'a>(source: &'a str, def: &str, open: char, close: char) -> &'a str {
    let start = source
        .find(&format!("(def {def}"))
        .unwrap_or_else(|| panic!("no (def {def}) in flags.cljc"));
    let open_at = source[start..].find(open).map_or_else(
        || panic!("no {open} after (def {def})"),
        |offset| start + offset,
    );
    let mut depth = 0usize;
    for (offset, ch) in source[open_at..].char_indices() {
        if ch == open {
            depth += 1;
        } else if ch == close {
            depth -= 1;
            if depth == 0 {
                return &source[open_at + 1..open_at + offset];
            }
        }
    }
    panic!("unbalanced {open}{close} in (def {def})");
}

fn keywords(text: &str) -> BTreeSet<String> {
    let bytes = text.as_bytes();
    let mut out = BTreeSet::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b':' {
            let start = index + 1;
            let mut end = start;
            while end < bytes.len() && (bytes[end].is_ascii_alphanumeric() || bytes[end] == b'-') {
                end += 1;
            }
            if end > start {
                out.insert(text[start..end].to_owned());
            }
            index = end;
        } else {
            index += 1;
        }
    }
    out
}

#[test]
fn all_flags_matches_the_cljc_sets() {
    let source = flags_source();
    let mut expected = keywords(block(&source, "login", '{', '}'));
    expected.extend(keywords(block(&source, "email", '{', '}')));
    expected.extend(keywords(block(&source, "varia", '{', '}')));
    let actual: BTreeSet<String> = ALL_FLAGS.iter().map(|name| (*name).to_owned()).collect();
    assert_eq!(actual, expected, "ALL_FLAGS drifted from flags.cljc");
}

#[test]
fn default_flags_match_the_cljc_vector() {
    let source = flags_source();
    let expected: BTreeSet<String> = keywords(block(&source, "default", '[', ']'))
        .into_iter()
        .map(|name| name.strip_prefix("enable-").unwrap_or(&name).to_owned())
        .collect();
    let actual: BTreeSet<String> = DEFAULT_FLAGS
        .iter()
        .map(|name| (*name).to_owned())
        .collect();
    assert_eq!(actual, expected, "DEFAULT_FLAGS drifted from flags.cljc");
}

/// `schema:config` entries as `(name, entry text)`, in source order.
fn config_schema_entries() -> Vec<(String, String)> {
    let source = config_source();
    let start = source
        .find("(def schema:config")
        .expect("no (def schema:config) in config.clj");
    let end = source
        .find("(defn telemetry-excluded-host?")
        .expect("no telemetry-excluded-host? after schema:config");
    let block = &source[start..end];

    let mut entries: Vec<(String, String)> = Vec::new();
    for line in block.lines() {
        if let Some(rest) = line.trim_start().strip_prefix("[:") {
            let name: String = rest
                .chars()
                .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
                .collect();
            if !name.is_empty() && name != "map" {
                entries.push((name, String::new()));
            }
        }
        if let Some((_, text)) = entries.last_mut() {
            text.push_str(line);
            text.push('\n');
        }
    }
    assert!(
        entries.len() > 100,
        "schema:config parser found only {} entries",
        entries.len()
    );
    entries
}

fn schema_kind(text: &str) -> ValueKind {
    if text.contains("[::sm/set ") {
        ValueKind::Set
    } else if text.contains("[::sm/vec ") {
        ValueKind::Vec
    } else if text.contains("::sm/boolean") {
        ValueKind::Bool
    } else if text.contains("::sm/int") {
        ValueKind::Int
    } else if text.contains("::ct/duration") {
        ValueKind::Duration
    } else if text.contains("::sm/uri") {
        ValueKind::Uri
    } else if text.trim_end().ends_with(":keyword]") {
        ValueKind::Keyword
    } else {
        assert!(
            text.contains(":string"),
            "unclassified schema entry: {text}"
        );
        ValueKind::Str
    }
}

#[test]
fn known_config_keys_exist_in_the_schema() {
    let schema: BTreeSet<String> = config_schema_entries()
        .into_iter()
        .map(|(name, _)| name)
        .collect();
    for spec in KNOWN_KEYS {
        assert!(
            schema.contains(spec.name),
            "KNOWN_KEYS has `{}`, which schema:config does not define",
            spec.name
        );
    }
}

#[test]
fn schema_keys_are_either_known_or_explicitly_pending() {
    let expected: BTreeSet<String> = KNOWN_KEYS
        .iter()
        .map(|spec| spec.name.to_owned())
        .chain(PENDING_KEYS.iter().map(|name| (*name).to_owned()))
        .collect();
    let actual: BTreeSet<String> = config_schema_entries()
        .into_iter()
        .map(|(name, _)| name)
        .collect();

    let undocumented: Vec<String> = actual.difference(&expected).cloned().collect();
    assert!(
        undocumented.is_empty(),
        "new schema:config keys must be implemented or added to PENDING_KEYS: {undocumented:?}"
    );

    let stale: Vec<String> = expected.difference(&actual).cloned().collect();
    assert!(
        stale.is_empty(),
        "PENDING_KEYS or KNOWN_KEYS names not in schema:config: {stale:?}"
    );
}

#[test]
fn known_config_kinds_match_the_schema_types() {
    let entries = config_schema_entries();
    for spec in KNOWN_KEYS {
        let (_, text) = entries
            .iter()
            .find(|(name, _)| name == spec.name)
            .unwrap_or_else(|| panic!("no schema entry for `{}`", spec.name));
        assert_eq!(
            schema_kind(text),
            spec.kind,
            "ValueKind for `{}` disagrees with schema:config",
            spec.name
        );
    }
}
