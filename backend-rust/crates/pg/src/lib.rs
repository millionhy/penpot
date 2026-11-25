//! PostgreSQL adapters for the traits defined by the domain crates.
//!
//! This crate is the only place that turns SQL rows into `rpc::auth`,
//! `worker` or `storage` records. Keeping it separate means the router, the
//! auth logic, the worker and the storage service stay free of sqlx, while the
//! live queries still compile against the same `sqlx` version the rest of the
//! backend uses.
//!
//! The auth queries are the ones in `app.http.session` and
//! `app.http.access-token`, restated with runtime `sqlx::query` calls:
//!
//! * sessions select `id`, `profile_id` and `modified_at` in milliseconds,
//!   and skip rows whose profile was deleted (`profile_id IS NULL`);
//! * access tokens select `profile_id`, `perms` and `expires_at`, and skip
//!   expired rows like `sql:get-token-data`.
//!
//! The worker adapter covers the `task` table: dispatcher claim and recovery,
//! runner fetch and state writes, and the submit insert. `task.props` is
//! verbose Transit stored as JSONB, so the adapter decodes it with the same
//! reader the RPC layer uses.
//!
//! The storage adapter covers `storage_object`: live reads, the dual-encoding
//! deduplication probe, the write-ahead insert, promotion, touch and soft
//! delete. New rows use verbose Transit metadata by default.
//!
//! Live tests are `#[ignore]`d and need `PENPOT_TEST_DATABASE_URL` plus a
//! migrated schema. The task and storage tests insert one row under a random
//! id and remove it again.

use std::collections::BTreeSet;

use errors::Cause;
use rpc::auth::{AccessTokenRecord, AccessTokenStore, SessionRecord, SessionStore};
use sqlx::Row;
use uuid::Uuid;

mod storage;
mod task;

pub use storage::PgStorageRepository;
pub use task::PgTaskRepository;

/// `http_session_v2` reader.
#[derive(Debug, Clone)]
pub struct PgSessionStore {
    database: db::Database,
}

impl PgSessionStore {
    #[must_use]
    pub fn new(database: db::Database) -> Self {
        Self { database }
    }

    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }
}

#[async_trait::async_trait]
impl SessionStore for PgSessionStore {
    async fn read_session(&self, id: Uuid) -> Result<Option<SessionRecord>, Cause> {
        let row = sqlx::query(
            "SELECT id, profile_id, \
                    (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms \
               FROM http_session_v2 \
              WHERE id = $1 \
                AND profile_id IS NOT NULL",
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await
        .map_err(db::map_sqlx)?;

        let Some(row) = row else {
            return Ok(None);
        };
        Ok(Some(SessionRecord {
            id: row.try_get("id").map_err(db::map_sqlx)?,
            profile_id: row.try_get("profile_id").map_err(db::map_sqlx)?,
            modified_at_ms: row.try_get("modified_at_ms").map_err(db::map_sqlx)?,
        }))
    }
}

/// `access_token` reader.
#[derive(Debug, Clone)]
pub struct PgAccessTokenStore {
    database: db::Database,
}

impl PgAccessTokenStore {
    #[must_use]
    pub fn new(database: db::Database) -> Self {
        Self { database }
    }

    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }
}

#[async_trait::async_trait]
impl AccessTokenStore for PgAccessTokenStore {
    async fn read_token(&self, id: Uuid) -> Result<Option<AccessTokenRecord>, Cause> {
        let row = sqlx::query(
            "SELECT profile_id, perms, \
                    (extract(epoch FROM expires_at) * 1000)::bigint AS expires_at_ms \
               FROM access_token \
              WHERE id = $1 \
                AND (expires_at IS NULL OR expires_at > now())",
        )
        .bind(id)
        .fetch_optional(self.database.pool())
        .await
        .map_err(db::map_sqlx)?;

        let Some(row) = row else {
            return Ok(None);
        };
        let perms: Option<Vec<String>> = row.try_get("perms").map_err(db::map_sqlx)?;
        Ok(Some(AccessTokenRecord {
            profile_id: row.try_get("profile_id").map_err(db::map_sqlx)?,
            perms: perms
                .unwrap_or_default()
                .into_iter()
                .collect::<BTreeSet<_>>(),
            expires_at_ms: row.try_get("expires_at_ms").map_err(db::map_sqlx)?,
        }))
    }
}
