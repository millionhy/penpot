//! Live checks against a migrated Penpot database.
//!
//! ```text
//! PENPOT_TEST_DATABASE_URL=postgres://penpot:penpot@localhost:5433/penpot \
//!   cargo test -p pg --test live -- --ignored
//! ```
//!
//! Both tests read a random UUID, so they never write.

use std::time::Duration;

use pg::{PgAccessTokenStore, PgSessionStore};
use rpc::auth::{AccessTokenStore, SessionStore};
use uuid::Uuid;

fn test_url() -> String {
    std::env::var("PENPOT_TEST_DATABASE_URL")
        .unwrap_or_else(|_| "postgres://penpot:penpot@127.0.0.1:5433/penpot".to_owned())
}

fn database() -> db::Database {
    let mut options = db::DbOptions::new(test_url());
    options.max_connections = 2;
    options.min_connections = 0;
    options.acquire_timeout = Duration::from_secs(5);
    db::Database::connect(options).expect("pool")
}

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn an_unknown_session_is_none() {
    let store = PgSessionStore::new(database());
    let session = store
        .read_session(Uuid::new_v4())
        .await
        .expect("read session");
    assert!(session.is_none());
    store.database().close().await;
}

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn an_unknown_access_token_is_none() {
    let store = PgAccessTokenStore::new(database());
    let token = store.read_token(Uuid::new_v4()).await.expect("read token");
    assert!(token.is_none());
    store.database().close().await;
}
