use std::{fs, path::PathBuf};

use worker::{
    validate_penpot_entries, PENPOT_TASK_NAMES, SQL_CLEAN_ORPHAN, SQL_OBJECTS_GC_UPLOAD_SESSIONS,
    SQL_RESCHEDULE_LOST, SQL_SELECT_NEXT_TASKS, SQL_WEBHOOK_ERROR, TASK_OBJECTS_GC,
    TASK_RUN_WEBHOOK, TASK_SENDMAIL, TASK_SESSION_GC, TASK_TASKS_GC,
};

fn main_source() -> String {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../backend/src/app/main.clj");
    fs::read_to_string(path).expect("read backend main.clj")
}

#[test]
fn every_backend_cron_literal_has_a_rust_parser_case() {
    let source = main_source();
    let entries = validate_penpot_entries().expect("all Penpot cron entries parse");

    for entry in entries {
        assert!(
            source.contains(entry.as_str()),
            "cron literal missing from main.clj: {entry}"
        );
    }
}

#[test]
fn the_five_offline_task_names_match_the_backend_registry() {
    let source = main_source();

    for name in PENPOT_TASK_NAMES {
        assert!(
            source.contains(&format!(":{name}")),
            "task missing from main.clj registry: {name}"
        );
    }
    assert_eq!(
        PENPOT_TASK_NAMES,
        [
            TASK_SENDMAIL,
            TASK_OBJECTS_GC,
            TASK_TASKS_GC,
            TASK_SESSION_GC,
            TASK_RUN_WEBHOOK
        ]
    );
}

#[test]
fn task_status_values_match_the_runner_schema() {
    let source = fs::read_to_string(
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../../backend/src/app/worker/runner.clj"),
    )
    .expect("read worker runner");

    for status in [
        "new",
        "retry",
        "scheduled",
        "running",
        "completed",
        "failed",
    ] {
        assert!(source.contains(&format!("\"{status}\"")), "{status}");
    }
}

#[test]
fn dispatcher_sql_keeps_the_clojure_locking_and_recovery_contract() {
    for fragment in ["FOR UPDATE", "SKIP LOCKED", "ORDER BY t.priority DESC"] {
        assert!(
            SQL_SELECT_NEXT_TASKS.contains(fragment),
            "missing {fragment} in due-task query"
        );
    }
    assert!(SQL_RESCHEDULE_LOST.contains("'5 min'::interval"));
    assert!(SQL_RESCHEDULE_LOST.contains("status = 'scheduled'"));
    assert!(SQL_CLEAN_ORPHAN.contains("'24 hour'::interval"));
    assert!(SQL_CLEAN_ORPHAN.contains("status = 'running'"));
    assert!(SQL_CLEAN_ORPHAN.contains("orphan with running status"));
}

#[test]
fn maintenance_sql_keeps_the_clojure_row_scope() {
    assert!(SQL_OBJECTS_GC_UPLOAD_SESSIONS.contains("FOR UPDATE OF us"));
    assert!(SQL_OBJECTS_GC_UPLOAD_SESSIONS.contains("SKIP LOCKED"));
    assert!(SQL_WEBHOOK_ERROR.contains("error_count=error_count+1"));
}
