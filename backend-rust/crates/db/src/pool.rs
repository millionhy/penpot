//! The lazy PostgreSQL pool.

use std::time::Duration;

use errors::Cause;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};

use crate::{DbError, DbOptions, Postgres, Transaction};

/// A PostgreSQL pool with the session settings `app.db/initsql` applies.
#[derive(Debug, Clone)]
pub struct Database {
    pool: sqlx::PgPool,
    read_only: bool,
}

impl Database {
    /// Build a lazy pool.
    ///
    /// No socket opens here; the first query does. That keeps startup cheap
    /// and matches Hikari's `initializationFailTimeout = -1`, so a service
    /// can boot while the database is still starting.
    ///
    /// # Errors
    ///
    /// Returns [`DbError::Configuration`] for invalid sizes, or
    /// [`DbError::Sqlx`] when the URI cannot be parsed.
    pub fn connect(options: DbOptions) -> Result<Self, DbError> {
        options.validate()?;

        let connect_options: PgConnectOptions = options.uri.parse().map_err(DbError::from)?;
        let connect_options = connect_options.application_name("penpot-rust");

        let setup = session_setup(&options);
        let pool = PgPoolOptions::new()
            .max_connections(options.max_connections)
            .min_connections(options.min_connections)
            .acquire_timeout(options.acquire_timeout)
            .idle_timeout(options.idle_timeout)
            .max_lifetime(options.max_lifetime)
            .after_connect(move |connection, _meta| {
                // The statement is built from integer timeouts and a fixed
                // tail, so no caller input reaches it. AssertSqlSafe states
                // that audit instead of bypassing the check with `unsafe`.
                let setup = sqlx::AssertSqlSafe(setup.clone());
                Box::pin(async move {
                    sqlx::raw_sql(setup).execute(connection).await?;
                    Ok(())
                })
            })
            .connect_lazy_with(connect_options);

        Ok(Self {
            pool,
            read_only: options.read_only,
        })
    }

    /// The underlying pool, for callers that need `sqlx` directly.
    #[must_use]
    pub fn pool(&self) -> &sqlx::PgPool {
        &self.pool
    }

    /// Whether this pool marks every session read-only.
    #[must_use]
    pub fn is_read_only(&self) -> bool {
        self.read_only
    }

    /// Open a transaction. Dropping it without `commit` rolls back, as
    /// `next.jdbc` does.
    ///
    /// # Errors
    ///
    /// A pool acquire or connect failure, mapped to the `errors` crate.
    pub async fn begin(&self) -> Result<Transaction<'static, Postgres>, Cause> {
        self.pool
            .begin()
            .await
            .map_err(|error| DbError::from(error).into())
    }

    /// Close the pool and wait for checked-out connections to return.
    pub async fn close(&self) {
        self.pool.close().await;
    }
}

/// `app.db/initsql`, plus the read-only session flag when configured.
fn session_setup(options: &DbOptions) -> String {
    let statement = millis(options.statement_timeout);
    let idle = millis(options.idle_in_transaction_timeout);
    let read_only = if options.read_only {
        " SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"
    } else {
        ""
    };
    format!(
        "SET statement_timeout = {statement};\n\
         SET idle_in_transaction_session_timeout = {idle};{read_only}"
    )
}

fn millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn setup_matches_the_clojure_session() {
        let options = DbOptions::new("postgres://localhost/penpot");
        assert_eq!(
            session_setup(&options),
            "SET statement_timeout = 300000;\n\
             SET idle_in_transaction_session_timeout = 300000;"
        );

        let mut options = DbOptions::new("postgres://localhost/penpot");
        options.read_only = true;
        assert!(session_setup(&options)
            .ends_with(" SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY;"));
    }

    #[tokio::test]
    async fn a_pool_is_built_without_opening_a_socket() {
        let database = Database::connect(DbOptions::new(
            "postgres://penpot:penpot@127.0.0.1:9/penpot",
        ))
        .expect("lazy pool");
        assert!(!database.is_read_only());
        assert_eq!(database.pool().size(), 0);
    }

    #[test]
    fn a_malformed_uri_is_rejected() {
        let error = Database::connect(DbOptions::new("not a database url")).unwrap_err();
        assert!(matches!(error, DbError::Sqlx(_)));
    }

    #[tokio::test]
    async fn the_read_only_flag_is_kept() {
        let mut options = DbOptions::new("postgres://localhost/penpot");
        options.read_only = true;
        let database = Database::connect(options).expect("lazy pool");
        assert!(database.is_read_only());
    }
}
