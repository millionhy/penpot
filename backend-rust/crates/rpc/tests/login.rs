//! `login-with-password` and `get-profile` through the real router.

use std::collections::{BTreeSet, HashMap};
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, Response, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rpc::commands::auth::{
    AuthCommands, AuthProfile, CreatedSession, ProfileStore, SessionCreator,
};
use rpc::errors::Cause;
use rpc::{
    build_router, AppState, AuthOptions, Registry, SessionRecord, SessionStore, TokenResolver,
};
use tower::ServiceExt;
use transit::Value;
use uuid::Uuid;

const NOW: i64 = 1_700_000_000_000;
const SECRET: &str = "login-test-secret";
const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "Penpot-test-123!";
const PROFILE: Uuid = Uuid::from_u128(1);
const SESSION: Uuid = Uuid::from_u128(2);

struct Profiles(HashMap<String, AuthProfile>);

#[async_trait::async_trait]
impl ProfileStore for Profiles {
    async fn find_by_email(&self, email: &str) -> Result<Option<AuthProfile>, Cause> {
        Ok(self.0.get(email).cloned())
    }

    async fn read(&self, id: Uuid) -> Result<Option<AuthProfile>, Cause> {
        Ok(self.0.values().find(|profile| profile.id == id).cloned())
    }
}

struct NewSessions;

#[async_trait::async_trait]
impl SessionCreator for NewSessions {
    async fn create_session(
        &self,
        _profile_id: Uuid,
        _user_agent: Option<&str>,
    ) -> Result<CreatedSession, Cause> {
        Ok(CreatedSession {
            id: SESSION,
            created_at_ms: NOW,
            modified_at_ms: NOW,
        })
    }
}

struct SessionRows;

#[async_trait::async_trait]
impl SessionStore for SessionRows {
    async fn read_session(&self, id: Uuid) -> Result<Option<SessionRecord>, Cause> {
        Ok((id == SESSION).then_some(SessionRecord {
            id: SESSION,
            profile_id: PROFILE,
            modified_at_ms: NOW,
        }))
    }
}

fn profile() -> AuthProfile {
    AuthProfile {
        id: PROFILE,
        email: EMAIL.to_owned(),
        fullname: "Test User".to_owned(),
        password_hash: password::derive(PASSWORD).expect("derive"),
        is_active: true,
        is_blocked: false,
        is_demo: false,
        is_muted: false,
        photo_id: Some(Uuid::from_u128(7)),
        lang: None,
        theme: None,
        auth_backend: Some("penpot".to_owned()),
        default_project_id: None,
        default_team_id: None,
        created_at_ms: NOW,
        modified_at_ms: NOW,
        props: Value::map([
            (Value::kw("nudge"), Value::str("visible")),
            (Value::kw("private/key"), Value::str("hidden")),
        ]),
    }
}

fn app(profile: AuthProfile, login_enabled: bool) -> Router {
    let mut registry = Registry::new();
    let token = session::Token::new(SECRET).expect("token");
    AuthCommands {
        profiles: Arc::new(Profiles(HashMap::from([(profile.email.clone(), profile)]))),
        sessions: Arc::new(NewSessions),
        token: token.clone(),
        cookie: session::CookiePolicy::default(),
        admins: BTreeSet::new(),
        login_enabled,
    }
    .register(&mut registry);

    let resolver = TokenResolver::new(token, Arc::new(SessionRows))
        .with_options(AuthOptions::default())
        .with_clock(Arc::new(|| NOW));
    build_router(AppState::new(registry).with_resolver(Arc::new(resolver)))
}

fn login_request(email: &str, password: &str) -> Request<Body> {
    let body = transit::encode(&Value::map([
        (Value::kw("email"), Value::str(email)),
        (Value::kw("password"), Value::str(password)),
    ]));
    Request::builder()
        .method(Method::POST)
        .uri("/api/main/methods/login-with-password")
        .header(header::CONTENT_TYPE, "application/transit+json")
        .body(Body::from(body))
        .expect("request")
}

fn profile_request(cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder()
        .method(Method::GET)
        .uri("/api/main/methods/get-profile");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request.body(Body::empty()).expect("request")
}

async fn send(router: &Router, request: Request<Body>) -> Response<Body> {
    router.clone().oneshot(request).await.expect("response")
}

async fn body(response: Response<Body>) -> Value {
    let bytes = response
        .into_body()
        .collect()
        .await
        .expect("body")
        .to_bytes();
    let text = std::str::from_utf8(&bytes).expect("utf-8");
    transit::decode(text).unwrap_or_else(|error| panic!("bad transit `{text}`: {error}"))
}

fn code(value: &Value) -> Option<&str> {
    value.get_kw("code").and_then(Value::as_keyword)
}

#[tokio::test]
async fn login_sets_a_cookie_and_get_profile_uses_it() {
    let router = app(profile(), true);
    let response = send(&router, login_request(EMAIL, PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let set_cookie = response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("ascii")
        .to_owned();
    assert!(set_cookie.contains("HttpOnly"));

    let token = set_cookie
        .split(';')
        .next()
        .and_then(|pair| pair.strip_prefix("auth-token="))
        .expect("auth-token cookie");
    let claims = session::Token::new(SECRET)
        .expect("token")
        .verify(token, Some(session::AUTHENTICATION_ISSUER), NOW)
        .expect("claims");
    assert_eq!(claims.sid(), Some(SESSION));
    assert_eq!(claims.uid(), Some(PROFILE));

    let login = body(response).await;
    assert_eq!(login.get_kw("id").and_then(Value::as_uuid), Some(PROFILE));
    assert_eq!(login.get_kw("password"), None);

    let response = send(
        &router,
        profile_request(Some(&format!("auth-token={token}"))),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);
    let profile = body(response).await;
    assert_eq!(profile.get_kw("id").and_then(Value::as_uuid), Some(PROFILE));
    assert_eq!(
        profile
            .get_kw("photo-id")
            .and_then(Value::as_uuid)
            .map(|id| id.to_string()),
        Some(Uuid::from_u128(7).to_string())
    );
    assert!(profile.get_kw("theme").is_some_and(Value::is_nil));
    let props = profile
        .get_kw("props")
        .and_then(Value::as_map)
        .expect("props");
    assert!(props.get_kw("nudge").is_some());
    assert!(props.get_kw("private/key").is_none());
}

#[tokio::test]
async fn get_profile_is_anonymous_without_a_cookie() {
    let response = send(&app(profile(), true), profile_request(None)).await;
    assert_eq!(response.status(), StatusCode::OK);
    let body = body(response).await;
    assert_eq!(
        body.get_kw("id").and_then(Value::as_uuid),
        Some(Uuid::nil())
    );
    assert_eq!(
        body.get_kw("fullname").and_then(Value::as_str),
        Some("Anonymous User")
    );
}

#[tokio::test]
async fn login_failures_match_the_clojure_error_codes() {
    let router = app(profile(), true);
    let cases = [
        (
            login_request(EMAIL, "wrong"),
            StatusCode::BAD_REQUEST,
            "wrong-credentials",
        ),
        (
            login_request("missing@example.com", PASSWORD),
            StatusCode::BAD_REQUEST,
            "wrong-credentials",
        ),
    ];
    for (request, status, expected) in cases {
        let response = send(&router, request).await;
        assert_eq!(response.status(), status);
        assert_eq!(code(&body(response).await), Some(expected));
    }

    let mut without_password = profile();
    without_password.password_hash = "!".to_owned();
    let response = send(&app(without_password, true), login_request(EMAIL, PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(
        code(&body(response).await),
        Some("account-without-password")
    );

    let mut inactive = profile();
    inactive.is_active = false;
    let response = send(&app(inactive, true), login_request(EMAIL, PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(response).await), Some("wrong-credentials"));

    let mut blocked = profile();
    blocked.is_blocked = true;
    let response = send(&app(blocked, true), login_request(EMAIL, PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(response).await), Some("profile-blocked"));

    let response = send(&app(profile(), false), login_request(EMAIL, PASSWORD)).await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(response).await), Some("login-disabled"));
}

#[tokio::test]
async fn an_invalid_email_is_rejected_before_lookup() {
    let response = send(
        &app(profile(), true),
        login_request("not-an-email", PASSWORD),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(response).await), Some("params-validation"));
}
