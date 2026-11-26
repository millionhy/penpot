//! Dashboard reads through the real router (M18, M19).

use std::collections::BTreeSet;
use std::sync::Arc;

use axum::body::Body;
use axum::http::{header, Method, Request, Response, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rpc::commands::auth::{
    AuthCommands, AuthProfile, CreatedSession, ProfileStore, SessionCreator,
};
use rpc::commands::dashboard::{
    CommentThreadRow, DashboardCommands, DashboardStore, FontScope, FontVariantRow, ProjectRow,
    RecentFileRow, TeamMemberRow, TeamRow,
};
use rpc::commands::templates::TemplatesCommands;
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
const FILE: Uuid = Uuid::from_u128(5);
const FONT: Uuid = Uuid::from_u128(6);
const THUMBNAIL: Uuid = Uuid::from_u128(7);

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

    async fn recent_files(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<RecentFileRow>>, Cause> {
        if profile_id != PROFILE || team_id != TEAM || !self.can_read {
            return Ok(None);
        }
        Ok(Some(vec![RecentFileRow {
            id: FILE,
            revn: 7,
            vern: 3,
            project_id: PROJECT,
            team_id: TEAM,
            name: "Landing".to_owned(),
            is_shared: true,
            thumbnail_id: Some(THUMBNAIL),
            row_num: 1,
            created_at_ms: NOW,
            modified_at_ms: NOW,
        }]))
    }

    async fn font_variants(
        &self,
        profile_id: Uuid,
        scope: FontScope,
    ) -> Result<Option<Vec<FontVariantRow>>, Cause> {
        if profile_id != PROFILE || !self.can_read || scope != FontScope::Team(TEAM) {
            return Ok(None);
        }
        Ok(Some(vec![FontVariantRow {
            id: Uuid::from_u128(8),
            team_id: TEAM,
            profile_id: Some(PROFILE),
            font_id: FONT,
            font_family: "Inter".to_owned(),
            font_weight: 700,
            font_style: "normal".to_owned(),
            variant_name: Some("Bold".to_owned()),
            otf_file_id: None,
            ttf_file_id: Some(Uuid::from_u128(9)),
            woff1_file_id: None,
            woff2_file_id: Some(Uuid::from_u128(10)),
            created_at_ms: NOW,
            modified_at_ms: NOW,
        }]))
    }

    async fn team_members(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<TeamMemberRow>>, Cause> {
        if profile_id != PROFILE || team_id != TEAM || !self.can_read {
            return Ok(None);
        }
        Ok(Some(vec![TeamMemberRow {
            id: PROFILE,
            team_id: TEAM,
            profile_id: PROFILE,
            email: EMAIL.to_owned(),
            fullname: "Test User".to_owned(),
            photo_id: None,
            is_active: true,
            is_owner: true,
            is_admin: false,
            can_edit: false,
            created_at_ms: NOW,
            modified_at_ms: NOW,
        }]))
    }

    async fn unread_comment_threads(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<CommentThreadRow>>, Cause> {
        if profile_id != PROFILE || team_id != TEAM || !self.can_read {
            return Ok(None);
        }
        Ok(Some(vec![CommentThreadRow {
            id: Uuid::from_u128(11),
            file_id: FILE,
            owner_id: PROFILE,
            page_id: Uuid::from_u128(12),
            seqn: 3,
            position_x: 10.5,
            position_y: -20.25,
            is_resolved: false,
            participants: Value::Set([Value::Uuid(PROFILE)].into_iter().collect()),
            mentions: vec![PROFILE],
            owner_fullname: Some("Test User".to_owned()),
            owner_email: Some(EMAIL.to_owned()),
            owner_photo_id: None,
            team_id: TEAM,
            file_name: "Landing".to_owned(),
            project_id: PROJECT,
            content: "Please review".to_owned(),
            count_comments: 2,
            count_unread_comments: 1,
            created_at_ms: NOW,
            modified_at_ms: NOW,
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
    TemplatesCommands::from_embedded()
        .expect("onboarding templates")
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
        "/api/main/methods/get-team-recent-files?team-id=00000000-0000-0000-0000-000000000003",
        "/api/main/methods/get-font-variants?team-id=00000000-0000-0000-0000-000000000003",
        "/api/main/methods/get-team-members?team-id=00000000-0000-0000-0000-000000000003",
        "/api/main/methods/get-unread-comment-threads?team-id=00000000-0000-0000-0000-000000000003",
        "/api/main/methods/get-builtin-templates",
    ] {
        let response = send(&router, get(uri, None)).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(code(&body(response).await), Some("authentication-required"));
    }
}

#[tokio::test]
async fn recent_files_report_revision_thumbnail_and_row_number() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let uri = format!("/api/main/methods/get-team-recent-files?team-id={TEAM}");
    let response = send(&router, get(&uri, Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::OK);

    let files = body(response).await;
    let rows = files.items().expect("file list");
    assert_eq!(rows.len(), 1);
    let file = rows[0];
    assert_eq!(file.get_kw("id").and_then(Value::as_uuid), Some(FILE));
    assert_eq!(file.get_kw("revn").and_then(Value::as_i64), Some(7));
    assert_eq!(file.get_kw("vern").and_then(Value::as_i64), Some(3));
    assert_eq!(
        file.get_kw("thumbnail-id").and_then(Value::as_uuid),
        Some(THUMBNAIL)
    );
    assert_eq!(file.get_kw("row-num").and_then(Value::as_i64), Some(1));
    assert_eq!(file.get_kw("is-shared"), Some(&Value::Bool(true)));
    assert_eq!(
        file.get_kw("modified-at").and_then(Value::as_i64),
        Some(NOW)
    );
}

#[tokio::test]
async fn font_variants_use_the_team_scope() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let uri = format!("/api/main/methods/get-font-variants?team-id={TEAM}");
    let response = send(&router, get(&uri, Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::OK);

    let variants = body(response).await;
    let rows = variants.items().expect("font list");
    assert_eq!(rows.len(), 1);
    let font = rows[0];
    assert_eq!(font.get_kw("font-id").and_then(Value::as_uuid), Some(FONT));
    assert_eq!(
        font.get_kw("font-family").and_then(Value::as_str),
        Some("Inter")
    );
    assert_eq!(
        font.get_kw("font-weight").and_then(Value::as_i64),
        Some(700)
    );
    assert_eq!(
        font.get_kw("variant-name").and_then(Value::as_str),
        Some("Bold")
    );
    assert_eq!(
        font.get_kw("woff2-file-id").and_then(Value::as_uuid),
        Some(Uuid::from_u128(10))
    );
    assert!(font.get_kw("otf-file-id").is_some_and(Value::is_nil));
}

#[tokio::test]
async fn font_variants_need_one_scope() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        get("/api/main/methods/get-font-variants", Some(&cookie)),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(response).await), Some("params-validation"));
}

#[tokio::test]
async fn team_members_carry_relation_flags_and_profile_identity() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let uri = format!("/api/main/methods/get-team-members?team-id={TEAM}");
    let response = send(&router, get(&uri, Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::OK);

    let members = body(response).await;
    let rows = members.items().expect("member list");
    assert_eq!(rows.len(), 1);
    let member = rows[0];
    assert_eq!(member.get_kw("id").and_then(Value::as_uuid), Some(PROFILE));
    assert_eq!(
        member.get_kw("profile-id").and_then(Value::as_uuid),
        Some(PROFILE)
    );
    assert_eq!(member.get_kw("email").and_then(Value::as_str), Some(EMAIL));
    assert_eq!(
        member.get_kw("fullname").and_then(Value::as_str),
        Some("Test User")
    );
    assert_eq!(member.get_kw("is-owner"), Some(&Value::Bool(true)));
    assert_eq!(member.get_kw("is-active"), Some(&Value::Bool(true)));
}

#[tokio::test]
async fn unread_threads_carry_point_participants_and_counts() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let uri = format!("/api/main/methods/get-unread-comment-threads?team-id={TEAM}");
    let response = send(&router, get(&uri, Some(&cookie))).await;
    assert_eq!(response.status(), StatusCode::OK);

    let threads = body(response).await;
    let rows = threads.items().expect("thread list");
    assert_eq!(rows.len(), 1);
    let thread = rows[0];
    let Some(Value::Tagged { tag, rep }) = thread.get_kw("position") else {
        panic!("point tag");
    };
    assert_eq!(tag, "point");
    let point = rep.as_map().expect("point map");
    assert_eq!(point.get_kw("x").and_then(Value::as_f64), Some(10.5));
    assert_eq!(point.get_kw("y").and_then(Value::as_f64), Some(-20.25));
    assert_eq!(
        thread
            .get_kw("count-unread-comments")
            .and_then(Value::as_i64),
        Some(1)
    );
    assert_eq!(
        thread
            .get_kw("participants")
            .and_then(Value::items)
            .map(|items| items.len()),
        Some(1)
    );
    assert_eq!(
        thread
            .get_kw("mentions")
            .and_then(Value::items)
            .map(|items| items.len()),
        Some(1)
    );
}

#[tokio::test]
async fn dashboard_content_reads_hide_foreign_teams() {
    let router = app(false);
    let cookie = login_cookie(&router).await;
    for uri in [
        format!("/api/main/methods/get-team-recent-files?team-id={TEAM}"),
        format!("/api/main/methods/get-font-variants?team-id={TEAM}"),
        format!("/api/main/methods/get-team-members?team-id={TEAM}"),
        format!("/api/main/methods/get-unread-comment-threads?team-id={TEAM}"),
    ] {
        let response = send(&router, get(&uri, Some(&cookie))).await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND, "{uri}");
        assert_eq!(
            code(&body(response).await),
            Some("object-not-found"),
            "{uri}"
        );
    }
}

#[tokio::test]
async fn builtin_templates_project_id_and_name_only() {
    let router = app(true);
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        get("/api/main/methods/get-builtin-templates", Some(&cookie)),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let templates = body(response).await;
    let rows = templates.items().expect("template list");
    assert_eq!(rows.len(), 15);
    let first = rows[0];
    assert_eq!(
        first.get_kw("id").and_then(Value::as_str),
        Some("tokens-starter-kit")
    );
    assert_eq!(
        first.get_kw("name").and_then(Value::as_str),
        Some("Design tokens starter kit")
    );
    assert!(
        first.get_kw("file-uri").is_none(),
        "the command hides the download URL"
    );
}
