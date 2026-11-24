use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, TimeDelta, TimeZone, Utc};
use tokio::sync::watch;
use uuid::Uuid;
use worker::{
    decode_payload, encode_payload, BatchOutcome, ClaimedTask, Dispatcher, DispatcherConfig,
    QueueRef, Result, SubmitOptions, Task, TaskMessage, TaskQueue, TaskRepository, TaskStatus,
    WorkerError,
};

#[derive(Default)]
struct FakeRepository {
    state: Mutex<RepoState>,
}

#[derive(Default)]
struct RepoState {
    tasks: BTreeMap<Uuid, Task>,
    calls: Vec<String>,
}

impl FakeRepository {
    fn with_tasks(tasks: impl IntoIterator<Item = Task>) -> Self {
        Self {
            state: Mutex::new(RepoState {
                tasks: tasks.into_iter().map(|task| (task.id, task)).collect(),
                calls: Vec::new(),
            }),
        }
    }

    fn calls(&self) -> Vec<String> {
        self.lock().calls.clone()
    }

    fn task(&self, id: Uuid) -> Task {
        self.lock().tasks.get(&id).cloned().expect("task")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, RepoState> {
        self.state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl TaskRepository for FakeRepository {
    async fn select_next(
        &self,
        now: DateTime<Utc>,
        tenant: &str,
        limit: usize,
    ) -> Result<Vec<ClaimedTask>> {
        let mut state = self.lock();
        state.calls.push("select_next".into());
        let prefix = format!("{tenant}:");
        let mut tasks: Vec<_> = state
            .tasks
            .values()
            .filter(|task| {
                matches!(task.status, TaskStatus::New | TaskStatus::Retry)
                    && task.scheduled_at <= now
                    && task.queue.starts_with(&prefix)
            })
            .cloned()
            .collect();
        tasks.sort_by(|left, right| {
            right
                .priority
                .cmp(&left.priority)
                .then_with(|| left.scheduled_at.cmp(&right.scheduled_at))
        });
        Ok(tasks
            .into_iter()
            .take(limit)
            .map(|task| ClaimedTask {
                id: task.id,
                queue: task.queue,
                scheduled_at: task.scheduled_at,
            })
            .collect())
    }

    async fn mark_scheduled(&self, ids: &[Uuid]) -> Result<usize> {
        let mut state = self.lock();
        state.calls.push("mark_scheduled".into());
        let mut updated = 0;
        for id in ids {
            if let Some(task) = state.tasks.get_mut(id) {
                task.status = TaskStatus::Scheduled;
                updated += 1;
            }
        }
        Ok(updated)
    }

    async fn reschedule_lost(
        &self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>> {
        let mut state = self.lock();
        state.calls.push("reschedule_lost".into());
        let mut lost = Vec::new();
        for task in state.tasks.values_mut() {
            if task.status == TaskStatus::Scheduled && now - task.scheduled_at > max_age {
                task.reschedule_lost(now);
                lost.push(QueueRef {
                    id: task.id,
                    queue: task.queue.clone(),
                });
            }
        }
        Ok(lost)
    }

    async fn fail_orphans(&self, now: DateTime<Utc>, max_age: TimeDelta) -> Result<Vec<QueueRef>> {
        let mut state = self.lock();
        state.calls.push("fail_orphans".into());
        let mut orphans = Vec::new();
        for task in state.tasks.values_mut() {
            if task.status == TaskStatus::Running && now - task.modified_at > max_age {
                task.mark_orphan_failed(now);
                orphans.push(QueueRef {
                    id: task.id,
                    queue: task.queue.clone(),
                });
            }
        }
        Ok(orphans)
    }

    async fn get(&self, id: Uuid) -> Result<Option<Task>> {
        Ok(self.lock().tasks.get(&id).cloned())
    }

    async fn mark_running(&self, id: Uuid, now: DateTime<Utc>) -> Result<bool> {
        let mut state = self.lock();
        let Some(task) = state.tasks.get_mut(&id) else {
            return Ok(false);
        };
        task.status = TaskStatus::Running;
        task.modified_at = now;
        Ok(true)
    }

    async fn save(&self, task: &Task) -> Result<bool> {
        let mut state = self.lock();
        Ok(state.tasks.insert(task.id, task.clone()).is_some())
    }
}

#[derive(Default)]
struct FakeQueue {
    pushes: Mutex<Vec<(String, Vec<String>)>>,
}

impl FakeQueue {
    fn pushes(&self) -> Vec<(String, Vec<String>)> {
        self.pushes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

#[async_trait]
impl TaskQueue for FakeQueue {
    async fn push(&self, queue: &str, payloads: Vec<String>) -> Result<()> {
        self.pushes
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((queue.to_owned(), payloads));
        Ok(())
    }

    async fn pop(&self, _queue: &str, _timeout: Duration) -> Result<Option<String>> {
        Ok(None)
    }
}

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0)
        .single()
        .expect("valid instant")
}

fn task(id: u128, queue: &str) -> Task {
    Task::new(
        Uuid::from_u128(id),
        "acme",
        SubmitOptions::new("sendmail").queue(queue),
        now(),
    )
}

#[test]
fn payload_round_trips_uuid_and_scheduled_instant() {
    let item = TaskMessage {
        id: Uuid::from_u128(42),
        scheduled_at: now(),
    };

    let decoded = decode_payload(&encode_payload(&item)).expect("valid payload");

    assert_eq!(decoded, item);
}

#[test]
fn malformed_payload_is_a_structured_error() {
    let error = decode_payload(r#"["^ ","~:id","bad"]"#).expect_err("invalid payload");

    assert!(matches!(error, WorkerError::InvalidPayload(_)));
}

#[tokio::test]
async fn batch_groups_tasks_by_queue_and_marks_them_scheduled() {
    let first = task(1, "default");
    let second = task(2, "default");
    let third = task(3, "webhooks");
    let repository = Arc::new(FakeRepository::with_tasks([
        first.clone(),
        second.clone(),
        third.clone(),
    ]));
    let queue = Arc::new(FakeQueue::default());
    let dispatcher = Dispatcher::new(
        repository.clone(),
        queue.clone(),
        DispatcherConfig {
            tenant: "acme".into(),
            ..DispatcherConfig::default()
        },
    );

    let result = dispatcher.run_once(now()).await.expect("dispatch");

    assert_eq!(
        result,
        BatchOutcome::Published {
            batches: 2,
            tasks: 3
        }
    );
    assert_eq!(repository.task(first.id).status, TaskStatus::Scheduled);
    assert_eq!(repository.task(third.id).status, TaskStatus::Scheduled);
    assert_eq!(queue.pushes().len(), 2);
}

#[tokio::test]
async fn published_payload_keeps_the_database_scheduled_instant() {
    let task = task(1, "default");
    let repository = Arc::new(FakeRepository::with_tasks([task.clone()]));
    let queue = Arc::new(FakeQueue::default());
    let dispatcher = Dispatcher::new(
        repository,
        queue.clone(),
        DispatcherConfig {
            tenant: "acme".into(),
            ..DispatcherConfig::default()
        },
    );

    dispatcher.run_once(now()).await.expect("dispatch");

    let payload = &queue.pushes()[0].1[0];
    let decoded = decode_payload(payload).expect("payload");
    assert_eq!(decoded.id, task.id);
    assert_eq!(decoded.scheduled_at, task.scheduled_at);
}

#[tokio::test]
async fn no_due_tasks_wait_without_pushing_anything() {
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());
    let dispatcher = Dispatcher::new(
        repository,
        queue.clone(),
        DispatcherConfig {
            tenant: "acme".into(),
            ..DispatcherConfig::default()
        },
    );

    let result = dispatcher.run_once(now()).await.expect("dispatch");

    assert_eq!(result, BatchOutcome::Waited);
    assert!(queue.pushes().is_empty());
}

#[tokio::test]
async fn lost_and_orphan_cleanup_run_before_claiming() {
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());
    let dispatcher = Dispatcher::new(
        repository.clone(),
        queue,
        DispatcherConfig {
            tenant: "acme".into(),
            ..DispatcherConfig::default()
        },
    );

    dispatcher.run_once(now()).await.expect("dispatch");

    assert_eq!(
        repository.calls(),
        ["reschedule_lost", "fail_orphans", "select_next"]
    );
}

#[tokio::test]
async fn runner_queue_key_uses_the_penpot_prefix() {
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());
    let dispatcher = Dispatcher::new(
        repository,
        queue,
        DispatcherConfig {
            tenant: "acme".into(),
            ..DispatcherConfig::default()
        },
    );

    assert_eq!(
        dispatcher.queue_key("acme:webhooks"),
        "penpot.worker.queue:acme:webhooks"
    );
}

#[tokio::test]
async fn dispatcher_loop_exits_when_shutdown_is_already_requested() {
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());
    let dispatcher = Dispatcher::new(
        repository,
        queue,
        DispatcherConfig {
            tenant: "acme".into(),
            ..DispatcherConfig::default()
        },
    );
    let (sender, receiver) = watch::channel(true);

    dispatcher.run_loop(receiver).await.expect("loop exits");

    drop(sender);
}
