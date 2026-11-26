//! Live profile lookup and session insert for the M18 login slice.
//!
//! ```text
//! PENPOT_TEST_DATABASE_URL=postgres://penpot:penpot@127.0.0.1:5432/penpot_rust_live \
//!   cargo test -p pg --test auth_live -- --ignored
//! ```

use std::time::Duration;

use pg::{PgProfileStore, PgSessionCreator};
use rpc::commands::auth::{ProfileStore, SessionCreator};
use sqlx::Row;
use transit::Value;
use uuid::Uuid;

const LIVE_HASH: &str = "argon2id$5b06591ef885ecba2b3a2e5b5653d388$32768$3$2$\
bbd9bcf8c5476f9118fce959b73fe089a2e0d9c6e7582dff520119f17aadc973";

fn database() -> db::Database {
    let url = std::env::var("PENPOT_TEST_DATABASE_URL").expect("PENPOT_TEST_DATABASE_URL");
    let mut options = db::DbOptions::new(url);
    options.max_connections = 2;
    options.min_connections = 0;
    options.acquire_timeout = Duration::from_secs(5);
    db::Database::connect(options).expect("pool")
}

#[tokio::test]
#[ignore = "needs disposable PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn a_profile_and_http_session_round_trip() {
    let database = database();
    let id = Uuid::new_v4();
    let email = format!("rust-auth-{id}@example.com");
    let props = transit::encode_verbose(&Value::map([(Value::kw("nudge"), Value::str("visible"))]));

    sqlx::query(
        "INSERT INTO profile (id, email, fullname, password, is_active, props) \
         VALUES ($1, $2, $3, $4, true, $5::jsonb)",
    )
    .bind(id)
    .bind(&email)
    .bind("Rust Auth")
    .bind(LIVE_HASH)
    .bind(props)
    .execute(database.pool())
    .await
    .expect("insert profile");

    let profiles = PgProfileStore::new(database.clone());
    let found = profiles
        .find_by_email(&email)
        .await
        .expect("find profile")
        .expect("profile");
    assert_eq!(found.id, id);
    assert_eq!(found.email, email);
    assert_eq!(found.fullname, "Rust Auth");
    assert_eq!(found.password_hash, LIVE_HASH);
    assert!(found.is_active);
    assert!(password::verify("Penpot-test-123!", &found.password_hash).expect("password"));
    assert_eq!(
        found.props.get_kw("nudge").and_then(Value::as_str),
        Some("visible")
    );

    assert_eq!(profiles.read(id).await.expect("read profile"), Some(found));

    let created = PgSessionCreator::new(database.clone())
        .create_session(id, Some("backend-rust live test"))
        .await
        .expect("create session");
    let row = sqlx::query("SELECT profile_id, user_agent FROM http_session_v2 WHERE id = $1")
        .bind(created.id)
        .fetch_one(database.pool())
        .await
        .expect("session row");
    assert_eq!(row.get::<Uuid, _>("profile_id"), id);
    assert_eq!(
        row.get::<Option<String>, _>("user_agent").as_deref(),
        Some("backend-rust live test")
    );

    // Penpot guards profile rows with a deletion-protection trigger; the
    // cleanup turns it off for this transaction only.
    let mut tx = database.begin().await.expect("cleanup transaction");
    sqlx::query("SET LOCAL rules.deletion_protection TO off")
        .execute(&mut *tx)
        .await
        .expect("disable deletion protection");
    sqlx::query("DELETE FROM http_session_v2 WHERE id = $1")
        .bind(created.id)
        .execute(&mut *tx)
        .await
        .expect("delete session");
    sqlx::query("DELETE FROM profile WHERE id = $1")
        .bind(id)
        .execute(&mut *tx)
        .await
        .expect("delete profile");
    tx.commit().await.expect("commit cleanup");
    database.close().await;
}
