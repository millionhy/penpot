use std::sync::Arc;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use tower::ServiceExt as _;
use uuid::Uuid;
use ws::{
    websocket_accept_key, AllowAllAccess, FixedIdentity, InMemoryBus, WebSocketAuth, WsState,
};

fn session_id() -> Uuid {
    Uuid::parse_str("22222222-2222-4222-8222-222222222222").expect("session uuid")
}

fn profile_id() -> Uuid {
    Uuid::parse_str("11111111-1111-4111-8111-111111111111").expect("profile uuid")
}

fn state(identity: FixedIdentity) -> WsState {
    WsState::new(
        Arc::new(InMemoryBus::new("acme")),
        Arc::new(AllowAllAccess),
        Arc::new(identity),
    )
}

#[test]
fn accept_key_matches_the_rfc_6455_example() {
    assert_eq!(
        websocket_accept_key("dGhlIHNhbXBsZSBub25jZQ=="),
        "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
    );
}

#[tokio::test]
async fn missing_session_id_is_a_validation_error() {
    let response = ws::build_router(state(FixedIdentity::new(Some(profile_id()))))
        .oneshot(
            Request::builder()
                .uri("/ws/notifications")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_malformed_session_id_is_a_validation_error() {
    let response = ws::build_router(state(FixedIdentity::new(Some(profile_id()))))
        .oneshot(
            Request::builder()
                .uri("/ws/notifications?session-id=not-a-uuid")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn an_unauthenticated_connection_is_rejected() {
    let response = ws::build_router(state(FixedIdentity::new(None)))
        .oneshot(
            Request::builder()
                .uri(format!("/ws/notifications?session-id={}", session_id()))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn a_plain_http_get_is_not_upgraded() {
    let response = ws::build_router(state(FixedIdentity::new(Some(profile_id()))))
        .oneshot(
            Request::builder()
                .uri(format!("/ws/notifications?session-id={}", session_id()))
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_websocket_handshake_sets_the_accept_header() {
    let response = ws::build_router(state(FixedIdentity::new(Some(profile_id()))))
        .oneshot(
            Request::builder()
                .uri(format!("/ws/notifications?session-id={}", session_id()))
                .header("connection", "keep-alive, Upgrade")
                .header("upgrade", "websocket")
                .header("sec-websocket-version", "13")
                .header("sec-websocket-key", "dGhlIHNhbXBsZSBub25jZQ==")
                .body(Body::empty())
                .expect("request"),
        )
        .await
        .expect("response");

    assert_eq!(response.status(), StatusCode::SWITCHING_PROTOCOLS);
    assert_eq!(
        response
            .headers()
            .get("sec-websocket-accept")
            .and_then(|value| value.to_str().ok()),
        Some("s3pPLMBiTxaQ9kYGzzhZRbK+xOo=")
    );
}

#[test]
fn fixed_identity_implements_the_auth_boundary() {
    let identity = FixedIdentity::new(Some(profile_id()));
    let headers = axum::http::HeaderMap::new();
    assert_eq!(
        identity.profile(&headers, session_id()).expect("profile"),
        Some(profile_id())
    );
}
