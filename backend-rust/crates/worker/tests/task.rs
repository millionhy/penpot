use std::time::Duration;

use chrono::{TimeDelta, TimeZone, Utc};
use transit::Map;
use uuid::Uuid;
use worker::{
    HandlerFailure, HandlerResult, SubmitOptions, Task, TaskStatus, DEFAULT_MAX_RETRIES,
    DEFAULT_PRIORITY, DEFAULT_QUEUE,
};

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0)
        .single()
        .expect("valid instant")
}

fn task(status: TaskStatus, retry_num: i16) -> Task {
    let mut task = Task::new(
        Uuid::from_u128(1),
        "acme",
        SubmitOptions::new("sendmail"),
        now(),
    );
    task.status = status;
    task.retry_num = retry_num;
    task
}

#[test]
fn submit_options_use_the_clojure_defaults() {
    let task = Task::new(
        Uuid::from_u128(7),
        "acme",
        SubmitOptions::new("sendmail"),
        now(),
    );

    assert_eq!(task.queue, "acme:default");
    assert_eq!(task.priority, DEFAULT_PRIORITY);
    assert_eq!(task.max_retries, DEFAULT_MAX_RETRIES);
    assert_eq!(task.retry_num, 0);
    assert_eq!(task.label, "");
    assert_eq!(task.status, TaskStatus::New);
    assert_eq!(task.scheduled_at, now());
}

#[test]
fn tenant_prefix_is_applied_to_every_queue() {
    let task = Task::new(
        Uuid::from_u128(7),
        "acme",
        SubmitOptions::new("run-webhook").queue("webhooks"),
        now(),
    );

    assert_eq!(task.queue, "acme:webhooks");
}

#[test]
fn submitted_delay_is_truncated_to_milliseconds() {
    let now = now() + TimeDelta::microseconds(987);
    let task = Task::new(
        Uuid::from_u128(7),
        "acme",
        SubmitOptions::new("sendmail").delay(Duration::from_millis(1500)),
        now,
    );

    assert_eq!(
        task.scheduled_at.timestamp_millis(),
        now.timestamp_millis() + 1500
    );
    assert_eq!(task.scheduled_at.timestamp_subsec_nanos() % 1_000_000, 0);
}

#[test]
fn completion_sets_the_terminal_fields_and_clears_the_error() {
    let mut task = task(TaskStatus::Running, 0);
    task.error = Some("old failure".into());
    let completed_at = now() + TimeDelta::seconds(2);

    task.apply_result(HandlerResult::Completed, completed_at);

    assert_eq!(task.status, TaskStatus::Completed);
    assert_eq!(task.completed_at, Some(completed_at));
    assert_eq!(task.modified_at, completed_at);
    assert_eq!(task.error, None);
}

#[test]
fn explicit_failure_stops_without_scheduling_a_retry() {
    let mut task = task(TaskStatus::Running, 0);

    task.apply_result(
        HandlerResult::Failed {
            error: "invalid payload".into(),
        },
        now(),
    );

    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(task.error.as_deref(), Some("invalid payload"));
    assert_eq!(task.scheduled_at, now());
}

#[test]
fn first_failure_retries_after_one_second() {
    let mut task = task(TaskStatus::Running, 0);

    task.apply_failure(&HandlerFailure::new("temporary"), now());

    assert_eq!(task.status, TaskStatus::Retry);
    assert_eq!(task.retry_num, 1);
    assert_eq!(task.scheduled_at, now() + TimeDelta::seconds(1));
    assert_eq!(task.error.as_deref(), Some("temporary"));
}

#[test]
fn retry_delay_doubles_with_the_new_retry_number() {
    let mut task = task(TaskStatus::Running, 2);
    let failure = HandlerFailure::new("temporary").with_delay(Duration::from_secs(2));

    task.apply_failure(&failure, now());

    assert_eq!(task.retry_num, 3);
    assert_eq!(task.scheduled_at, now() + TimeDelta::seconds(8));
}

#[test]
fn noop_retry_keeps_the_retry_number() {
    let mut task = task(TaskStatus::Running, 2);
    let failure = HandlerFailure::new("still busy")
        .with_delay(Duration::from_secs(2))
        .noop();

    task.apply_failure(&failure, now());

    assert_eq!(task.retry_num, 2);
    assert_eq!(task.scheduled_at, now() + TimeDelta::seconds(4));
}

#[test]
fn reaching_max_retries_marks_the_task_failed() {
    let mut task = task(TaskStatus::Running, DEFAULT_MAX_RETRIES);

    task.apply_failure(&HandlerFailure::new("last attempt"), now());

    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(task.error.as_deref(), Some("last attempt"));
}

#[test]
fn explicit_retry_from_a_handler_advances_the_retry_number() {
    let mut task = task(TaskStatus::Running, 0);

    task.apply_result(
        HandlerResult::Retry {
            error: "try later".into(),
            delay: Some(Duration::from_secs(5)),
            inc_by: 1,
        },
        now(),
    );

    assert_eq!(task.status, TaskStatus::Retry);
    assert_eq!(task.retry_num, 1);
    assert_eq!(task.scheduled_at, now() + TimeDelta::seconds(5));
}

#[test]
fn state_machine_accepts_the_dispatch_and_runner_paths() {
    for (from, to) in [
        (TaskStatus::New, TaskStatus::Scheduled),
        (TaskStatus::Scheduled, TaskStatus::Running),
        (TaskStatus::Scheduled, TaskStatus::New),
        (TaskStatus::Running, TaskStatus::Retry),
        (TaskStatus::Running, TaskStatus::Completed),
        (TaskStatus::Running, TaskStatus::Failed),
        (TaskStatus::Retry, TaskStatus::Scheduled),
    ] {
        assert!(from.can_transition_to(to), "{from:?} -> {to:?}");
    }
}

#[test]
fn terminal_states_do_not_transition() {
    assert!(!TaskStatus::Completed.can_transition_to(TaskStatus::Running));
    assert!(!TaskStatus::Failed.can_transition_to(TaskStatus::Scheduled));
}

#[test]
fn lost_scheduled_task_returns_to_new_at_the_observed_time() {
    let mut task = task(TaskStatus::Scheduled, 0);

    task.reschedule_lost(now() + TimeDelta::minutes(5));

    assert_eq!(task.status, TaskStatus::New);
    assert_eq!(task.scheduled_at, now() + TimeDelta::minutes(5));
}

#[test]
fn orphan_task_is_failed_with_the_clojure_error_text() {
    let mut task = task(TaskStatus::Running, 0);

    task.mark_orphan_failed(now() + TimeDelta::hours(24));

    assert_eq!(task.status, TaskStatus::Failed);
    assert_eq!(task.error.as_deref(), Some("orphan with running status"));
}

#[test]
fn status_strings_match_the_database_values() {
    assert_eq!(TaskStatus::New.as_str(), "new");
    assert_eq!(TaskStatus::Retry.as_str(), "retry");
    assert_eq!(TaskStatus::Scheduled.as_str(), "scheduled");
    assert_eq!(TaskStatus::Running.as_str(), "running");
    assert_eq!(TaskStatus::Completed.as_str(), "completed");
    assert_eq!(TaskStatus::Failed.as_str(), "failed");
}

#[test]
fn props_are_round_tripped_as_a_transit_map() {
    let props: Map = [(transit::Value::kw("id"), transit::Value::str("x"))]
        .into_iter()
        .collect();
    let task = Task::new(
        Uuid::from_u128(7),
        "acme",
        SubmitOptions::new("sendmail").props(props.clone()),
        now(),
    );

    let encoded = transit::encode(&task.props_value());
    let decoded = transit::decode(&encoded).expect("valid transit");

    assert_eq!(decoded.get_kw("id"), Some(&transit::Value::str("x")));
}

#[test]
fn default_queue_constant_is_default() {
    assert_eq!(DEFAULT_QUEUE, "default");
}
