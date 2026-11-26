//! `login-with-password` and `get-profile` (M18).
//!
//! Ports the password half of `backend/src/app/rpc/commands/auth.clj` and the
//! read half of `backend/src/app/rpc/commands/profile.clj`, plus the write
//! side of `app.http.session` (session row, token claims, cookie).
//!
//! Not ported here: login lockout (`app.login-lockout`), invitation-token
//! handling, Nitrate licensing, and the admin flag's real source (`admins`
//! config is used, the admin-console service is not).

use std::collections::BTreeSet;
use std::sync::Arc;

use errors::Cause;
use session::{CookiePolicy, SessionClaims, SessionIdentity, Token};
use transit::{Map, Value};
use uuid::Uuid;

use crate::context::CommandContext;
use crate::params::{ParamKind, ParamSchema, ParamSpec};
use crate::registry::{Command, HandlerFuture, Registry};
use crate::response::CommandResult;

/// The `fullname` the anonymous profile carries.
pub const ANONYMOUS_FULLNAME: &str = "Anonymous User";

/// The zero uuid `get-profile` returns for an anonymous caller.
pub const ANONYMOUS_ID: Uuid = Uuid::nil();

/// The `password` sentinel for accounts without a local password.
const NO_PASSWORD: &str = "!";

/// One profile row, with the columns auth and `get-profile` read.
#[derive(Debug, Clone, PartialEq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the profile row carries independent Penpot flags"
)]
pub struct AuthProfile {
    pub id: Uuid,
    pub email: String,
    pub fullname: String,
    pub password_hash: String,
    pub is_active: bool,
    pub is_blocked: bool,
    pub is_demo: bool,
    pub is_muted: bool,
    pub photo_id: Option<Uuid>,
    pub lang: Option<String>,
    pub theme: Option<String>,
    pub auth_backend: Option<String>,
    pub default_project_id: Option<Uuid>,
    pub default_team_id: Option<Uuid>,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
    /// Transit-encoded `props` (`{"~:nudge": ...}`), already decoded.
    pub props: Value,
}

/// The `http_session_v2` fields a new session needs after the insert.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CreatedSession {
    pub id: Uuid,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// Reads `profile` rows for auth.
#[async_trait::async_trait]
pub trait ProfileStore: Send + Sync {
    /// The live profile with this email, already cleaned by the caller.
    ///
    /// # Errors
    ///
    /// Any database failure; it reaches the client as a 500.
    async fn find_by_email(&self, email: &str) -> Result<Option<AuthProfile>, Cause>;

    /// The profile with this id, or `None` when it does not exist.
    ///
    /// # Errors
    ///
    /// Any database failure; it reaches the client as a 500.
    async fn read(&self, id: Uuid) -> Result<Option<AuthProfile>, Cause>;
}

/// Inserts `http_session_v2` rows.
#[async_trait::async_trait]
pub trait SessionCreator: Send + Sync {
    /// Create a session for `profile_id`.
    ///
    /// # Errors
    ///
    /// Any database failure; it reaches the client as a 500.
    async fn create_session(
        &self,
        profile_id: Uuid,
        user_agent: Option<&str>,
    ) -> Result<CreatedSession, Cause>;
}

/// The [`Command`]s `login-with-password` and `get-profile` need.
#[derive(Clone)]
pub struct AuthCommands {
    pub profiles: Arc<dyn ProfileStore>,
    pub sessions: Arc<dyn SessionCreator>,
    pub token: Token,
    pub cookie: CookiePolicy,
    /// `admins` config: the emails `login-with-password` flags as admin.
    pub admins: BTreeSet<String>,
    /// `(or login-flag login-with-password-flag)` in `login-with-password`.
    pub login_enabled: bool,
}

impl AuthCommands {
    /// Add both commands to `registry`.
    pub fn register(&self, registry: &mut Registry) {
        let login = self.clone();
        registry.register(
            Command::new("login-with-password", move |ctx| login.login(ctx))
                .public()
                .params(login_params()),
        );

        let profile = self.clone();
        registry.register(
            Command::new("get-profile", move |ctx| profile.get_profile(ctx))
                .public()
                .params(ParamSchema::new([])),
        );
    }

    fn login(&self, ctx: CommandContext) -> HandlerFuture {
        let profiles = Arc::clone(&self.profiles);
        let sessions = Arc::clone(&self.sessions);
        let token = self.token.clone();
        let cookie = self.cookie.clone();
        let admins = self.admins.clone();
        let login_enabled = self.login_enabled;

        Box::pin(async move {
            if !login_enabled {
                return Err(cause_with_hint(
                    "restriction",
                    "login-disabled",
                    "login is disabled",
                ));
            }

            let email = clean_email(&string_param(&ctx, "email")?);
            let attempt = string_param(&ctx, "password")?;

            let Some(profile) = profiles.find_by_email(&email).await? else {
                return Err(wrong_credentials());
            };

            if !profile.is_active {
                return Err(wrong_credentials());
            }
            if profile.is_blocked {
                return Err(cause_with_hint(
                    "restriction",
                    "profile-blocked",
                    "profile is marked as blocked",
                ));
            }

            if profile.password_hash == NO_PASSWORD {
                return Err(cause(
                    "validation",
                    "account-without-password",
                    Some("the current account does not have password"),
                ));
            }

            let valid = match password::verify(&attempt, &profile.password_hash) {
                Ok(valid) => valid,
                Err(error) => {
                    tracing::warn!(
                        profile_id = %profile.id,
                        error = %error,
                        "stored password hash could not be checked"
                    );
                    false
                }
            };
            if !valid {
                return Err(wrong_credentials());
            }

            let user_agent = ctx
                .headers
                .get(axum::http::header::USER_AGENT)
                .and_then(|value| value.to_str().ok());
            let created = sessions.create_session(profile.id, user_agent).await?;

            let identity = SessionIdentity {
                id: created.id,
                profile_id: profile.id,
                created_at_ms: Some(created.created_at_ms),
                modified_at_ms: created.modified_at_ms,
                sso_provider_id: None,
                sso_session_id: None,
            };
            let claims = SessionClaims::for_session(&identity, cookie.absolute_max_age);
            let encoded = token
                .encode_at(&claims, created.modified_at_ms)
                .map_err(|_| internal("token-encoding"))?;
            let set_cookie = cookie
                .assign(&encoded, created.modified_at_ms)
                .to_header_value()
                .map_err(|_| internal("cookie-rendering"))?;

            let mut body = profile_map(&profile);
            body.insert(
                Value::kw("is-admin"),
                Value::Bool(admins.contains(&profile.email)),
            );

            Ok(CommandResult::ok(Value::Map(body)).with_header("set-cookie", set_cookie))
        })
    }

    fn get_profile(&self, ctx: CommandContext) -> HandlerFuture {
        let profiles = Arc::clone(&self.profiles);

        Box::pin(async move {
            let Some(profile_id) = ctx.profile_id() else {
                return Ok(anonymous_profile());
            };

            let Some(profile) = profiles.read(profile_id).await? else {
                return Ok(anonymous_profile());
            };

            let mut body = profile_map(&profile);
            body.insert(Value::kw("subscription"), Value::Nil);
            Ok(CommandResult::ok(Value::Map(body)))
        })
    }
}

fn login_params() -> ParamSchema {
    ParamSchema::new([
        ParamSpec::required("email", ParamKind::Email),
        ParamSpec::required("password", ParamKind::Str),
        // Accepted for parity; invitation acceptance is not part of M18.
        ParamSpec::optional("invitation-token", ParamKind::Str),
    ])
}

fn string_param(ctx: &CommandContext, name: &str) -> Result<String, Cause> {
    ctx.param(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| internal("params"))
}

/// `app.rpc.commands.profile/clean-email`.
#[must_use]
pub fn clean_email(email: &str) -> String {
    let email = email.to_lowercase();
    let email = email.strip_prefix("mailto:").unwrap_or(&email).to_owned();
    email.trim_matches(['<', '>']).to_owned()
}

/// The profile map `get-profile` returns for an unauthenticated caller.
#[must_use]
pub fn anonymous_profile() -> CommandResult {
    CommandResult::ok(Value::map([
        (Value::kw("id"), Value::Uuid(ANONYMOUS_ID)),
        (Value::kw("fullname"), Value::str(ANONYMOUS_FULLNAME)),
        (Value::kw("subscription"), Value::Nil),
    ]))
}

/// `strip-private-attrs` plus `filter-props`: no password, no deleted-at, and
/// no namespaced prop keys.
fn profile_map(profile: &AuthProfile) -> Map {
    let mut body = Map::new();
    body.insert(Value::kw("id"), Value::Uuid(profile.id));
    body.insert(Value::kw("email"), Value::str(profile.email.clone()));
    body.insert(Value::kw("fullname"), Value::str(profile.fullname.clone()));
    body.insert(Value::kw("is-active"), Value::Bool(profile.is_active));
    body.insert(Value::kw("is-blocked"), Value::Bool(profile.is_blocked));
    body.insert(Value::kw("is-demo"), Value::Bool(profile.is_demo));
    body.insert(Value::kw("is-muted"), Value::Bool(profile.is_muted));
    body.insert(
        Value::kw("created-at"),
        Value::Instant(profile.created_at_ms),
    );
    body.insert(
        Value::kw("modified-at"),
        Value::Instant(profile.modified_at_ms),
    );
    body.insert(
        Value::kw("lang"),
        profile.lang.clone().map_or(Value::Nil, Value::str),
    );
    body.insert(
        Value::kw("theme"),
        profile.theme.clone().map_or(Value::Nil, Value::str),
    );
    body.insert(
        Value::kw("auth-backend"),
        profile.auth_backend.clone().map_or(Value::Nil, Value::str),
    );
    body.insert(
        Value::kw("photo-id"),
        profile.photo_id.map_or(Value::Nil, Value::Uuid),
    );
    body.insert(
        Value::kw("default-project-id"),
        profile.default_project_id.map_or(Value::Nil, Value::Uuid),
    );
    body.insert(
        Value::kw("default-team-id"),
        profile.default_team_id.map_or(Value::Nil, Value::Uuid),
    );
    body.insert(Value::kw("props"), filter_props(&profile.props));
    body
}

/// Keep only unqualified keys, as `filter-props` does.
fn filter_props(props: &Value) -> Value {
    let Some(map) = props.as_map() else {
        return Value::map(Vec::<(Value, Value)>::new());
    };
    Value::map(
        map.iter()
            .filter(|(key, _)| match key {
                Value::Keyword(name) => !name.contains('/'),
                _ => false,
            })
            .map(|(key, value)| (key.clone(), value.clone())),
    )
}

fn wrong_credentials() -> Cause {
    cause("validation", "wrong-credentials", None)
}

fn cause(kind: &str, code: &str, hint: Option<&str>) -> Cause {
    let mut entries = vec![
        (Value::kw("type"), Value::kw(kind)),
        (Value::kw("code"), Value::kw(code)),
    ];
    if let Some(hint) = hint {
        entries.push((Value::kw("hint"), Value::str(hint)));
    }
    Cause::error(Value::map(entries))
}

fn cause_with_hint(kind: &str, code: &str, hint: &str) -> Cause {
    cause(kind, code, Some(hint))
}

fn internal(code: &str) -> Cause {
    cause("internal", code, None)
}
