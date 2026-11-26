//! Live checks against a migrated Penpot database.
//!
//! ```text
//! PENPOT_TEST_DATABASE_URL=postgres://penpot:penpot@localhost:5433/penpot \
//!   cargo test -p pg --test live -- --ignored
//! ```
//!
//! The auth tests read a random UUID and never write. The task test inserts
//! one row under a random tenant and removes it again; the storage tests do
//! the same with a random `storage_object` id. The GC test writes a pending
//! row plus one blob under a temporary directory.

use std::{sync::Arc, time::Duration};

use chrono::Utc;
use pg::{
    PgAccessTokenStore, PgSessionGc, PgSessionStore, PgStorageGcRepository, PgStorageRepository,
    PgTaskRepository, PgTasksGc,
};
use rpc::auth::{AccessTokenStore, SessionStore};
use storage::{
    Bucket, FsStore, ObjectStatus, StorageBackend, StorageGc, StorageMetadata, StorageObject,
    StorageRepository,
};
use transit::{Map, Value};
use uuid::Uuid;
use worker::{HandlerResult, SessionGc, SubmitOptions, Task, TaskRepository, TaskStatus, TasksGc};

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

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn a_storage_object_round_trips_and_soft_deletes() {
    let repository = PgStorageRepository::new(database());
    let hash = format!("blake2b:live-{}", Uuid::new_v4());
    let metadata = StorageMetadata::new(Bucket::FileMediaObject, "image/png").with_hash(&hash);
    let object =
        StorageObject::new_pending(Uuid::new_v4(), 42, Utc::now(), StorageBackend::Fs, metadata);

    repository.insert(&object).await.expect("insert object");
    assert!(repository
        .get_valid(object.id)
        .await
        .expect("pending is invisible")
        .is_none());

    assert!(repository.promote(object.id).await.expect("promote"));
    let valid = repository
        .get_valid(object.id)
        .await
        .expect("read object")
        .expect("valid row");
    assert_eq!(valid.id, object.id);
    assert_eq!(valid.size, 42);
    assert_eq!(valid.backend, StorageBackend::Fs);
    assert_eq!(valid.metadata, object.metadata);
    assert_eq!(valid.status, ObjectStatus::Valid);
    assert!(valid.expired_at.is_none());

    let found = repository
        .find_dedup(StorageBackend::Fs, "file-media-object", &hash)
        .await
        .expect("dedup probe")
        .expect("dedup row");
    assert_eq!(found.id, object.id);

    let touched = Utc::now();
    assert!(repository
        .set_touched(object.id, Some(touched))
        .await
        .expect("touch"));
    let touched_row = repository
        .get_valid(object.id)
        .await
        .expect("read object")
        .expect("valid row");
    assert_eq!(
        touched_row
            .touched_at
            .map(|instant| instant.timestamp_millis()),
        Some(touched.timestamp_millis())
    );

    assert!(repository
        .soft_delete(object.id, Utc::now())
        .await
        .expect("soft delete"));
    assert!(repository
        .get_valid(object.id)
        .await
        .expect("deleted is invisible")
        .is_none());
    assert!(!repository
        .soft_delete(object.id, Utc::now())
        .await
        .expect("second delete"));
    assert!(repository
        .find_dedup(StorageBackend::Fs, "file-media-object", &hash)
        .await
        .expect("dedup probe")
        .is_none());

    sqlx::query("DELETE FROM storage_object WHERE id = $1")
        .bind(object.id)
        .execute(repository.database().pool())
        .await
        .expect("delete object");
    repository.database().close().await;
}

#[tokio::test]
#[ignore = "needs live PostgreSQL and a writable temp directory; set PENPOT_TEST_DATABASE_URL"]
async fn a_pending_object_is_reclaimed_with_its_blob() {
    let database = database();
    let directory = std::env::temp_dir().join(format!("penpot-gc-{}", Uuid::new_v4()));
    std::fs::create_dir_all(&directory).expect("temp directory");
    let store = Arc::new(FsStore::new(&directory));

    let id = Uuid::new_v4();
    let metadata = StorageMetadata::new(Bucket::Tempfile, "text/plain");
    let created_at = Utc::now() - chrono::Duration::hours(25);
    let object = StorageObject::new_pending(id, 6, created_at, StorageBackend::Fs, metadata);
    PgStorageRepository::new(database.clone())
        .insert(&object)
        .await
        .expect("insert pending");
    std::fs::write(store.object_path(id), b"orphan").expect("blob");

    let gc = StorageGc::new(PgStorageGcRepository::new(database.clone()), store.clone());
    let report = gc.run_pending().await.expect("pending pass");
    assert!(report.pending_removed >= 1);
    assert!(!store.object_path(id).exists());

    let row: Option<Uuid> = sqlx::query_scalar("SELECT id FROM storage_object WHERE id = $1")
        .bind(id)
        .fetch_optional(database.pool())
        .await
        .expect("row probe");
    assert!(row.is_none());

    std::fs::remove_dir_all(&directory).expect("cleanup directory");
    database.close().await;
}

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn tasks_gc_deletes_old_rows_and_honours_rollback() {
    let database = database();
    let repository = PgTaskRepository::new(database.clone());
    let now = Utc::now();
    let tenant = format!("rust-gc-{}", Uuid::new_v4());
    let mut old = Task::new(Uuid::new_v4(), &tenant, SubmitOptions::new("tasks-gc"), now);
    old.scheduled_at = now - chrono::Duration::days(4000);
    let fresh = Task::new(Uuid::new_v4(), &tenant, SubmitOptions::new("tasks-gc"), now);
    repository.insert(&old).await.expect("insert old task");
    repository.insert(&fresh).await.expect("insert fresh task");

    let service = PgTasksGc::new(database.clone(), Duration::from_hours(24 * 7));
    let min_age = Duration::from_hours(24 * 3650);
    assert!(service.run(min_age, true).await.expect("dry run") >= 1);
    assert!(repository
        .get(old.id)
        .await
        .expect("read old task")
        .is_some());

    assert!(service.run(min_age, false).await.expect("delete pass") >= 1);
    assert!(repository
        .get(old.id)
        .await
        .expect("read old task")
        .is_none());
    assert!(repository
        .get(fresh.id)
        .await
        .expect("read fresh task")
        .is_some());

    sqlx::query("DELETE FROM task WHERE id = $1")
        .bind(fresh.id)
        .execute(database.pool())
        .await
        .expect("cleanup task");
    database.close().await;
}

#[tokio::test]
#[ignore = "needs live PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn session_gc_deletes_expired_rows() {
    let database = database();
    let now = Utc::now();
    let old_id = Uuid::new_v4();
    let fresh_id = Uuid::new_v4();
    let old_at = now - chrono::Duration::days(800);

    for (id, created_at) in [(old_id, old_at), (fresh_id, now)] {
        sqlx::query(
            "INSERT INTO http_session_v2 (id, created_at, modified_at, user_agent) \
             VALUES ($1, \
                     to_timestamp($2::bigint::double precision / 1000.0), \
                     to_timestamp($3::bigint::double precision / 1000.0), \
                     'rust-live')",
        )
        .bind(id)
        .bind(created_at.timestamp_millis())
        .bind(created_at.timestamp_millis())
        .execute(database.pool())
        .await
        .expect("insert session");
    }

    let service = PgSessionGc::new(
        database.clone(),
        Duration::from_hours(24 * 365),
        Duration::from_hours(24 * 730),
    );
    assert!(service.run().await.expect("session pass") >= 1);

    let remaining: Vec<Uuid> =
        sqlx::query_scalar("SELECT id FROM http_session_v2 WHERE id = ANY($1::uuid[]) ORDER BY id")
            .bind(&[old_id, fresh_id][..])
            .fetch_all(database.pool())
            .await
            .expect("read sessions");
    assert_eq!(remaining, vec![fresh_id]);

    sqlx::query("DELETE FROM http_session_v2 WHERE id = $1")
        .bind(fresh_id)
        .execute(database.pool())
        .await
        .expect("cleanup session");
    database.close().await;
}
