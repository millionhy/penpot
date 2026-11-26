//! `profile` reads and `http_session_v2` writes for M18.
//!
//! The row shape follows `backend/src/app/rpc/commands/profile.clj` (columns
//! `get-profile` returns after `strip-private-attrs`) plus the `password`
//! column only login reads. Timestamps leave as Unix milliseconds, the way
//! `::ct/inst` values reach transit.

use async_trait::async_trait;
use db::Database;
use errors::Cause;
use rpc::commands::auth::{AuthProfile, CreatedSession, ProfileStore, SessionCreator};
use sqlx::Row;
use transit::Value;
use uuid::Uuid;

const SQL_SELECT_PROFILE: &str = "SELECT id, email, fullname, password, \
        is_active, is_blocked, is_demo, is_muted, photo_id, lang, theme, auth_backend, \
        default_project_id, default_team_id, props::text AS props, \
        (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms \
   FROM profile";

/// `profile` reader for login and `get-profile`.
#[derive(Debug, Clone)]
pub struct PgProfileStore {
    database: Database,
}

impl PgProfileStore {
    #[must_use]
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    #[must_use]
    pub fn database(&self) -> &Database {
        &self.database
    }
}

#[async_trait]
impl ProfileStore for PgProfileStore {
    async fn find_by_email(&self, email: &str) -> Result<Option<AuthProfile>, Cause> {
        let sql = format!("{SQL_SELECT_PROFILE} WHERE email = $1 AND deleted_at IS NULL");
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(email)
            .fetch_optional(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        row.map(row_to_profile).transpose()
    }

    async fn read(&self, id: Uuid) -> Result<Option<AuthProfile>, Cause> {
        let sql = format!("{SQL_SELECT_PROFILE} WHERE id = $1 AND deleted_at IS NULL");
        let row = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .fetch_optional(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        row.map(row_to_profile).transpose()
    }
}

/// `http_session_v2` writer. The id is generated here because the column has
/// no default (`database-manager/create-session` uses `uuid/next`).
#[derive(Debug, Clone)]
pub struct PgSessionCreator {
    database: Database,
}

impl PgSessionCreator {
    #[must_use]
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    #[must_use]
    pub fn database(&self) -> &Database {
        &self.database
    }
}

#[async_trait]
impl SessionCreator for PgSessionCreator {
    async fn create_session(
        &self,
        profile_id: Uuid,
        user_agent: Option<&str>,
    ) -> Result<CreatedSession, Cause> {
        let row = sqlx::query(
            "INSERT INTO http_session_v2 (id, profile_id, user_agent) \
             VALUES ($1, $2, $3) \
             RETURNING id, \
                (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
                (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms",
        )
        .bind(Uuid::new_v4())
        .bind(profile_id)
        .bind(user_agent)
        .fetch_one(self.database.pool())
        .await
        .map_err(db::map_sqlx)?;

        Ok(CreatedSession {
            id: row.try_get("id").map_err(db::map_sqlx)?,
            created_at_ms: row.try_get("created_at_ms").map_err(db::map_sqlx)?,
            modified_at_ms: row.try_get("modified_at_ms").map_err(db::map_sqlx)?,
        })
    }
}

fn row_to_profile(row: sqlx::postgres::PgRow) -> Result<AuthProfile, Cause> {
    let props: Option<String> = row.try_get("props").map_err(db::map_sqlx)?;
    Ok(AuthProfile {
        id: row.try_get("id").map_err(db::map_sqlx)?,
        email: row.try_get("email").map_err(db::map_sqlx)?,
        fullname: row.try_get("fullname").map_err(db::map_sqlx)?,
        password_hash: row.try_get("password").map_err(db::map_sqlx)?,
        is_active: row.try_get("is_active").map_err(db::map_sqlx)?,
        is_blocked: row.try_get("is_blocked").map_err(db::map_sqlx)?,
        is_demo: row.try_get("is_demo").map_err(db::map_sqlx)?,
        is_muted: row.try_get("is_muted").map_err(db::map_sqlx)?,
        photo_id: row.try_get("photo_id").map_err(db::map_sqlx)?,
        lang: row.try_get("lang").map_err(db::map_sqlx)?,
        theme: row.try_get("theme").map_err(db::map_sqlx)?,
        auth_backend: row.try_get("auth_backend").map_err(db::map_sqlx)?,
        default_project_id: row.try_get("default_project_id").map_err(db::map_sqlx)?,
        default_team_id: row.try_get("default_team_id").map_err(db::map_sqlx)?,
        created_at_ms: row.try_get("created_at_ms").map_err(db::map_sqlx)?,
        modified_at_ms: row.try_get("modified_at_ms").map_err(db::map_sqlx)?,
        props: decode_props(props),
    })
}

/// `props` is a Transit JSON document in JSONB; an unreadable value becomes an
/// empty map so a malformed preference cannot block login.
fn decode_props(text: Option<String>) -> Value {
    let Some(text) = text else {
        return Value::map(Vec::<(Value, Value)>::new());
    };
    match transit::decode(&text) {
        Ok(Value::Map(map)) => Value::Map(map),
        Ok(_) => Value::map(Vec::<(Value, Value)>::new()),
        Err(error) => {
            tracing::warn!(error = %error, "profile props are not readable transit");
            Value::map(Vec::<(Value, Value)>::new())
        }
    }
}
