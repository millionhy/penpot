//! `get-teams` and `get-projects` through the real router.

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, Response, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rpc::commands::auth::{
    AuthCommands, AuthProfile, CreatedSession, ProfileStore, SessionCreator,
};
use rpc::commands::dashboard::{DashboardCommands, DashboardStore, ProjectRow, TeamRow};
use rpc::errors::Cause;
use rpc::{
    build_router, AppState, AuthOptions, Registry, SessionRecord, SessionStore, TokenResolver,
};
use tower::ServiceExt;
use transit::Value;
use uuid::Uuid;

const NOW: i64 = 1_700_000_000_000;
const SECRET: &str = "dashboard-test-secret";
const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "Penpot-test-123!";
const PROFILE: Uuid = Uuid::from_u128(1);
const SESSION: Uuid = Uuid::from_u128(2);
const TEAM: Uuid = Uuid::from_u128(3);
const PROJECT: Uuid = Uuid::from_u128(4);

struct Profiles;

#[async_trait::async_trait]
impl ProfileStore for Profiles {
    async fn find_by_email(&self, email: &str) -> Result<Option<AuthProfile>, Cause> {
        Ok((email == EMAIL).then(profile))
    }

    async fn read(&self, id: Uuid) -> Result<Option<AuthProfile>, Cause> {
        Ok((id == PROFILE).then(profile))
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

struct Store {
    can_read: bool,
}

#[async_trait::async_trait]
impl DashboardStore for Store {
    async fn teams_for_profile(&self, profile_id: Uuid) -> Result<Vec<TeamRow>, Cause> {
        if profile_id != PROFILE {
            return Ok(Vec::new());
        }
        Ok(vec![TeamRow {
            id: TEAM,
            name: "Acme".to_owned(),
            photo_id: Some(Uuid::from_u128(9)),
            is_default: true,
            is_owner: true,
            is_admin: false,
            can_edit: false,
            created_at_ms: NOW,
            modified_at_ms: NOW,
        }])
    }

    async fn projects_for_team(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<ProjectRow>>, Cause> {
        if profile_id != PROFILE || team_id != TEAM || !self.can_read {
            return Ok(None);
        }
        Ok(Some(vec![ProjectRow {
            id: PROJECT,
            name: "Drafts".to_owned(),
            team_id: TEAM,
            is_default: true,
            is_pinned: true,
            count: 3,
            total_count: 5,
            created_at_ms: NOW,
            modified_at_ms: NOW,
            deleted_at_ms: None,
        }]))
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
        photo_id: None,
        lang: None,
        theme: None,
        auth_backend: Some("penpot".to_owned()),
        default_project_id: Some(PROJECT),
        default_team_id: Some(TEAM),
        created_at_ms: NOW,
        modified_at_ms: NOW,
        props: Value::map([]),
    }
}

fn app(can_read: bool) -> Router {
    let mut registry = Registry::new();
    let token = session::Token::new(SECRET).expect("token");
    AuthCommands {
        profiles: Arc::new(Profiles),
        sessions: Arc::new(NewSessions),
        token: token.clone(),
        cookie: session::CookiePolicy::default(),
        admins: BTreeSet::new(),
        login_enabled: true,
    }
    .register(&mut registry);
    DashboardCommands {
        store: Arc::new(Store { can_read }),
    }
    .register(&mut registry);

    let resolver = TokenResolver::new(token, Arc::new(SessionRows))
        .with_options(AuthOptions::default())
        .with_clock(Arc::new(|| NOW));
    build_router(AppState::new(registry).with_resolver(Arc::new(resolver)))
}

fn login_request() -> Request<Body> {
    let body = transit::encode(&Value::map([
        (Value::kw("email"), Value::str(EMAIL)),
        (Value::kw("password"), Value::str(PASSWORD)),
    ]));
    Request::builder()
        .method(Method::POST)
        .uri("/api/main/methods/login-with-password")
        .header(header::CONTENT_TYPE, "application/transit+json")
        .body(Body::from(body))
        .expect("request")
}

fn get(uri: &str, cookie: Option<&str>) -> Request<Body> {
    let mut request = Request::builder().method(Method::GET).uri(uri);
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

async fn login_cookie(router: &Router) -> String {
    let response = send(router, login_request()).await;
    assert_eq!(response.status(), StatusCode::OK);
    response
        .headers()
        .get(header::SET_COOKIE)
        .expect("set-cookie")
        .to_str()
        .expect("ascii")
        .split(';')
        .next()
        .expect("cookie pair")
        .to_owned()
}

fn code(value: &Value) -> Option<&str> {
    value.get_kw("code").and_then(Value::as_keyword)
}

#[tokio::test]
async fn login_then_get_teams_reports_membership_permissions() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let response = send(&router, get("/api/main/methods/get-teams", Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::OK);

    let teams = body(response).await;
    let rows = teams.items().expect("team list");
    assert_eq!(rows.len(), 1);
    let team = rows[0];
    assert_eq!(team.get_kw("id").and_then(Value::as_uuid), Some(TEAM));
    assert_eq!(team.get_kw("name").and_then(Value::as_str), Some("Acme"));
    assert_eq!(team.get_kw("is-default"), Some(&Value::Bool(true)));
    assert_eq!(
        team.get_kw("photo-id").and_then(Value::as_uuid),
        Some(Uuid::from_u128(9))
    );

    let permissions = team
        .get_kw("permissions")
        .and_then(Value::as_map)
        .expect("permissions");
    assert_eq!(
        permissions.get_kw("type").and_then(Value::as_keyword),
        Some("membership")
    );
    assert_eq!(
        permissions.get_kw("is-admin"),
        Some(&Value::Bool(true)),
        "an owner is also an admin"
    );
    assert_eq!(
        permissions.get_kw("can-edit"),
        Some(&Value::Bool(true)),
        "an owner can always edit"
    );
}

#[tokio::test]
async fn get_projects_returns_pins_counts_and_timestamps() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let uri = format!("/api/main/methods/get-projects?team-id={TEAM}");
    let response = send(&router, get(&uri, Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::OK);

    let projects = body(response).await;
    let rows = projects.items().expect("project list");
    assert_eq!(rows.len(), 1);
    let project = rows[0];
    assert_eq!(
        project.get_kw("team-id").and_then(Value::as_uuid),
        Some(TEAM)
    );
    assert_eq!(project.get_kw("is-pinned"), Some(&Value::Bool(true)));
    assert_eq!(project.get_kw("count").and_then(Value::as_i64), Some(3));
    assert_eq!(
        project.get_kw("total-count").and_then(Value::as_i64),
        Some(5)
    );
    assert_eq!(
        project.get_kw("created-at").and_then(Value::as_i64),
        Some(NOW)
    );
    assert!(project.get_kw("deleted-at").is_some_and(Value::is_nil));
}

#[tokio::test]
async fn get_projects_for_a_foreign_team_is_not_found() {
    let router = app(false);
    let cookie = login_cookie(&router).await;
    let uri = format!("/api/main/methods/get-projects?team-id={TEAM}");
    let response = send(&router, get(&uri, Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(code(&body(response).await), Some("object-not-found"));
}

#[tokio::test]
async fn dashboard_reads_require_a_session() {
    let router = app(true);
    for uri in [
        "/api/main/methods/get-teams",
        "/api/main/methods/get-projects?team-id=00000000-0000-0000-0000-000000000003",
    ] {
        let response = send(&router, get(uri, None)).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(code(&body(response).await), Some("authentication-required"));
    }
}
