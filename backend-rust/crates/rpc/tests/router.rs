//! HTTP behaviour of the M3 skeleton, exercised with `tower::ServiceExt::oneshot`.

use std::collections::BTreeSet;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::connect_info::ConnectInfo;
use axum::http::{header, HeaderMap, Method, Request, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rpc::{
    build_router, context_snapshot, AppState, AuthPolicy, AuthType, Command, CommandResult,
    HandlerFuture, Identity, Options, ParamKind, ParamSchema, ParamSpec, Registry, SessionResolver,
    SseEvent, TransactionHook,
};
use tower::ServiceExt;
use transit::Value;
use uuid::Uuid;

use std::net::SocketAddr;

const PROFILE: &str = "8c4b1a2e-5f6d-4a3b-9c8d-7e6f5a4b3c2d";
const FILE: &str = "1d2c3b4a-5e6f-4a7b-8c9d-0e1f2a3b4c5d";

fn kw(name: &str) -> Value {
    Value::kw(name)
}

struct TestResolver;

#[async_trait::async_trait]
impl SessionResolver for TestResolver {
    async fn resolve(
        &self,
        headers: &HeaderMap,
        _session_id: Option<Uuid>,
    ) -> Result<Identity, rpc::errors::Cause> {
        let Some(profile) = headers.get("x-test-profile") else {
            return Ok(Identity::default());
        };
        let profile = Uuid::parse_str(profile.to_str().expect("ascii")).expect("uuid");
        let auth_type = match headers.get("x-test-auth").and_then(|v| v.to_str().ok()) {
            Some("token") => AuthType::Token,
            _ => AuthType::Session,
        };
        let token_perms = headers
            .get("x-test-perms")
            .and_then(|v| v.to_str().ok())
            .map(|v| {
                v.split(',')
                    .filter(|perm| !perm.is_empty())
                    .map(str::to_owned)
                    .collect::<BTreeSet<_>>()
            })
            .unwrap_or_default();
        Ok(Identity {
            profile_id: Some(profile),
            auth_type: Some(auth_type),
            token_perms,
            auth_key_id: None,
        })
    }
}

struct CountingTransactions(Arc<AtomicUsize>);

impl TransactionHook for CountingTransactions {
    fn wrap(&self, _ctx: rpc::CommandContext, next: HandlerFuture) -> HandlerFuture {
        self.0.fetch_add(1, Ordering::SeqCst);
        next
    }
}

fn params_schema() -> ParamSchema {
    ParamSchema::new([
        ParamSpec::required("id", ParamKind::Uuid),
        ParamSpec::optional("limit", ParamKind::Int),
        ParamSpec::optional("tags", ParamKind::Set(Box::new(ParamKind::Str))),
        ParamSpec::optional("mode", ParamKind::Keyword),
    ])
}

fn registry() -> Registry {
    let mut registry = Registry::new();

    registry.register(
        Command::new("get-echo", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .public(),
    );
    registry.register(
        Command::new("echo", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .public(),
    );
    registry.register(
        Command::new("get-private", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .auth(AuthPolicy::authenticated()),
    );
    registry.register(Command::new("get-default", |ctx| {
        Box::pin(async move { Ok(context_snapshot(&ctx)) })
    }));
    registry.register(
        Command::new("get-token", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .auth(AuthPolicy::token(["read"])),
    );
    registry.register(
        Command::new("get-params", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .public()
        .params(params_schema()),
    );
    registry.register(
        Command::new("get-nil", |_| {
            Box::pin(async { Ok(CommandResult::empty()) })
        })
        .public(),
    );
    registry.register(
        Command::new("get-status", |_| {
            Box::pin(async {
                Ok(CommandResult::ok(Value::Integer(1))
                    .with_status(201)
                    .with_header("x-test", "yes"))
            })
        })
        .public(),
    );
    registry.register(
        Command::new("get-fail", |_| {
            Box::pin(async {
                Err(rpc::errors::Cause::error(Value::map([
                    (kw("type"), kw("rate-limit")),
                    (kw("code"), kw("too-many")),
                    (kw("ttl"), Value::Integer(30)),
                ])))
            })
        })
        .public(),
    );
    registry.register(
        Command::new("get-sse", |_| {
            Box::pin(async {
                Ok(CommandResult::sse([SseEvent::new(
                    "update",
                    Value::map([(kw("a"), Value::Integer(1))]),
                )]))
            })
        })
        .public(),
    );
    registry.register(
        Command::new("get-tx", |_| {
            Box::pin(async { Ok(CommandResult::ok(Value::kw("tx"))) })
        })
        .public()
        .transaction(),
    );
    registry.register(
        Command::new("get-ping", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .public(),
    );

    registry
}

fn app() -> Router {
    build_router(
        AppState::new(registry())
            .with_resolver(Arc::new(TestResolver))
            .with_shared_key("exporter", "s3cret")
            .with_public_uri("http://localhost:3449"),
    )
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .expect("request")
}

fn head(uri: &str) -> Request<Body> {
    Request::builder()
        .method(Method::HEAD)
        .uri(uri)
        .body(Body::empty())
        .expect("request")
}

fn post(uri: &str, body: &str) -> Request<Body> {
    Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/transit+json")
        .body(Body::from(body.to_owned()))
        .expect("request")
}

fn with_header(mut request: Request<Body>, name: &'static str, value: &str) -> Request<Body> {
    request
        .headers_mut()
        .insert(name, value.parse().expect("header value"));
    request
}

async fn send(router: &Router, request: Request<Body>) -> (StatusCode, HeaderMap, String) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let headers = response.headers().clone();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
        headers,
        String::from_utf8(bytes.to_vec()).expect("utf-8 body"),
    )
}

fn decoded(body: &str) -> Value {
    transit::decode(body).unwrap_or_else(|error| panic!("bad transit `{body}`: {error}"))
}

fn code(body: &Value) -> Option<&str> {
    body.get_kw("code").and_then(Value::as_keyword)
}

#[tokio::test]
async fn main_route_dispatches_a_public_command() {
    let (status, headers, body) = send(&app(), get("/api/main/methods/get-echo")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "application/transit+json"
    );
    let body = decoded(&body);
    assert_eq!(
        body.get_kw("module").and_then(Value::as_keyword),
        Some("main")
    );
    assert_eq!(
        body.get_kw("name").and_then(Value::as_str),
        Some("get-echo")
    );
}

#[tokio::test]
async fn alias_route_uses_the_same_registry() {
    let (status, _, body) = send(&app(), get("/api/rpc/command/get-echo")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        decoded(&body).get_kw("path").and_then(Value::as_str),
        Some("/api/rpc/command/get-echo")
    );
}

#[tokio::test]
async fn unknown_command_is_404_not_found() {
    let (status, _, body) = send(&app(), get("/api/main/methods/get-missing")).await;
    assert_eq!(status, StatusCode::NOT_FOUND);
    assert_eq!(
        decoded(&body).get_kw("type").and_then(Value::as_keyword),
        Some("not-found")
    );
}

#[tokio::test]
async fn get_and_head_require_the_get_prefix() {
    let (status, _, body) = send(&app(), get("/api/main/methods/echo")).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(code(&decoded(&body)), Some("method-not-allowed"));

    let (status, _, _) = send(&app(), head("/api/main/methods/echo")).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);

    // `rpc.clj` checks the verb before it resolves the handler.
    let (status, _, body) = send(&app(), get("/api/main/methods/missing")).await;
    assert_eq!(status, StatusCode::METHOD_NOT_ALLOWED);
    assert_eq!(code(&decoded(&body)), Some("method-not-allowed"));
}

#[tokio::test]
async fn post_can_call_get_prefixed_commands() {
    let (status, _, _) = send(&app(), post("/api/main/methods/get-echo", "")).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn required_auth_rejects_an_anonymous_caller() {
    let (status, _, body) = send(&app(), get("/api/main/methods/get-private")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let body = decoded(&body);
    assert_eq!(
        body.get_kw("type").and_then(Value::as_keyword),
        Some("authentication")
    );
    assert_eq!(code(&body), Some("authentication-required"));
}

#[tokio::test]
async fn commands_without_auth_metadata_require_a_session() {
    let (status, _, body) = send(&app(), get("/api/main/methods/get-default")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code(&decoded(&body)), Some("authentication-required"));

    let request = with_header(
        get("/api/main/methods/get-default"),
        "x-test-profile",
        PROFILE,
    );
    let (status, _, _) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn a_session_identity_satisfies_required_auth() {
    let request = with_header(
        get("/api/main/methods/get-private"),
        "x-test-profile",
        PROFILE,
    );
    let (status, _, body) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        decoded(&body).get_kw("profile-id").and_then(Value::as_str),
        Some(PROFILE)
    );
}

#[tokio::test]
async fn token_commands_reject_session_identities() {
    let request = with_header(
        get("/api/main/methods/get-token"),
        "x-test-profile",
        PROFILE,
    );
    let (status, _, body) = send(&app(), request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&decoded(&body)), Some("token-auth-required"));
}

#[tokio::test]
async fn token_commands_check_permissions() {
    let request = with_header(
        with_header(
            with_header(
                get("/api/main/methods/get-token"),
                "x-test-profile",
                PROFILE,
            ),
            "x-test-auth",
            "token",
        ),
        "x-test-perms",
        "write",
    );
    let (status, _, body) = send(&app(), request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let body = decoded(&body);
    assert_eq!(code(&body), Some("missing-perms"));
    assert_eq!(
        body.get_kw("required")
            .and_then(Value::items)
            .map(|items| items.len()),
        Some(1)
    );

    let request = with_header(
        with_header(
            with_header(
                get("/api/main/methods/get-token"),
                "x-test-profile",
                PROFILE,
            ),
            "x-test-auth",
            "token",
        ),
        "x-test-perms",
        "read,write",
    );
    let (status, _, _) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn query_parameters_are_coerced_by_the_schema() {
    let uri = format!("/api/main/methods/get-params?id={FILE}&limit=10&tags=a&tags=b&mode=fast");
    let (status, _, body) = send(&app(), get(&uri)).await;
    assert_eq!(status, StatusCode::OK);
    let params = decoded(&body).get_kw("params").cloned().expect("params");
    assert!(matches!(params.get_kw("id"), Some(Value::Uuid(_))));
    assert_eq!(params.get_kw("limit"), Some(&Value::Integer(10)));
    assert_eq!(
        params
            .get_kw("tags")
            .and_then(Value::items)
            .map(|items| items.len()),
        Some(2)
    );
    assert_eq!(
        params.get_kw("mode").and_then(Value::as_keyword),
        Some("fast")
    );
}

#[tokio::test]
async fn missing_or_unknown_parameters_are_400() {
    let (status, _, body) = send(&app(), get("/api/main/methods/get-params")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&decoded(&body)), Some("params-validation"));

    let uri = format!("/api/main/methods/get-params?id={FILE}&extra=1");
    let (status, _, body) = send(&app(), get(&uri)).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&decoded(&body)), Some("params-validation"));
}

#[tokio::test]
async fn post_bodies_are_transit_maps_merged_with_the_query() {
    let body = transit::encode(&Value::map([
        (kw("id"), Value::str(FILE)),
        (kw("limit"), Value::Integer(5)),
    ]));
    let request = post("/api/main/methods/get-params?mode=slow", &body);
    let (status, _, response) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
    let params = decoded(&response)
        .get_kw("params")
        .cloned()
        .expect("params");
    assert_eq!(params.get_kw("limit"), Some(&Value::Integer(5)));
    assert_eq!(
        params.get_kw("mode").and_then(Value::as_keyword),
        Some("slow")
    );
}

#[tokio::test]
async fn non_transit_and_malformed_bodies_are_400() {
    let request = Request::builder()
        .method(Method::POST)
        .uri("/api/main/methods/get-echo")
        .header(header::CONTENT_TYPE, "application/json")
        .body(Body::from("{}"))
        .expect("request");
    let (status, _, body) = send(&app(), request).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&decoded(&body)), Some("params-validation"));

    let (status, _, body) = send(&app(), post("/api/main/methods/get-echo", "[\"^ \"")).await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert_eq!(code(&decoded(&body)), Some("params-validation"));
}

#[tokio::test]
async fn nil_results_are_204() {
    let (status, _, body) = send(&app(), get("/api/main/methods/get-nil")).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());
}

#[tokio::test]
async fn command_status_and_headers_are_propagated() {
    let (status, headers, _) = send(&app(), get("/api/main/methods/get-status")).await;
    assert_eq!(status, StatusCode::CREATED);
    assert_eq!(headers.get("x-test").unwrap(), "yes");
}

#[tokio::test]
async fn command_errors_reuse_the_m2_mapping() {
    let (status, headers, body) = send(&app(), get("/api/main/methods/get-fail")).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(headers.get("retry-after").unwrap(), "30");
    assert_eq!(
        decoded(&body).get_kw("type").and_then(Value::as_keyword),
        Some("rate-limit")
    );
}

#[tokio::test]
async fn management_routes_require_a_shared_key() {
    let (status, _, body) = send(&app(), get("/api/management/methods/get-ping")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert!(body.is_empty());

    let request = with_header(
        get("/api/management/methods/get-ping"),
        "x-shared-key",
        "exporter wrong",
    );
    let (status, _, _) = send(&app(), request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn management_accepts_the_shared_key() {
    let request = with_header(
        get("/api/management/methods/get-ping"),
        "x-shared-key",
        "exporter s3cret",
    );
    let (status, _, body) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        decoded(&body).get_kw("module").and_then(Value::as_keyword),
        Some("management")
    );
}

#[tokio::test]
async fn client_header_check_can_be_enabled() {
    let router = build_router(
        AppState::new(registry())
            .with_resolver(Arc::new(TestResolver))
            .with_options(Options {
                client_header_check: true,
                ..Options::default()
            }),
    );
    let (status, _, _) = send(&router, get("/api/main/methods/get-echo")).await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    let request = with_header(get("/api/main/methods/get-echo"), "x-client", "web");
    let (status, _, _) = send(&router, request).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn cors_preflight_and_allowlisted_origins() {
    let router = build_router(
        AppState::new(registry())
            .with_resolver(Arc::new(TestResolver))
            .with_options(Options {
                cors_allowed_origins: vec!["http://localhost:3449".to_owned()],
                ..Options::default()
            }),
    );

    let preflight = Request::builder()
        .method(Method::OPTIONS)
        .uri("/api/main/methods/get-echo")
        .header(header::ORIGIN, "http://localhost:3449")
        .header("access-control-request-method", "GET")
        .body(Body::empty())
        .expect("request");
    let (status, headers, body) = send(&router, preflight).await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    assert!(body.is_empty());
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "http://localhost:3449"
    );
    assert_eq!(
        headers
            .get(header::ACCESS_CONTROL_ALLOW_CREDENTIALS)
            .unwrap(),
        "true"
    );
    assert_eq!(headers.get(header::VARY).unwrap(), "Origin");

    let request = with_header(
        get("/api/main/methods/get-echo"),
        "origin",
        "http://localhost:3449",
    );
    let (status, headers, _) = send(&router, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).unwrap(),
        "http://localhost:3449"
    );

    let request = with_header(
        get("/api/main/methods/get-echo"),
        "origin",
        "http://evil.example",
    );
    let (status, headers, _) = send(&router, request).await;
    assert_eq!(status, StatusCode::OK);
    assert!(headers.get(header::ACCESS_CONTROL_ALLOW_ORIGIN).is_none());
    assert_eq!(headers.get(header::VARY).unwrap(), "Origin");
}

#[tokio::test]
async fn transit_verbose_switches_the_success_encoding() {
    let (status, _, body) = send(&app(), get("/api/main/methods/get-echo?transit_verbose=1")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(
        body.starts_with(r#"{"~:name":"get-echo""#),
        "expected verbose transit, got {body}"
    );
}

#[tokio::test]
async fn context_carries_request_metadata() {
    let request = with_header(
        with_header(
            with_header(get("/api/main/methods/get-echo"), "x-session-id", PROFILE),
            "x-real-ip",
            "203.0.113.7",
        ),
        "x-test-profile",
        PROFILE,
    );
    let (status, _, body) = send(&app(), request).await;
    assert_eq!(status, StatusCode::OK);
    let body = decoded(&body);
    assert_eq!(
        body.get_kw("session-id").and_then(Value::as_str),
        Some(PROFILE)
    );
    assert_eq!(
        body.get_kw("client-ip").and_then(Value::as_str),
        Some("203.0.113.7")
    );
    assert!(body.get_kw("request-id").and_then(Value::as_str).is_some());
    assert_eq!(body.get_kw("method").and_then(Value::as_str), Some("GET"));
}

#[tokio::test]
async fn client_ip_falls_back_to_the_socket_peer() {
    let router = app().layer(axum::Extension(ConnectInfo(SocketAddr::from((
        [198, 51, 100, 9],
        54321,
    )))));

    let (status, _, body) = send(&router, get("/api/main/methods/get-echo")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        decoded(&body).get_kw("client-ip").and_then(Value::as_str),
        Some("198.51.100.9")
    );

    let request = with_header(get("/api/main/methods/get-echo"), "x-real-ip", "not-an-ip");
    let (status, _, body) = send(&router, request).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        decoded(&body).get_kw("client-ip").and_then(Value::as_str),
        Some("198.51.100.9")
    );
}

#[tokio::test]
async fn body_limit_answers_413() {
    let router = build_router(
        AppState::new(registry())
            .with_resolver(Arc::new(TestResolver))
            .with_options(Options {
                max_body_bytes: 16,
                ..Options::default()
            }),
    );
    let body = "x".repeat(64);
    let (status, _, response) = send(&router, post("/api/main/methods/get-echo", &body)).await;
    assert_eq!(status, StatusCode::PAYLOAD_TOO_LARGE);
    assert_eq!(code(&decoded(&response)), Some("request-body-too-large"));
}

#[tokio::test]
async fn sse_uses_event_stream_headers() {
    let (status, headers, body) = send(&app(), get("/api/main/methods/get-sse")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        headers.get(header::CONTENT_TYPE).unwrap(),
        "text/event-stream;charset=UTF-8"
    );
    assert_eq!(body, "event: update\ndata: {\"~:a\":1}\n\n");
}

#[tokio::test]
async fn transaction_commands_go_through_the_hook() {
    let calls = Arc::new(AtomicUsize::new(0));
    let router = build_router(
        AppState::new(registry())
            .with_resolver(Arc::new(TestResolver))
            .with_transactions(Arc::new(CountingTransactions(calls.clone()))),
    );
    let (status, _, _) = send(&router, get("/api/main/methods/get-tx")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(calls.load(Ordering::SeqCst), 1);

    let (status, _, _) = send(&router, get("/api/main/methods/get-echo")).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "commands without ::db/transaction skip the hook"
    );
}

#[tokio::test]
async fn head_returns_no_body() {
    let (status, _, body) = send(&app(), head("/api/main/methods/get-echo")).await;
    assert_eq!(status, StatusCode::OK);
    assert!(body.is_empty());
}

#[tokio::test]
async fn doc_routes_redirect_to_the_public_uri() {
    for (uri, target) in [
        ("/api/_doc", "/api/main/doc"),
        ("/api/doc", "/api/main/doc"),
        ("/api/openapi", "/api/main/doc/openapi"),
        ("/api/openapi.join", "/api/main/doc/openapi.json"),
    ] {
        let (status, headers, _) = send(&app(), get(uri)).await;
        assert_eq!(status, StatusCode::PERMANENT_REDIRECT, "{uri}");
        assert_eq!(
            headers.get(header::LOCATION).unwrap().to_str().unwrap(),
            format!("http://localhost:3449{target}")
        );
    }
}
