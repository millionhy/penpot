use std::fs;
use std::path::PathBuf;
use std::time::Duration;

use ws::{prefix_topic, ProtocolOptions, HEARTBEAT_TIMEOUT_CLOSE_CODE};

fn backend_source(path: &str) -> String {
    fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../")
            .join(path),
    )
    .expect("read backend source")
}

#[test]
fn the_router_keeps_the_clojure_route() {
    let source = backend_source("backend/src/app/http/websocket.clj");
    assert!(source.contains("[\"/ws/notifications\""));
}

#[test]
fn the_session_id_comes_from_the_query_string() {
    let source = backend_source("backend/src/app/http/websocket.clj");
    assert!(source.contains("(some-> params :session-id uuid/parse*)"));
    assert!(source.contains(":code :missing-session-id"));
}

#[test]
fn the_tenant_prefix_is_a_dot_between_tenant_and_topic() {
    let source = backend_source("backend/src/app/msgbus.clj");
    assert!(source.contains("(str prefix \".\" topic)"));
    assert_eq!(prefix_topic("acme", "profile-1"), "acme.profile-1");
}

#[test]
fn buffer_and_heartbeat_defaults_match_the_listener() {
    let options = ProtocolOptions::default();
    assert_eq!(options.profile_capacity, 16);
    assert_eq!(options.scope_capacity, 64);
    assert_eq!(options.output_capacity, 64);
    assert_eq!(options.input_capacity, 64);
    assert_eq!(options.heartbeat_interval, Duration::from_secs(5));
    assert_eq!(options.max_missed_heartbeats, 3);

    let source = backend_source("backend/src/app/util/websocket.clj");
    assert!(source.contains("(def max-missed-heartbeats 3)"));
    assert!(source.contains("(def heartbeat-interval 5000)"));
    assert!(source.contains("(yws/close channel 8802 \"missing to many pings\")"));
    assert_eq!(HEARTBEAT_TIMEOUT_CLOSE_CODE, 8802);
}

#[test]
fn the_listener_handles_every_client_message_type_we_decode() {
    let source = backend_source("backend/src/app/http/websocket.clj");
    for message_type in [
        "open",
        "close",
        "subscribe-team",
        "subscribe-file",
        "unsubscribe-file",
        "keepalive",
        "broadcast",
        "pointer-update",
    ] {
        assert!(
            source.contains(&format!("(defmethod handle-message :{message_type}")),
            "missing handler for {message_type}"
        );
    }
}
