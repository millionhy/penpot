use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use transit::{Map, Value};
use uuid::Uuid;
use worker::{
    penpot_registry, HandlerResult, Mailer, ObjectsGc, PenpotTaskServices, ServiceError, SessionGc,
    SubmitOptions, Task, TasksGc, WebhookRunner, TASK_OBJECTS_GC, TASK_RUN_WEBHOOK, TASK_SENDMAIL,
    TASK_SESSION_GC, TASK_TASKS_GC,
};

#[derive(Default)]
struct FakeMailer {
    emails: Mutex<Vec<Map>>,
}

#[async_trait]
impl Mailer for FakeMailer {
    async fn send(&self, email: &Map) -> std::result::Result<(), ServiceError> {
        self.emails
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(email.clone());
        Ok(())
    }
}

#[derive(Default)]
struct FakeObjectsGc {
    calls: Mutex<Vec<Map>>,
}

#[async_trait]
impl ObjectsGc for FakeObjectsGc {
    async fn run(&self, props: &Map) -> std::result::Result<u64, ServiceError> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(props.clone());
        Ok(12)
    }
}

#[derive(Default)]
struct FakeTasksGc {
    calls: Mutex<Vec<(Duration, bool)>>,
}

#[async_trait]
impl TasksGc for FakeTasksGc {
    fn default_min_age(&self) -> Duration {
        Duration::from_hours(168)
    }

    async fn run(
        &self,
        min_age: Duration,
        rollback: bool,
    ) -> std::result::Result<u64, ServiceError> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((min_age, rollback));
        Ok(4)
    }
}

#[derive(Default)]
struct FakeSessionGc {
    calls: Mutex<usize>,
}

#[async_trait]
impl SessionGc for FakeSessionGc {
    async fn run(&self) -> std::result::Result<u64, ServiceError> {
        *self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
        Ok(3)
    }
}

#[derive(Default)]
struct FakeWebhookRunner {
    calls: Mutex<Vec<(Map, Map)>>,
}

#[async_trait]
impl WebhookRunner for FakeWebhookRunner {
    async fn run(&self, event: &Map, config: &Map) -> std::result::Result<(), ServiceError> {
        self.calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push((event.clone(), config.clone()));
        Ok(())
    }
}

struct Services {
    mailer: Arc<FakeMailer>,
    objects_gc: Arc<FakeObjectsGc>,
    tasks_gc: Arc<FakeTasksGc>,
    session_gc: Arc<FakeSessionGc>,
    webhook: Arc<FakeWebhookRunner>,
}

impl Services {
    fn new() -> Self {
        Self {
            mailer: Arc::new(FakeMailer::default()),
            objects_gc: Arc::new(FakeObjectsGc::default()),
            tasks_gc: Arc::new(FakeTasksGc::default()),
            session_gc: Arc::new(FakeSessionGc::default()),
            webhook: Arc::new(FakeWebhookRunner::default()),
        }
    }

    fn bundle(&self) -> PenpotTaskServices {
        PenpotTaskServices {
            sendmail: self.mailer.clone(),
            objects_gc: self.objects_gc.clone(),
            tasks_gc: self.tasks_gc.clone(),
            session_gc: self.session_gc.clone(),
            webhook: self.webhook.clone(),
        }
    }
}

fn now() -> chrono::DateTime<Utc> {
    Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0)
        .single()
        .expect("valid instant")
}

fn map(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Map {
    entries
        .into_iter()
        .map(|(key, value)| (Value::kw(key), value))
        .collect()
}

fn task(name: &str, props: Map) -> Task {
    Task::new(
        Uuid::from_u128(5),
        "acme",
        SubmitOptions::new(name).props(props),
        now(),
    )
}

async fn invoke(
    registry: &worker::TaskRegistry,
    name: &str,
    task: &Task,
) -> std::result::Result<HandlerResult, worker::HandlerFailure> {
    registry
        .get(name)
        .expect("registered handler")
        .handle(task)
        .await
}

#[test]
fn penpot_registry_contains_exactly_the_five_offline_tasks() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());

    assert_eq!(
        registry.names(),
        [
            TASK_OBJECTS_GC,
            TASK_RUN_WEBHOOK,
            TASK_SENDMAIL,
            TASK_SESSION_GC,
            TASK_TASKS_GC
        ]
    );
}

#[tokio::test]
async fn sendmail_passes_the_task_props_to_the_mailer() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());
    let props = map([("subject", Value::str("Hello"))]);
    let task = task(TASK_SENDMAIL, props.clone());

    let result = invoke(&registry, TASK_SENDMAIL, &task)
        .await
        .expect("handler");

    assert_eq!(result, HandlerResult::Completed);
    assert_eq!(services.mailer.emails.lock().expect("lock")[0], props);
}

#[tokio::test]
async fn objects_gc_receives_skip_delay_and_passes_the_props() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());
    let props = map([
        ("skip-delay", Value::Bool(true)),
        ("chunk-size", Value::Integer(50)),
    ]);
    let task = task(TASK_OBJECTS_GC, props.clone());

    invoke(&registry, TASK_OBJECTS_GC, &task)
        .await
        .expect("handler");

    assert_eq!(services.objects_gc.calls.lock().expect("lock")[0], props);
}

#[tokio::test]
async fn tasks_gc_uses_the_props_override_and_rollback_flag() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());
    let props = map([
        ("min-age", Value::Duration(90_000)),
        ("rollback?", Value::Bool(true)),
    ]);
    let task = task(TASK_TASKS_GC, props);

    invoke(&registry, TASK_TASKS_GC, &task)
        .await
        .expect("handler");

    assert_eq!(
        services.tasks_gc.calls.lock().expect("lock")[0],
        (Duration::from_secs(90), true)
    );
}

#[tokio::test]
async fn tasks_gc_falls_back_to_the_service_minimum_age() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());
    let task = task(TASK_TASKS_GC, Map::new());

    invoke(&registry, TASK_TASKS_GC, &task)
        .await
        .expect("handler");

    assert_eq!(
        services.tasks_gc.calls.lock().expect("lock")[0],
        (Duration::from_hours(168), false)
    );
}

#[tokio::test]
async fn session_gc_runs_the_service_once() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());

    invoke(
        &registry,
        TASK_SESSION_GC,
        &task(TASK_SESSION_GC, Map::new()),
    )
    .await
    .expect("handler");

    assert_eq!(*services.session_gc.calls.lock().expect("lock"), 1);
}

#[tokio::test]
async fn run_webhook_separates_event_and_configuration() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());
    let event = map([("name", Value::str("file-update"))]);
    let config = map([("uri", Value::str("https://example.test/hook"))]);
    let props = map([
        ("event", Value::Map(event.clone())),
        ("config", Value::Map(config.clone())),
    ]);

    invoke(&registry, TASK_RUN_WEBHOOK, &task(TASK_RUN_WEBHOOK, props))
        .await
        .expect("handler");

    assert_eq!(
        services.webhook.calls.lock().expect("lock")[0],
        (event, config)
    );
}

#[tokio::test]
async fn run_webhook_rejects_a_missing_event_map() {
    let services = Services::new();
    let registry = penpot_registry(services.bundle());
    let props = map([("config", Value::Map(Map::new()))]);

    let error = invoke(&registry, TASK_RUN_WEBHOOK, &task(TASK_RUN_WEBHOOK, props))
        .await
        .expect_err("invalid props");

    assert_eq!(error.message(), "missing map property `event`");
}

#[tokio::test]
async fn service_error_becomes_a_retryable_handler_failure() {
    struct FailingSessionGc;

    #[async_trait]
    impl SessionGc for FailingSessionGc {
        async fn run(&self) -> std::result::Result<u64, ServiceError> {
            Err(ServiceError::new("database unavailable"))
        }
    }

    let services = PenpotTaskServices {
        sendmail: Arc::new(FakeMailer::default()),
        objects_gc: Arc::new(FakeObjectsGc::default()),
        tasks_gc: Arc::new(FakeTasksGc::default()),
        session_gc: Arc::new(FailingSessionGc),
        webhook: Arc::new(FakeWebhookRunner::default()),
    };
    let registry = penpot_registry(services);

    let error = invoke(
        &registry,
        TASK_SESSION_GC,
        &task(TASK_SESSION_GC, Map::new()),
    )
    .await
    .expect_err("service failure");

    assert_eq!(error.message(), "database unavailable");
}
