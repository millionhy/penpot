//! Live PostgreSQL checks. Ignored unless a database is available.
//!
//! Unlock:
//!
//! ```text
//! PENPOT_TEST_DATABASE_URL=postgres://penpot:penpot@localhost:5433/penpot \
//!   cargo test -p db --test live -- --ignored
//! ```

use std::time::Duration;

use db::{Database, DbOptions};

fn test_url() -> String {
    std::env::var("PENPOT_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://penpot:penpot@127.0.0.1:5433/penpot".to_owned())
}

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn connects_and_applies_the_session_timeouts() {
    let mut options = DbOptions::new(test_url());
    options.max_connections = 2;
    options.min_connections = 0;
    options.acquire_timeout = Duration::from_secs(5);
    let database = Database::connect(options).expect("pool");

    let value: (i32,) = sqlx::query_as("SELECT 1")
        .fetch_one(database.pool())
        .await
        .expect("select 1");
    assert_eq!(value.0, 1);

    // `initsql` sets 300000 ms; PostgreSQL renders it as 5min.
    let (statement_timeout,): (String,) = sqlx::query_as("SHOW statement_timeout")
        .fetch_one(database.pool())
        .await
        .expect("show statement_timeout");
    assert_eq!(statement_timeout, "5min");

    database.close().await;
}

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn a_read_only_pool_refuses_writes() {
    let mut options = DbOptions::new(test_url());
    options.max_connections = 1;
    options.min_connections = 0;
    options.read_only = true;
    let database = Database::connect(options).expect("pool");

    let result = sqlx::query("CREATE TEMP TABLE penpot_write_probe (id int)")
        .execute(database.pool())
        .await;
    assert!(result.is_err(), "read-only session allowed a write");

    database.close().await;
}
