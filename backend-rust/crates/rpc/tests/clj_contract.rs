//! Guard the Rust route table against `backend/src/app/rpc.clj`.
//!
//! The Clojure router stays the source of truth until the Rust server replaces
//! it, so a rename there must fail this test rather than slip through.

const RPC_CLJ: &str = include_str!("../../../../backend/src/app/rpc.clj");

#[test]
fn route_paths_match_the_clojure_router() {
    for needle in [
        r#"["/methods/:method-name""#,
        r#"["/rpc/command/:method-name""#,
        r#"["/_doc""#,
        r#"["/doc""#,
        r#"["/openapi""#,
        r#"["/openapi.join""#,
        r#"["/management""#,
        r#"["/main""#,
    ] {
        assert!(
            RPC_CLJ.contains(needle),
            "rpc.clj no longer contains {needle}"
        );
    }
}

#[test]
fn redirect_targets_match_the_clojure_router() {
    for needle in [
        r#"(u/join public-uri "/api/main/doc")"#,
        r#"(u/join public-uri "/api/main/doc/openapi")"#,
        r#"(u/join public-uri "/api/main/doc/openapi.json")"#,
    ] {
        assert!(
            RPC_CLJ.contains(needle),
            "rpc.clj no longer redirects with {needle}"
        );
    }
}

#[test]
fn the_get_prefix_rule_still_lives_in_the_rpc_handler() {
    assert!(RPC_CLJ.contains(r#"(str/starts-with? handler-name "get-")"#));
    assert!(RPC_CLJ.contains(":code :method-not-allowed"));
}
