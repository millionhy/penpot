//! Project writes and the project file list through the real router (M21).

use std::collections::BTreeSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{header, Method, Request, Response, StatusCode};
use axum::Router;
use http_body_util::BodyExt;
use rpc::commands::auth::{
    AuthCommands, AuthProfile, CreatedSession, ProfileStore, SessionCreator,
};
use rpc::commands::dashboard::ProjectRow;
use rpc::commands::projects::{ProjectCommands, ProjectFileRow, ProjectStore, RoleFlags};
use rpc::errors::Cause;
use rpc::{
    build_router, AppState, AuthOptions, Registry, SessionRecord, SessionStore, TokenResolver,
};
use tower::ServiceExt;
use transit::Value;
use uuid::Uuid;

const NOW: i64 = 1_700_000_000_000;
const SECRET: &str = "project-test-secret";
const EMAIL: &str = "user@example.com";
const PASSWORD: &str = "Penpot-test-123!";
const TENANT: &str = "acme";
const PROFILE: Uuid = Uuid::from_u128(1);
const SESSION: Uuid = Uuid::from_u128(2);
const TEAM: Uuid = Uuid::from_u128(3);
const PROJECT: Uuid = Uuid::from_u128(4);
const FILE: Uuid = Uuid::from_u128(5);
const THUMBNAIL: Uuid = Uuid::from_u128(7);

const DAY_MS: i64 = 24 * 60 * 60 * 1000;

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

#[derive(Debug, Clone, PartialEq, Eq)]
enum Call {
    Create {
        profile_id: Uuid,
        team_id: Uuid,
        name: String,
        now_ms: i64,
    },
    Pin {
        profile_id: Uuid,
        team_id: Uuid,
        project_id: Uuid,
        is_pinned: bool,
    },
    Rename {
        project_id: Uuid,
        name: String,
    },
    Delete {
        project_id: Uuid,
        deleted_at_ms: i64,
        now_ms: i64,
        queue: String,
    },
}

#[derive(Clone)]
struct Store {
    team: Option<RoleFlags>,
    project: Option<RoleFlags>,
    files: Vec<ProjectFileRow>,
    delete_error: Option<Cause>,
    calls: Arc<Mutex<Vec<Call>>>,
}

impl Store {
    fn editor() -> Self {
        Self {
            team: Some(RoleFlags {
                is_owner: true,
                ..RoleFlags::default()
            }),
            project: Some(RoleFlags {
                is_owner: true,
                ..RoleFlags::default()
            }),
            files: Vec::new(),
            delete_error: None,
            calls: Arc::new(Mutex::new(Vec::new())),
        }
    }

    fn calls(&self) -> Vec<Call> {
        self.calls.lock().expect("calls").clone()
    }
}

#[async_trait::async_trait]
impl ProjectStore for Store {
    async fn team_permissions(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause> {
        Ok((profile_id == PROFILE && team_id == TEAM)
            .then_some(self.team)
            .flatten())
    }

    async fn project_permissions(
        &self,
        profile_id: Uuid,
        project_id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause> {
        Ok((profile_id == PROFILE && project_id == PROJECT)
            .then_some(self.project)
            .flatten())
    }

    async fn project_files(&self, project_id: Uuid) -> Result<Vec<ProjectFileRow>, Cause> {
        assert_eq!(project_id, PROJECT);
        Ok(self.files.clone())
    }

    async fn create_project(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
        name: &str,
        now_ms: i64,
    ) -> Result<ProjectRow, Cause> {
        self.calls.lock().expect("calls").push(Call::Create {
            profile_id,
            team_id,
            name: name.to_owned(),
            now_ms,
        });
        Ok(ProjectRow {
            id: Uuid::from_u128(42),
            name: name.to_owned(),
            team_id,
            is_default: false,
            is_pinned: false,
            count: 0,
            total_count: 0,
            created_at_ms: now_ms,
            modified_at_ms: now_ms,
            deleted_at_ms: None,
        })
    }

    async fn set_project_pin(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
        project_id: Uuid,
        is_pinned: bool,
    ) -> Result<bool, Cause> {
        self.calls.lock().expect("calls").push(Call::Pin {
            profile_id,
            team_id,
            project_id,
            is_pinned,
        });
        Ok(true)
    }

    async fn rename_project(&self, project_id: Uuid, name: &str) -> Result<(), Cause> {
        self.calls.lock().expect("calls").push(Call::Rename {
            project_id,
            name: name.to_owned(),
        });
        Ok(())
    }

    async fn delete_project(
        &self,
        project_id: Uuid,
        deleted_at_ms: i64,
        now_ms: i64,
        queue: &str,
    ) -> Result<(), Cause> {
        if let Some(error) = &self.delete_error {
            return Err(error.clone());
        }
        self.calls.lock().expect("calls").push(Call::Delete {
            project_id,
            deleted_at_ms,
            now_ms,
            queue: queue.to_owned(),
        });
        Ok(())
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

fn app(store: Store) -> Router {
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
    let store: Arc<dyn ProjectStore> = Arc::new(store);
    ProjectCommands::new(store, TENANT, Duration::from_millis((7 * DAY_MS) as u64))
        .with_clock(Arc::new(|| NOW))
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

fn post(uri: &str, cookie: Option<&str>, params: Value) -> Request<Body> {
    let mut request = Request::builder()
        .method(Method::POST)
        .uri(uri)
        .header(header::CONTENT_TYPE, "application/transit+json");
    if let Some(cookie) = cookie {
        request = request.header(header::COOKIE, cookie);
    }
    request
        .body(Body::from(transit::encode(&params)))
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
async fn create_project_requires_team_edit_permission() {
    let mut store = Store::editor();
    store.team = Some(RoleFlags::default());
    let router = app(store);
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/create-project",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("name"), Value::str("Landing")),
            ]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(code(&body(response).await), Some("object-not-found"));
}

#[tokio::test]
async fn create_project_trims_the_name_and_answers_the_project_row() {
    let store = Store::editor();
    let router = app(store.clone());
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/create-project",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("name"), Value::str("  Landing  ")),
            ]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let project = body(response).await;
    assert_eq!(
        project.get_kw("name").and_then(Value::as_str),
        Some("Landing")
    );
    assert_eq!(
        project.get_kw("team-id").and_then(Value::as_uuid),
        Some(TEAM)
    );
    assert_eq!(project.get_kw("is-default"), Some(&Value::Bool(false)));
    assert_eq!(project.get_kw("is-pinned"), Some(&Value::Bool(false)));
    assert_eq!(project.get_kw("count").and_then(Value::as_i64), Some(0));
    assert_eq!(
        project.get_kw("created-at").and_then(Value::as_i64),
        Some(NOW)
    );
    assert_eq!(
        store.calls(),
        vec![Call::Create {
            profile_id: PROFILE,
            team_id: TEAM,
            name: "Landing".to_owned(),
            now_ms: NOW,
        }]
    );
}

#[tokio::test]
async fn create_project_rejects_an_empty_name_and_a_client_id() {
    let router = app(Store::editor());
    let cookie = login_cookie(&router).await;

    let empty = send(
        &router,
        post(
            "/api/main/methods/create-project",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("name"), Value::str("")),
            ]),
        ),
    )
    .await;
    assert_eq!(empty.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(empty).await), Some("params-validation"));

    let long = "x".repeat(251);
    let too_long = send(
        &router,
        post(
            "/api/main/methods/create-project",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("name"), Value::str(long)),
            ]),
        ),
    )
    .await;
    assert_eq!(too_long.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(too_long).await), Some("params-validation"));

    // `schema:create-project` is `{:closed true}`: a client id is rejected.
    let with_id = send(
        &router,
        post(
            "/api/main/methods/create-project",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("name"), Value::str("Landing")),
                (Value::kw("id"), Value::Uuid(Uuid::from_u128(99))),
            ]),
        ),
    )
    .await;
    assert_eq!(with_id.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(with_id).await), Some("params-validation"));
}

#[tokio::test]
async fn update_project_pin_forwards_the_flag_and_answers_204() {
    let store = Store::editor();
    let router = app(store.clone());
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/update-project-pin",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("id"), Value::Uuid(PROJECT)),
                (Value::kw("is-pinned"), Value::Bool(true)),
            ]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        store.calls(),
        vec![Call::Pin {
            profile_id: PROFILE,
            team_id: TEAM,
            project_id: PROJECT,
            is_pinned: true,
        }]
    );
}

#[tokio::test]
async fn update_project_pin_on_a_foreign_project_is_not_found() {
    let mut store = Store::editor();
    store.project = None;
    let router = app(store.clone());
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/update-project-pin",
            Some(&cookie),
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("id"), Value::Uuid(PROJECT)),
                (Value::kw("is-pinned"), Value::Bool(false)),
            ]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(code(&body(response).await), Some("object-not-found"));
    assert!(store.calls().is_empty());
}

#[tokio::test]
async fn rename_project_needs_edit_permission() {
    let mut store = Store::editor();
    store.project = Some(RoleFlags::default());
    let router = app(store.clone());
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/rename-project",
            Some(&cookie),
            Value::map([
                (Value::kw("id"), Value::Uuid(PROJECT)),
                (Value::kw("name"), Value::str("Renamed")),
            ]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(code(&body(response).await), Some("object-not-found"));
    assert!(store.calls().is_empty());
}

#[tokio::test]
async fn rename_project_trims_the_name_and_answers_204() {
    let store = Store::editor();
    let router = app(store.clone());
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/rename-project",
            Some(&cookie),
            Value::map([
                (Value::kw("id"), Value::Uuid(PROJECT)),
                (Value::kw("name"), Value::str("  Renamed  ")),
            ]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        store.calls(),
        vec![Call::Rename {
            project_id: PROJECT,
            name: "Renamed".to_owned(),
        }]
    );
}

#[tokio::test]
async fn delete_project_answers_204_and_uses_the_deletion_delay() {
    let store = Store::editor();
    let router = app(store.clone());
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/delete-project",
            Some(&cookie),
            Value::map([(Value::kw("id"), Value::Uuid(PROJECT))]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NO_CONTENT);
    assert_eq!(
        store.calls(),
        vec![Call::Delete {
            project_id: PROJECT,
            deleted_at_ms: NOW + 7 * DAY_MS,
            now_ms: NOW,
            queue: format!("{TENANT}:default"),
        }]
    );
}

#[tokio::test]
async fn delete_default_project_reports_non_deletable_project() {
    let mut store = Store::editor();
    store.delete_error = Some(rpc::commands::projects::non_deletable_project());
    let router = app(store);
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        post(
            "/api/main/methods/delete-project",
            Some(&cookie),
            Value::map([(Value::kw("id"), Value::Uuid(PROJECT))]),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    assert_eq!(code(&body(response).await), Some("non-deletable-project"));
}

#[tokio::test]
async fn get_project_files_returns_the_project_rows() {
    let mut store = Store::editor();
    store.files = vec![ProjectFileRow {
        id: FILE,
        project_id: PROJECT,
        team_id: TEAM,
        name: "Landing".to_owned(),
        revn: 7,
        vern: 3,
        is_shared: true,
        thumbnail_id: Some(THUMBNAIL),
        created_at_ms: NOW,
        modified_at_ms: NOW,
    }];
    let router = app(store);
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        get(
            &format!("/api/main/methods/get-project-files?project-id={PROJECT}"),
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::OK);

    let files = body(response).await;
    let rows = files.items().expect("file list");
    assert_eq!(rows.len(), 1);
    let file = rows[0];
    assert_eq!(file.get_kw("id").and_then(Value::as_uuid), Some(FILE));
    assert_eq!(
        file.get_kw("project-id").and_then(Value::as_uuid),
        Some(PROJECT)
    );
    assert_eq!(
        file.get_kw("thumbnail-id").and_then(Value::as_uuid),
        Some(THUMBNAIL)
    );
    assert_eq!(file.get_kw("revn").and_then(Value::as_i64), Some(7));
}

#[tokio::test]
async fn get_project_files_on_a_foreign_project_is_not_found() {
    let mut store = Store::editor();
    store.project = None;
    let router = app(store);
    let cookie = login_cookie(&router).await;
    let response = send(
        &router,
        get(
            &format!("/api/main/methods/get-project-files?project-id={PROJECT}"),
            Some(&cookie),
        ),
    )
    .await;
    assert_eq!(response.status(), StatusCode::NOT_FOUND);
    assert_eq!(code(&body(response).await), Some("object-not-found"));
}

#[tokio::test]
async fn project_commands_require_a_session() {
    let router = app(Store::editor());
    for request in [
        post(
            "/api/main/methods/create-project",
            None,
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("name"), Value::str("Landing")),
            ]),
        ),
        post(
            "/api/main/methods/update-project-pin",
            None,
            Value::map([
                (Value::kw("team-id"), Value::Uuid(TEAM)),
                (Value::kw("id"), Value::Uuid(PROJECT)),
                (Value::kw("is-pinned"), Value::Bool(true)),
            ]),
        ),
        post(
            "/api/main/methods/rename-project",
            None,
            Value::map([
                (Value::kw("id"), Value::Uuid(PROJECT)),
                (Value::kw("name"), Value::str("Renamed")),
            ]),
        ),
        post(
            "/api/main/methods/delete-project",
            None,
            Value::map([(Value::kw("id"), Value::Uuid(PROJECT))]),
        ),
        get(
            &format!("/api/main/methods/get-project-files?project-id={PROJECT}"),
            None,
        ),
    ] {
        let response = send(&router, request).await;
        assert_eq!(response.status(), StatusCode::UNAUTHORIZED);
        assert_eq!(code(&body(response).await), Some("authentication-required"));
    }
}
