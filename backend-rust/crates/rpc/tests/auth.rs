//! The `TokenResolver` plugged into the real router.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, HeaderName, Method, Request, StatusCode};
use http_body_util::BodyExt;
use rpc::auth::{AccessTokenRecord, AccessTokenStore, SessionRecord, SessionStore, TokenResolver};
use rpc::errors::Cause;
use rpc::{build_router, context_snapshot, AppState, AuthPolicy, Command, Registry};
use tower::ServiceExt;
use transit::Value;
use uuid::Uuid;

const NOW: i64 = 1_700_000_000_000;
const SID: Uuid = Uuid::from_u128(11);
const PROFILE: Uuid = Uuid::from_u128(12);
const TID: Uuid = Uuid::from_u128(13);

fn registry() -> Registry {
    let mut registry = Registry::new();
    registry.register(Command::new("get-private", |ctx| {
        Box::pin(async move { Ok(context_snapshot(&ctx)) })
    }));
    registry.register(
        Command::new("get-token", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .auth(AuthPolicy::token(["read"])),
    );
    registry
}

fn session_token(exp_ms: Option<i64>) -> String {
    let token = session::Token::new("test-secret").unwrap();
    let claims = session::SessionClaims {
        iss: Some(session::AUTHENTICATION_ISSUER.to_owned()),
        aud: Some(session::PENPOT_AUDIENCE.to_owned()),
        sid: Some(SID),
        iat_ms: Some(NOW),
        uid: Some(PROFILE),
        exp_ms,
        ..session::SessionClaims::default()
    };
    token.encode_at(&claims, NOW).unwrap()
}

fn access_token() -> String {
    let token = session::Token::new("test-secret").unwrap();
    let claims = Value::map([
        (Value::kw("iss"), Value::str("access-token")),
        (Value::kw("tid"), Value::Uuid(TID)),
        (Value::kw("iat"), Value::Instant(NOW)),
    ]);
    token
        .codec()
        .encrypt(transit::encode(&claims).as_bytes())
        .unwrap()
}

#[derive(Default)]
struct Sessions(HashMap<Uuid, SessionRecord>);

#[async_trait::async_trait]
impl SessionStore for Sessions {
    async fn read_session(&self, id: Uuid) -> Result<Option<SessionRecord>, Cause> {
        Ok(self.0.get(&id).cloned())
    }
}

struct FailingSessions;

#[async_trait::async_trait]
impl SessionStore for FailingSessions {
    async fn read_session(&self, _id: Uuid) -> Result<Option<SessionRecord>, Cause> {
        Err(Cause::other("session store unavailable"))
    }
}

struct Tokens(HashMap<Uuid, AccessTokenRecord>);

#[async_trait::async_trait]
impl AccessTokenStore for Tokens {
    async fn read_token(&self, id: Uuid) -> Result<Option<AccessTokenRecord>, Cause> {
        Ok(self.0.get(&id).cloned())
    }
}

fn resolver(sessions: impl SessionStore + 'static) -> TokenResolver {
    TokenResolver::new(
        session::Token::new("test-secret").unwrap(),
        Arc::new(sessions),
    )
    .with_clock(Arc::new(|| NOW))
}

fn live_resolver() -> TokenResolver {
    let mut sessions = Sessions::default();
    sessions.0.insert(
        SID,
        SessionRecord {
            id: SID,
            profile_id: PROFILE,
            modified_at_ms: NOW,
        },
    );
    resolver(sessions)
}

fn app(resolver: TokenResolver) -> axum::Router {
    build_router(AppState::new(registry()).with_resolver(Arc::new(resolver)))
}

fn get(uri: &str) -> Request<Body> {
    Request::builder()
        .method(Method::GET)
        .uri(uri)
        .body(Body::empty())
        .expect("request")
}

fn with_header(mut request: Request<Body>, name: HeaderName, value: &str) -> Request<Body> {
    request
        .headers_mut()
        .insert(name, value.parse().expect("header value"));
    request
}

async fn send(router: &axum::Router, request: Request<Body>) -> (StatusCode, String) {
    let response = router.clone().oneshot(request).await.expect("response");
    let status = response.status();
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    (
        status,
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
async fn a_cookie_session_reaches_a_private_command() {
    let token = session_token(None);
    let request = with_header(
        get("/api/main/methods/get-private"),
        header::COOKIE,
        &format!("auth-token={token}"),
    );
    let (status, body) = send(&app(live_resolver()), request).await;
    assert_eq!(status, StatusCode::OK);
    let body = decoded(&body);
    let profile = PROFILE.to_string();
    assert_eq!(
        body.get_kw("profile-id").and_then(Value::as_str),
        Some(profile.as_str())
    );
}

#[tokio::test]
async fn a_bearer_session_reaches_a_private_command() {
    let token = session_token(None);
    let request = with_header(
        get("/api/main/methods/get-private"),
        header::AUTHORIZATION,
        &format!("Bearer {token}"),
    );
    let (status, _) = send(&app(live_resolver()), request).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn an_anonymous_request_is_rejected() {
    let (status, body) = send(&app(live_resolver()), get("/api/main/methods/get-private")).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    assert_eq!(code(&decoded(&body)), Some("authentication-required"));
}

#[tokio::test]
async fn an_idle_expired_session_is_rejected() {
    let mut sessions = Sessions::default();
    sessions.0.insert(
        SID,
        SessionRecord {
            id: SID,
            profile_id: PROFILE,
            modified_at_ms: NOW - 8 * 24 * 60 * 60 * 1_000,
        },
    );
    let token = session_token(None);
    let request = with_header(
        get("/api/main/methods/get-private"),
        header::COOKIE,
        &format!("auth-token={token}"),
    );
    let (status, _) = send(&app(resolver(sessions)), request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_expired_token_is_rejected() {
    let token = session_token(Some(NOW - 1));
    let request = with_header(
        get("/api/main/methods/get-private"),
        header::COOKIE,
        &format!("auth-token={token}"),
    );
    let (status, _) = send(&app(live_resolver()), request).await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn an_access_token_can_satisfy_a_permission_policy() {
    let tokens = Tokens(HashMap::from([(
        TID,
        AccessTokenRecord {
            profile_id: Some(PROFILE),
            perms: ["read".to_owned()].into_iter().collect(),
            expires_at_ms: None,
        },
    )]));
    let resolver = resolver(Sessions::default()).with_access_tokens(Arc::new(tokens));
    let request = with_header(
        get("/api/main/methods/get-token"),
        header::AUTHORIZATION,
        &format!("Token {}", access_token()),
    );
    let (status, body) = send(&app(resolver), request).await;
    assert_eq!(status, StatusCode::OK);
    let profile = PROFILE.to_string();
    assert_eq!(
        decoded(&body).get_kw("profile-id").and_then(Value::as_str),
        Some(profile.as_str())
    );
}

#[tokio::test]
async fn an_access_token_without_the_permission_is_forbidden() {
    let tokens = Tokens(HashMap::from([(
        TID,
        AccessTokenRecord {
            profile_id: Some(PROFILE),
            perms: BTreeSet::new(),
            expires_at_ms: None,
        },
    )]));
    let resolver = resolver(Sessions::default()).with_access_tokens(Arc::new(tokens));
    let request = with_header(
        get("/api/main/methods/get-token"),
        header::AUTHORIZATION,
        &format!("Token {}", access_token()),
    );
    let (status, body) = send(&app(resolver), request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&decoded(&body)), Some("missing-perms"));
}

#[tokio::test]
async fn a_session_cannot_satisfy_a_token_policy() {
    let token = session_token(None);
    let request = with_header(
        get("/api/main/methods/get-token"),
        header::COOKIE,
        &format!("auth-token={token}"),
    );
    let (status, body) = send(&app(live_resolver()), request).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(code(&decoded(&body)), Some("token-auth-required"));
}

#[tokio::test]
async fn a_store_failure_is_a_server_error() {
    let token = session_token(None);
    let request = with_header(
        get("/api/main/methods/get-private"),
        header::COOKIE,
        &format!("auth-token={token}"),
    );
    let (status, _) = send(&app(resolver(FailingSessions)), request).await;
    assert_eq!(status, StatusCode::INTERNAL_SERVER_ERROR);
}

#[tokio::test]
async fn a_custom_cookie_name_is_honored() {
    let token = session_token(None);
    let resolver = live_resolver().with_options(rpc::AuthOptions {
        cookie_name: "penpot-auth".to_owned(),
        ..rpc::AuthOptions::default()
    });
    let request = with_header(
        get("/api/main/methods/get-private"),
        header::COOKIE,
        &format!("project=1; penpot-auth={token}"),
    );
    let (status, _) = send(&app(resolver), request).await;
    assert_eq!(status, StatusCode::OK);
}
