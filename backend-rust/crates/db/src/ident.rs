//! Identifier rules from `app.db.sql`.
//!
//! Penpot keys are kebab-case; PostgreSQL names are `snake_case`. The Clojure
//! helpers `snake-case` and `kebab-case` are a single `-`/`_` swap, with no
//! case change, so `http-session-v2` becomes `http_session_v2` and keeps its
//! digits.

/// `app.db.sql/snake-case`: table and column names replace `-` with `_`.
#[must_use]
pub fn snake_case(name: &str) -> String {
    name.replace('-', "_")
}

/// `app.db.sql/kebab-case`: row labels replace `_` with `-`.
#[must_use]
pub fn kebab_case(name: &str) -> String {
    name.replace('_', "-")
}

/// Resolve a keyword table name to its SQL name.
///
/// Accepts the forms the backend uses: `:http-session-v2`, a bare
/// `http-session-v2`, and a namespaced keyword such as `:storage-object/x`
/// (the namespace is dropped, as `name` does in Clojure).
#[must_use]
pub fn table_name(table: &str) -> String {
    let name = table.rsplit('/').next().unwrap_or(table);
    let name = name.strip_prefix(':').unwrap_or(name);
    snake_case(name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn table_names_match_the_schema() {
        for (keyword, table) in [
            (":http-session-v2", "http_session_v2"),
            (":access-token", "access_token"),
            (":storage-object", "storage_object"),
            (":file-library-rel", "file_library_rel"),
            (":team-invitation", "team_invitation"),
            (":upload-session-chunk", "upload_session_chunk"),
            ("task", "task"),
            (":profile", "profile"),
        ] {
            assert_eq!(table_name(keyword), table);
        }
        assert_eq!(table_name(":storage-object/metadata"), "metadata");
    }

    #[test]
    fn kebab_and_snake_round_trip_without_touching_case() {
        assert_eq!(snake_case("created-at"), "created_at");
        assert_eq!(snake_case("ServerErrorReport"), "ServerErrorReport");
        assert_eq!(kebab_case("created_at"), "created-at");
        assert_eq!(
            kebab_case(&snake_case("deletion-attempts")),
            "deletion-attempts"
        );
    }
}
