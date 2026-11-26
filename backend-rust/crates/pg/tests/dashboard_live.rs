//! Live dashboard reads for M19.
//!
//! ```text
//! PENPOT_TEST_DATABASE_URL=postgres://penpot:penpot@127.0.0.1:5432/penpot_rust_live \
//!   cargo test -p pg --test dashboard_live -- --ignored
//! ```

use std::time::Duration;

use pg::PgDashboardStore;
use rpc::commands::dashboard::{DashboardStore, FontScope};
use transit::Value;
use uuid::Uuid;

const LIVE_HASH: &str = "argon2id$5b06591ef885ecba2b3a2e5b5653d388$32768$3$2$\
bbd9bcf8c5476f9118fce959b73fe089a2e0d9c6e7582dff520119f17aadc973";

struct Fixture {
    profile_id: Uuid,
    team_id: Uuid,
    project_id: Uuid,
    file_id: Uuid,
    font_variant_id: Uuid,
    font_id: Uuid,
    thread_id: Uuid,
    page_id: Uuid,
    email: String,
}

impl Fixture {
    fn new() -> Self {
        let profile_id = Uuid::new_v4();
        Self {
            profile_id,
            team_id: Uuid::new_v4(),
            project_id: Uuid::new_v4(),
            file_id: Uuid::new_v4(),
            font_variant_id: Uuid::new_v4(),
            font_id: Uuid::new_v4(),
            thread_id: Uuid::new_v4(),
            page_id: Uuid::new_v4(),
            email: format!("rust-dashboard-{profile_id}@example.com"),
        }
    }
}

fn database() -> db::Database {
    let url = std::env::var("PENPOT_TEST_DATABASE_URL").expect("PENPOT_TEST_DATABASE_URL");
    let mut options = db::DbOptions::new(url);
    options.max_connections = 2;
    options.min_connections = 0;
    options.acquire_timeout = Duration::from_secs(5);
    db::Database::connect(options).expect("pool")
}

async fn seed_profile(pool: &db::PgPool, fixture: &Fixture) {
    let props = transit::encode_verbose(&Value::map([(Value::kw("nudge"), Value::str("visible"))]));
    sqlx::query(
        "INSERT INTO profile (id, email, fullname, password, is_active, props) \
         VALUES ($1, $2, 'Rust Dashboard', $3, true, $4::jsonb)",
    )
    .bind(fixture.profile_id)
    .bind(&fixture.email)
    .bind(LIVE_HASH)
    .bind(&props)
    .execute(pool)
    .await
    .expect("insert profile");
}

async fn seed_team_and_project(pool: &db::PgPool, fixture: &Fixture) {
    sqlx::query("INSERT INTO team (id, name) VALUES ($1, 'Rust Team')")
        .bind(fixture.team_id)
        .execute(pool)
        .await
        .expect("insert team");
    sqlx::query(
        "INSERT INTO team_profile_rel (team_id, profile_id, is_owner, is_admin, can_edit) \
         VALUES ($1, $2, true, false, false)",
    )
    .bind(fixture.team_id)
    .bind(fixture.profile_id)
    .execute(pool)
    .await
    .expect("insert team relation");
    sqlx::query(
        "INSERT INTO project (id, team_id, name, is_default) VALUES ($1, $2, 'Drafts', true)",
    )
    .bind(fixture.project_id)
    .bind(fixture.team_id)
    .execute(pool)
    .await
    .expect("insert project");
    sqlx::query(
        "INSERT INTO file (id, project_id, name, revn, vern, is_shared) \
         VALUES ($1, $2, 'Landing', 4, 2, true)",
    )
    .bind(fixture.file_id)
    .bind(fixture.project_id)
    .execute(pool)
    .await
    .expect("insert file");
}

async fn seed_font_and_thread(pool: &db::PgPool, fixture: &Fixture) {
    sqlx::query(
        "INSERT INTO team_font_variant \
             (id, team_id, profile_id, font_id, font_family, font_weight, font_style, variant_name) \
         VALUES ($1, $2, $3, $4, 'Inter', 700, 'normal', 'Bold')",
    )
    .bind(fixture.font_variant_id)
    .bind(fixture.team_id)
    .bind(fixture.profile_id)
    .bind(fixture.font_id)
    .execute(pool)
    .await
    .expect("insert font variant");

    let participants = transit::encode(&Value::Set(
        [Value::Uuid(fixture.profile_id)].into_iter().collect(),
    ));
    sqlx::query(
        "INSERT INTO comment_thread \
             (id, file_id, owner_id, page_id, participants, seqn, position) \
         VALUES ($1, $2, $3, $4, $5::jsonb, 1, point(10.5, -20.25))",
    )
    .bind(fixture.thread_id)
    .bind(fixture.file_id)
    .bind(fixture.profile_id)
    .bind(fixture.page_id)
    .bind(&participants)
    .execute(pool)
    .await
    .expect("insert comment thread");
    sqlx::query(
        "INSERT INTO comment (id, thread_id, owner_id, content) \
         VALUES ($1, $2, $3, 'Please review')",
    )
    .bind(Uuid::new_v4())
    .bind(fixture.thread_id)
    .bind(fixture.profile_id)
    .execute(pool)
    .await
    .expect("insert comment");
}

async fn set_notifications(pool: &db::PgPool, fixture: &Fixture, value: &str) {
    let props = transit::encode_verbose(&Value::map([(
        Value::kw("notifications"),
        Value::map([(Value::kw("dashboard-comments"), Value::kw(value))]),
    )]));
    sqlx::query("UPDATE profile SET props = $2::jsonb WHERE id = $1")
        .bind(fixture.profile_id)
        .bind(&props)
        .execute(pool)
        .await
        .expect("update props");
}

/// Penpot guards these rows with a deletion-protection trigger; the cleanup
/// turns it off for this transaction only.
async fn cleanup(database: &db::Database, fixture: &Fixture) {
    let mut tx = database.begin().await.expect("cleanup transaction");
    sqlx::query("SET LOCAL rules.deletion_protection TO off")
        .execute(&mut *tx)
        .await
        .expect("disable deletion protection");
    for (table, column, id) in [
        ("comment", "thread_id", fixture.thread_id),
        ("comment_thread", "id", fixture.thread_id),
        ("team_font_variant", "id", fixture.font_variant_id),
        ("file", "id", fixture.file_id),
        ("project", "id", fixture.project_id),
        ("team_profile_rel", "team_id", fixture.team_id),
        ("team", "id", fixture.team_id),
        ("profile", "id", fixture.profile_id),
    ] {
        let sql = format!("DELETE FROM {table} WHERE {column} = $1");
        sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(id)
            .execute(&mut *tx)
            .await
            .unwrap_or_else(|error| panic!("delete {table}: {error}"));
    }
    tx.commit().await.expect("commit cleanup");
}

fn assert_close(actual: f64, expected: f64) {
    assert!(
        (actual - expected).abs() < 1e-9,
        "{actual} is not {expected}"
    );
}

#[tokio::test]
#[ignore = "needs disposable PostgreSQL; set PENPOT_TEST_DATABASE_URL"]
async fn dashboard_reads_round_trip_against_postgres() {
    let database = database();
    let pool = database.pool();
    let fixture = Fixture::new();
    seed_profile(pool, &fixture).await;
    seed_team_and_project(pool, &fixture).await;
    seed_font_and_thread(pool, &fixture).await;

    let store = PgDashboardStore::new(database.clone());

    let files = store
        .recent_files(fixture.profile_id, fixture.team_id)
        .await
        .expect("recent files")
        .expect("team is readable");
    assert_eq!(files.len(), 1);
    assert_eq!(files[0].id, fixture.file_id);
    assert_eq!(files[0].revn, 4);
    assert_eq!(files[0].vern, 2);
    assert!(files[0].is_shared);
    assert!(files[0].thumbnail_id.is_none());
    assert_eq!(files[0].row_num, 1);

    for scope in [
        FontScope::Team(fixture.team_id),
        FontScope::Project(fixture.project_id),
        FontScope::File(fixture.file_id),
    ] {
        let variants = store
            .font_variants(fixture.profile_id, scope)
            .await
            .expect("font variants")
            .expect("scope is readable");
        assert_eq!(variants.len(), 1, "{scope:?}");
        assert_eq!(variants[0].id, fixture.font_variant_id);
        assert_eq!(variants[0].font_family, "Inter");
        assert_eq!(variants[0].font_weight, 700);
        assert_eq!(variants[0].variant_name.as_deref(), Some("Bold"));
    }
    assert_eq!(
        store
            .font_variants(fixture.profile_id, FontScope::Team(Uuid::new_v4()))
            .await
            .expect("foreign team"),
        None
    );

    let members = store
        .team_members(fixture.profile_id, fixture.team_id)
        .await
        .expect("team members")
        .expect("team is readable");
    assert_eq!(members.len(), 1);
    assert_eq!(members[0].id, fixture.profile_id);
    assert_eq!(members[0].email, fixture.email);
    assert!(members[0].is_owner);
    assert!(members[0].is_active);

    let threads = store
        .unread_comment_threads(fixture.profile_id, fixture.team_id)
        .await
        .expect("unread threads")
        .expect("team is readable");
    assert_eq!(threads.len(), 1);
    assert_eq!(threads[0].id, fixture.thread_id);
    assert_eq!(threads[0].content, "Please review");
    assert_close(threads[0].position_x, 10.5);
    assert_close(threads[0].position_y, -20.25);
    assert_eq!(threads[0].count_comments, 1);
    assert_eq!(threads[0].count_unread_comments, 1);
    assert_eq!(
        threads[0].participants.items().map(|items| items.len()),
        Some(1)
    );
    assert!(threads[0].mentions.is_empty());

    // `:partial` keeps the caller's own thread; `:none` turns the feed off.
    set_notifications(pool, &fixture, "partial").await;
    assert_eq!(
        store
            .unread_comment_threads(fixture.profile_id, fixture.team_id)
            .await
            .expect("partial threads")
            .map(|rows| rows.len()),
        Some(1)
    );
    set_notifications(pool, &fixture, "none").await;
    assert_eq!(
        store
            .unread_comment_threads(fixture.profile_id, fixture.team_id)
            .await
            .expect("disabled threads")
            .map(|rows| rows.len()),
        Some(0)
    );

    cleanup(&database, &fixture).await;
    database.close().await;
}
