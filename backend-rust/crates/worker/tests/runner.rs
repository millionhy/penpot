use std::{
    collections::{BTreeMap, VecDeque},
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};

use async_trait::async_trait;
use chrono::{DateTime, TimeDelta, TimeZone, Utc};
use tokio::sync::watch;
use uuid::Uuid;
use worker::{
    encode_payload, ClaimedTask, HandlerFailure, HandlerResult, ProcessOutcome,
    Result as WorkerResult, Runner, RunnerConfig, SubmitOptions, Task, TaskHandler, TaskMessage,
    TaskQueue, TaskRegistry, TaskRepository, TaskStatus,
};

#[derive(Default)]
struct FakeRepository {
    tasks: Mutex<BTreeMap<Uuid, Task>>,
}

impl FakeRepository {
    fn with_task(task: Task) -> Self {
        Self {
            tasks: Mutex::new([(task.id, task)].into_iter().collect()),
        }
    }

    fn task(&self, id: Uuid) -> Task {
        self.lock().get(&id).cloned().expect("task")
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<Uuid, Task>> {
        self.tasks
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl TaskRepository for FakeRepository {
    async fn select_next(
        &self,
        _now: DateTime<Utc>,
        _tenant: &str,
        _limit: usize,
    ) -> WorkerResult<Vec<ClaimedTask>> {
        Ok(Vec::new())
    }

    async fn mark_scheduled(&self, _ids: &[Uuid]) -> WorkerResult<usize> {
        Ok(0)
    }

    async fn reschedule_lost(
        &self,
        _now: DateTime<Utc>,
        _max_age: TimeDelta,
    ) -> WorkerResult<Vec<worker::QueueRef>> {
        Ok(Vec::new())
    }

    async fn fail_orphans(
        &self,
        _now: DateTime<Utc>,
        _max_age: TimeDelta,
    ) -> WorkerResult<Vec<worker::QueueRef>> {
        Ok(Vec::new())
    }

    async fn get(&self, id: Uuid) -> WorkerResult<Option<Task>> {
        Ok(self.lock().get(&id).cloned())
    }

    async fn mark_running(&self, id: Uuid, now: DateTime<Utc>) -> WorkerResult<bool> {
        let mut tasks = self.lock();
        let Some(task) = tasks.get_mut(&id) else {
            return Ok(false);
        };
        task.status = TaskStatus::Running;
        task.modified_at = now;
        Ok(true)
    }

    async fn save(&self, task: &Task) -> WorkerResult<bool> {
        Ok(self.lock().insert(task.id, task.clone()).is_some())
    }
}

#[derive(Default)]
struct FakeQueue {
    payloads: Mutex<VecDeque<String>>,
}

impl FakeQueue {
    fn with_payload(payload: String) -> Self {
        Self {
            payloads: Mutex::new(VecDeque::from([payload])),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, VecDeque<String>> {
        self.payloads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl TaskQueue for FakeQueue {
    async fn push(&self, _queue: &str, payloads: Vec<String>) -> WorkerResult<()> {
        self.lock().extend(payloads);
        Ok(())
    }

    async fn pop(&self, _queue: &str, _timeout: Duration) -> WorkerResult<Option<String>> {
        Ok(self.lock().pop_front())
    }
}

struct StaticHandler {
    result: Mutex<std::result::Result<HandlerResult, HandlerFailure>>,
    calls: AtomicUsize,
}

impl StaticHandler {
    fn new(result: std::result::Result<HandlerResult, HandlerFailure>) -> Arc<Self> {
        Arc::new(Self {
            result: Mutex::new(result),
            calls: AtomicUsize::new(0),
        })
    }

    fn calls(&self) -> usize {
        self.calls.load(Ordering::SeqCst)
    }
}

#[async_trait]
impl TaskHandler for StaticHandler {
    async fn handle(&self, _task: &Task) -> std::result::Result<HandlerResult, HandlerFailure> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        self.result
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

fn now() -> DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0)
        .single()
        .expect("valid instant")
}

fn task() -> Task {
    let mut task = Task::new(
        Uuid::from_u128(9),
        "acme",
        SubmitOptions::new("sendmail"),
        now(),
    );
    task.status = TaskStatus::Scheduled;
    task
}

fn payload(task: &Task) -> String {
    encode_payload(&TaskMessage {
        id: task.id,
        scheduled_at: task.scheduled_at,
    })
}

fn runner(
    repository: Arc<FakeRepository>,
    queue: Arc<FakeQueue>,
    registry: TaskRegistry,
) -> Runner<FakeRepository, FakeQueue> {
    Runner::new(
        repository,
        queue,
        registry,
        RunnerConfig {
            queue: "acme:default".into(),
            id: "test/0".into(),
            pop_timeout: Duration::from_millis(10),
            error_backoff: Duration::from_millis(10),
        },
    )
}

#[tokio::test]
async fn completed_handler_persists_completed_status() {
    let task = task();
    let repository = Arc::new(FakeRepository::with_task(task.clone()));
    let queue = Arc::new(FakeQueue::default());
    let handler = StaticHandler::new(Ok(HandlerResult::Completed));
    let mut registry = TaskRegistry::new();
    registry.register_shared("sendmail", handler.clone());

    let outcome = runner(repository.clone(), queue, registry)
        .process_payload_at(&payload(&task), now())
        .await
        .expect("process task");

    assert_eq!(outcome, ProcessOutcome::Completed);
    assert_eq!(repository.task(task.id).status, TaskStatus::Completed);
    assert_eq!(handler.calls(), 1);
}

#[tokio::test]
async fn handler_failure_persists_a_retry_schedule() {
    let task = task();
    let repository = Arc::new(FakeRepository::with_task(task.clone()));
    let queue = Arc::new(FakeQueue::default());
    let handler = StaticHandler::new(Err(HandlerFailure::new("temporary")));
    let mut registry = TaskRegistry::new();
    registry.register_shared("sendmail", handler);

    let outcome = runner(repository.clone(), queue, registry)
        .process_payload_at(&payload(&task), now())
        .await
        .expect("process task");

    let saved = repository.task(task.id);
    assert_eq!(outcome, ProcessOutcome::Retried);
    assert_eq!(saved.status, TaskStatus::Retry);
    assert_eq!(saved.retry_num, 1);
    assert_eq!(saved.scheduled_at, now() + TimeDelta::seconds(1));
}

#[tokio::test]
async fn missing_handler_completes_the_task_like_the_clojure_runner() {
    let task = task();
    let repository = Arc::new(FakeRepository::with_task(task.clone()));
    let queue = Arc::new(FakeQueue::default());

    let outcome = runner(repository.clone(), queue, TaskRegistry::new())
        .process_payload_at(&payload(&task), now())
        .await
        .expect("process task");

    assert_eq!(outcome, ProcessOutcome::Completed);
    assert_eq!(repository.task(task.id).status, TaskStatus::Completed);
}

#[tokio::test]
async fn rescheduled_task_is_skipped_before_marking_running() {
    let task = task();
    let repository = Arc::new(FakeRepository::with_task(task.clone()));
    let queue = Arc::new(FakeQueue::default());
    let handler = StaticHandler::new(Ok(HandlerResult::Completed));
    let mut registry = TaskRegistry::new();
    registry.register_shared("sendmail", handler.clone());
    let stale_payload = encode_payload(&TaskMessage {
        id: task.id,
        scheduled_at: task.scheduled_at + TimeDelta::milliseconds(1),
    });

    let outcome = runner(repository.clone(), queue, registry)
        .process_payload_at(&stale_payload, now())
        .await
        .expect("process task");

    assert_eq!(outcome, ProcessOutcome::Skipped);
    assert_eq!(repository.task(task.id).status, TaskStatus::Scheduled);
    assert_eq!(handler.calls(), 0);
}

#[tokio::test]
async fn missing_database_row_is_ignored() {
    let task = task();
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());

    let outcome = runner(repository, queue, TaskRegistry::new())
        .process_payload_at(&payload(&task), now())
        .await
        .expect("process task");

    assert_eq!(outcome, ProcessOutcome::Ignored);
}

#[tokio::test]
async fn explicit_retry_result_uses_the_requested_delay() {
    let task = task();
    let repository = Arc::new(FakeRepository::with_task(task.clone()));
    let queue = Arc::new(FakeQueue::default());
    let handler = StaticHandler::new(Ok(HandlerResult::Retry {
        error: "later".into(),
        delay: Some(Duration::from_secs(5)),
        inc_by: 1,
    }));
    let mut registry = TaskRegistry::new();
    registry.register_shared("sendmail", handler);

    runner(repository.clone(), queue, registry)
        .process_payload_at(&payload(&task), now())
        .await
        .expect("process task");

    let saved = repository.task(task.id);
    assert_eq!(saved.status, TaskStatus::Retry);
    assert_eq!(saved.scheduled_at, now() + TimeDelta::seconds(5));
}

#[tokio::test]
async fn run_once_returns_none_when_the_queue_times_out() {
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());

    let outcome = runner(repository, queue, TaskRegistry::new())
        .run_once()
        .await
        .expect("run once");

    assert_eq!(outcome, None);
}

#[tokio::test]
async fn run_once_processes_a_queued_payload() {
    let task = task();
    let repository = Arc::new(FakeRepository::with_task(task.clone()));
    let queue = Arc::new(FakeQueue::with_payload(payload(&task)));
    let mut registry = TaskRegistry::new();
    registry.register_shared("sendmail", StaticHandler::new(Ok(HandlerResult::Completed)));

    let outcome = runner(repository, queue, registry)
        .run_once()
        .await
        .expect("run once");

    assert_eq!(outcome, Some(ProcessOutcome::Completed));
}

#[tokio::test]
async fn runner_loop_exits_when_shutdown_is_already_requested() {
    let repository = Arc::new(FakeRepository::default());
    let queue = Arc::new(FakeQueue::default());
    let runner = runner(repository, queue, TaskRegistry::new());
    let (sender, receiver) = watch::channel(true);

    runner.run_loop(receiver).await.expect("loop exits");

    drop(sender);
}
