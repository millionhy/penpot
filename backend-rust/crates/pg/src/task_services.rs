//! PostgreSQL adapters for the `tasks-gc` and `session-gc` worker services.
//!
//! The queries mirror `app.tasks.tasks-gc` and the session GC block in
//! `app.http.session`. Both run inside a transaction; `tasks-gc` supports the
//! `rollback?` task prop, which executes the delete and then rolls it back.

use std::time::Duration;

use async_trait::async_trait;
use chrono::{TimeDelta, Utc};
use worker::{ServiceError, SessionGc, TasksGc};

/// Delete old task rows.
#[derive(Debug, Clone)]
pub struct PgTasksGc {
    database: db::Database,
    default_min_age: Duration,
}

impl PgTasksGc {
    /// Build the service with an explicit default minimum age.
    #[must_use]
    pub fn new(database: db::Database, default_min_age: Duration) -> Self {
        Self {
            database,
            default_min_age,
        }
    }

    /// Build the service with the backend's seven-day deletion delay.
    #[must_use]
    pub fn with_default_delay(database: db::Database) -> Self {
        Self::new(database, Duration::from_hours(24 * 7))
    }

    /// The wrapped database handle.
    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }
}

#[async_trait]
impl TasksGc for PgTasksGc {
    fn default_min_age(&self) -> Duration {
        self.default_min_age
    }

    async fn run(
        &self,
        min_age: Duration,
        rollback: bool,
    ) -> std::result::Result<u64, ServiceError> {
        let interval = TimeDelta::from_std(min_age)
            .map_err(|_| ServiceError::new("min-age does not fit in an interval"))?;
        let mut tx = self
            .database
            .begin()
            .await
            .map_err(|cause| ServiceError::new(format!("{cause:?}")))?;
        let result = sqlx::query(worker::SQL_TASKS_GC)
            .bind(crate::task::interval(interval))
            .execute(&mut *tx)
            .await
            .map_err(|error| ServiceError::new(error.to_string()))?;
        if rollback {
            tx.rollback()
                .await
                .map_err(|error| ServiceError::new(error.to_string()))?;
        } else {
            tx.commit()
                .await
                .map_err(|error| ServiceError::new(error.to_string()))?;
        }
        Ok(result.rows_affected())
    }
}

/// Delete idle and absolutely expired HTTP sessions.
#[derive(Debug, Clone)]
pub struct PgSessionGc {
    database: db::Database,
    max_age: Duration,
    absolute_max_age: Duration,
}

impl PgSessionGc {
    /// Build the service.
    ///
    /// `max_age` is the idle timeout; `absolute_max_age` counts from
    /// `created_at` and must be greater than or equal to `max_age`.
    #[must_use]
    pub fn new(database: db::Database, max_age: Duration, absolute_max_age: Duration) -> Self {
        Self {
            database,
            max_age,
            absolute_max_age,
        }
    }

    /// The wrapped database handle.
    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }
}

const SQL_DELETE_EXPIRED_SESSIONS: &str = "DELETE FROM http_session_v2 \
    WHERE modified_at < to_timestamp($1::bigint::double precision / 1000.0) \
       OR created_at  < to_timestamp($2::bigint::double precision / 1000.0)";

#[async_trait]
impl SessionGc for PgSessionGc {
    async fn run(&self) -> std::result::Result<u64, ServiceError> {
        if self.max_age > self.absolute_max_age {
            return Err(ServiceError::new(
                "absolute session max-age must be greater than or equal to idle max-age",
            ));
        }
        let now = Utc::now();
        let idle = threshold(now, self.max_age)?;
        let absolute = threshold(now, self.absolute_max_age)?;
        let mut tx = self
            .database
            .begin()
            .await
            .map_err(|cause| ServiceError::new(format!("{cause:?}")))?;
        let result = sqlx::query(SQL_DELETE_EXPIRED_SESSIONS)
            .bind(idle.timestamp_millis())
            .bind(absolute.timestamp_millis())
            .execute(&mut *tx)
            .await
            .map_err(|error| ServiceError::new(error.to_string()))?;
        tx.commit()
            .await
            .map_err(|error| ServiceError::new(error.to_string()))?;
        Ok(result.rows_affected())
    }
}

fn threshold(
    now: chrono::DateTime<Utc>,
    age: Duration,
) -> std::result::Result<chrono::DateTime<Utc>, ServiceError> {
    let age = TimeDelta::from_std(age)
        .map_err(|_| ServiceError::new("session max-age does not fit in an interval"))?;
    Ok(now - age)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn database() -> db::Database {
        db::Database::connect(db::DbOptions::new(
            "postgres://penpot:penpot@127.0.0.1:9/penpot",
        ))
        .expect("lazy pool")
    }

    #[tokio::test]
    async fn default_min_age_is_the_configured_delay() {
        let service = PgTasksGc::new(database(), Duration::from_hours(48));
        assert_eq!(service.default_min_age(), Duration::from_hours(48));
        assert_eq!(
            PgTasksGc::with_default_delay(database()).default_min_age(),
            Duration::from_hours(24 * 7)
        );
    }

    #[tokio::test]
    async fn absolute_age_below_idle_age_is_rejected_before_connecting() {
        let service = PgSessionGc::new(
            database(),
            Duration::from_hours(24 * 30),
            Duration::from_hours(24 * 7),
        );
        let error = service.run().await.expect_err("invalid thresholds");
        assert!(error.message().contains("absolute session max-age"));
    }
}
