//! Diff the Rust constants against `backend/src/app/http/errors.clj`.

use std::path::PathBuf;

use errors::{INTERNAL_FIELDS, POSTGRES_DEFAULT_HINT, POSTGRES_HINTS};

fn errors_source() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("..")
        .join("..")
        .join("backend")
        .join("src")
        .join("app")
        .join("http")
        .join("errors.clj");
    std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()))
}

fn section<'a>(source: &'a str, start: &str, end: &str) -> &'a str {
    let from = source
        .find(start)
        .unwrap_or_else(|| panic!("no `{start}` in errors.clj"));
    let to = source[from..].find(end).map_or_else(
        || panic!("no `{end}` after `{start}`"),
        |offset| from + offset,
    );
    &source[from..to]
}

fn quoted_strings(text: &str) -> Vec<String> {
    text.split('"')
        .skip(1)
        .step_by(2)
        .map(str::to_owned)
        .collect()
}

#[test]
fn postgres_hint_table_matches_errors_clj() {
    let source = errors_source();
    let block = section(
        &source,
        "(defn- pgsql-state->message",
        "(defmethod handle-exception org.postgresql",
    );
    // Start at `(case` so the docstring's quotes do not shift the pairs.
    let block = block.find("(case state").map_or_else(
        || panic!("no (case state ...) in pgsql-state->message"),
        |at| &block[at..],
    );
    let mut strings = quoted_strings(block);
    let default = strings
        .pop()
        .expect("pgsql-state->message should end with a default message");
    assert_eq!(default, POSTGRES_DEFAULT_HINT);

    let pairs: Vec<(String, String)> = strings
        .chunks(2)
        .map(|chunk| {
            assert_eq!(chunk.len(), 2, "unpaired SQLSTATE entry: {chunk:?}");
            (chunk[0].clone(), chunk[1].clone())
        })
        .collect();
    let expected: Vec<(String, String)> = POSTGRES_HINTS
        .iter()
        .map(|(state, hint)| ((*state).to_owned(), (*hint).to_owned()))
        .collect();
    assert_eq!(pairs, expected, "POSTGRES_HINTS drifted from errors.clj");
}

#[test]
fn internal_fields_match_strip_internal_fields() {
    let source = errors_source();
    let block = section(
        &source,
        "(defn- strip-internal-fields",
        "(defmulti handle-error",
    );
    let dissoc = block.find("(dissoc data").map_or_else(
        || panic!("no (dissoc data ...) in strip-internal-fields"),
        |at| &block[at..],
    );

    let mut fields = Vec::new();
    let mut rest = dissoc;
    while let Some(at) = rest.find(':') {
        rest = &rest[at + 1..];
        let name: String = rest
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-')
            .collect();
        if name.is_empty() {
            continue;
        }
        fields.push(name);
        rest = &rest[rest
            .find(|ch: char| !(ch.is_ascii_alphanumeric() || ch == '-'))
            .unwrap_or(rest.len())..];
    }
    assert_eq!(fields, INTERNAL_FIELDS);
}
