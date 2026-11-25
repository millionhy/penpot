//! Live checks against a migrated Penpot database.
//!
//! ```text
//! PENPOT_TEST_DATABASE_URL=postgres://penpot:penpot@localhost:5433/penpot \
//!   cargo test -p pg --test live -- --ignored
//! ```
//!
//! The auth tests read a random UUID and never write. The task test inserts
//! one row under a random tenant and removes it again.

use std::time::Duration;

use chrono::Utc;
use pg::{PgAccessTokenStore, PgSessionStore, PgTaskRepository};
use rpc::auth::{AccessTokenStore, SessionStore};
use transit::{Map, Value};
use uuid::Uuid;
use worker::{HandlerResult, SubmitOptions, Task, TaskRepository, TaskStatus};

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

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn a_task_round_trips_through_claim_and_completion() {
    let repository = PgTaskRepository::new(database());
    let now = Utc::now();
    let mut props = Map::new();
    props.insert(
        Value::Keyword("email".into()),
        Value::Str("live@example.com".into()),
    );
    let tenant = format!("rust-live-{}", Uuid::new_v4());
    let task = Task::new(
        Uuid::new_v4(),
        &tenant,
        SubmitOptions::new("sendmail").props(props).label("live"),
        now,
    );

    repository.insert(&task).await.expect("insert task");

    let loaded = repository
        .get(task.id)
        .await
        .expect("read task")
        .expect("task row");
    assert_eq!(loaded.id, task.id);
    assert_eq!(loaded.name, "sendmail");
    assert_eq!(loaded.label, "live");
    assert_eq!(loaded.props, task.props);
    assert_eq!(loaded.status, TaskStatus::New);
    assert_eq!(loaded.scheduled_at, task.scheduled_at);

    let mut batch = repository.begin_batch().await.expect("begin batch");
    let claimed = batch
        .select_next(Utc::now(), &tenant, 10)
        .await
        .expect("select");
    assert_eq!(claimed.len(), 1);
    assert_eq!(claimed[0].id, task.id);
    assert_eq!(
        batch
            .mark_scheduled(&[task.id])
            .await
            .expect("mark scheduled"),
        1
    );
    batch.commit().await.expect("commit batch");

    assert!(repository
        .mark_running(task.id, Utc::now())
        .await
        .expect("mark running"));

    let mut finished = repository
        .get(task.id)
        .await
        .expect("reload")
        .expect("task row");
    finished.apply_result(HandlerResult::Completed, Utc::now());
    assert!(repository.save(&finished).await.expect("save"));

    let completed = repository
        .get(task.id)
        .await
        .expect("reload")
        .expect("task row");
    assert_eq!(completed.status, TaskStatus::Completed);
    assert!(completed.completed_at.is_some());

    sqlx::query("DELETE FROM task WHERE id = $1")
        .bind(task.id)
        .execute(repository.database().pool())
        .await
        .expect("delete task");
    repository.database().close().await;
}
