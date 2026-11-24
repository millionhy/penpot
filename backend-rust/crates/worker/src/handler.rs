//! Task handler registry and the five Penpot task adapters.

use std::{collections::HashMap, sync::Arc, time::Duration};

use async_trait::async_trait;
use transit::{Map, Value};

use crate::{
    HandlerFailure, HandlerResult, ServiceError, Task, TASK_OBJECTS_GC, TASK_RUN_WEBHOOK,
    TASK_SENDMAIL, TASK_SESSION_GC, TASK_TASKS_GC,
};

/// One executable task handler.
#[async_trait]
pub trait TaskHandler: Send + Sync {
    /// Execute a task. Errors retry until the row reaches `max_retries`.
    async fn handle(&self, task: &Task) -> std::result::Result<HandlerResult, HandlerFailure>;
}

/// Registry used by the runner.
#[derive(Clone, Default)]
pub struct TaskRegistry {
    handlers: HashMap<String, Arc<dyn TaskHandler>>,
}

impl TaskRegistry {
    /// Empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Add or replace one handler.
    pub fn register<H>(&mut self, name: impl Into<String>, handler: H)
    where
        H: TaskHandler + 'static,
    {
        self.handlers.insert(name.into(), Arc::new(handler));
    }

    /// Register an already shared handler.
    pub fn register_shared(&mut self, name: impl Into<String>, handler: Arc<dyn TaskHandler>) {
        self.handlers.insert(name.into(), handler);
    }

    /// Look up one handler.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<Arc<dyn TaskHandler>> {
        self.handlers.get(name).cloned()
    }

    /// Sorted handler names.
    #[must_use]
    pub fn names(&self) -> Vec<String> {
        let mut names: Vec<_> = self.handlers.keys().cloned().collect();
        names.sort();
        names
    }

    /// Number of registered handlers.
    #[must_use]
    pub fn len(&self) -> usize {
        self.handlers.len()
    }

    /// Whether no handlers are registered.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.handlers.is_empty()
    }
}

/// Email delivery boundary.
#[async_trait]
pub trait Mailer: Send + Sync {
    /// Deliver one rendered email map.
    async fn send(&self, email: &Map) -> std::result::Result<(), ServiceError>;
}

/// Object and soft-deletion maintenance boundary.
#[async_trait]
pub trait ObjectsGc: Send + Sync {
    /// Execute object GC with the task props.
    async fn run(&self, props: &Map) -> std::result::Result<u64, ServiceError>;
}

/// Completed task cleanup boundary.
#[async_trait]
pub trait TasksGc: Send + Sync {
    /// Configured minimum age of deleted rows.
    fn default_min_age(&self) -> Duration;

    /// Delete rows older than `min_age`.
    async fn run(
        &self,
        min_age: Duration,
        rollback: bool,
    ) -> std::result::Result<u64, ServiceError>;
}

/// Expired HTTP session cleanup boundary.
#[async_trait]
pub trait SessionGc: Send + Sync {
    /// Delete idle and absolutely expired sessions.
    async fn run(&self) -> std::result::Result<u64, ServiceError>;
}

/// Outbound webhook delivery boundary.
#[async_trait]
pub trait WebhookRunner: Send + Sync {
    /// Deliver one event to one webhook configuration.
    async fn run(&self, event: &Map, config: &Map) -> std::result::Result<(), ServiceError>;
}

/// Dependencies for the five offline Penpot tasks.
#[derive(Clone)]
pub struct PenpotTaskServices {
    /// `sendmail` handler.
    pub sendmail: Arc<dyn Mailer>,
    /// `objects-gc` handler.
    pub objects_gc: Arc<dyn ObjectsGc>,
    /// `tasks-gc` handler.
    pub tasks_gc: Arc<dyn TasksGc>,
    /// `session-gc` handler.
    pub session_gc: Arc<dyn SessionGc>,
    /// `run-webhook` handler.
    pub webhook: Arc<dyn WebhookRunner>,
}

/// Build the five handlers registered by the Clojure worker.
#[must_use]
pub fn penpot_registry(services: PenpotTaskServices) -> TaskRegistry {
    let mut registry = TaskRegistry::new();
    registry.register(
        TASK_SENDMAIL,
        SendmailHandler {
            service: services.sendmail,
        },
    );
    registry.register(
        TASK_OBJECTS_GC,
        ObjectsGcHandler {
            service: services.objects_gc,
        },
    );
    registry.register(
        TASK_TASKS_GC,
        TasksGcHandler {
            service: services.tasks_gc,
        },
    );
    registry.register(
        TASK_SESSION_GC,
        SessionGcHandler {
            service: services.session_gc,
        },
    );
    registry.register(
        TASK_RUN_WEBHOOK,
        RunWebhookHandler {
            service: services.webhook,
        },
    );
    registry
}

struct SendmailHandler {
    service: Arc<dyn Mailer>,
}

#[async_trait]
impl TaskHandler for SendmailHandler {
    async fn handle(&self, task: &Task) -> std::result::Result<HandlerResult, HandlerFailure> {
        self.service
            .send(&task.props)
            .await
            .map(|()| HandlerResult::Completed)
            .map_err(service_failure)
    }
}

struct ObjectsGcHandler {
    service: Arc<dyn ObjectsGc>,
}

#[async_trait]
impl TaskHandler for ObjectsGcHandler {
    async fn handle(&self, task: &Task) -> std::result::Result<HandlerResult, HandlerFailure> {
        self.service
            .run(&task.props)
            .await
            .map(|_| HandlerResult::Completed)
            .map_err(service_failure)
    }
}

struct TasksGcHandler {
    service: Arc<dyn TasksGc>,
}

#[async_trait]
impl TaskHandler for TasksGcHandler {
    async fn handle(&self, task: &Task) -> std::result::Result<HandlerResult, HandlerFailure> {
        let min_age = match task.props.get_kw("min-age") {
            Some(value) => duration_value(value).ok_or_else(|| {
                HandlerFailure::new("property `min-age` must be a non-negative duration")
            })?,
            None => self.service.default_min_age(),
        };
        let rollback = bool_value(task.props.get_kw("rollback?")).unwrap_or(false);
        self.service
            .run(min_age, rollback)
            .await
            .map(|_| HandlerResult::Completed)
            .map_err(service_failure)
    }
}

struct SessionGcHandler {
    service: Arc<dyn SessionGc>,
}

#[async_trait]
impl TaskHandler for SessionGcHandler {
    async fn handle(&self, _task: &Task) -> std::result::Result<HandlerResult, HandlerFailure> {
        self.service
            .run()
            .await
            .map(|_| HandlerResult::Completed)
            .map_err(service_failure)
    }
}

struct RunWebhookHandler {
    service: Arc<dyn WebhookRunner>,
}

#[async_trait]
impl TaskHandler for RunWebhookHandler {
    async fn handle(&self, task: &Task) -> std::result::Result<HandlerResult, HandlerFailure> {
        let event = required_map(&task.props, "event")?;
        let config = required_map(&task.props, "config")?;
        self.service
            .run(event, config)
            .await
            .map(|()| HandlerResult::Completed)
            .map_err(service_failure)
    }
}

fn required_map<'a>(props: &'a Map, name: &str) -> std::result::Result<&'a Map, HandlerFailure> {
    match props.get_kw(name).and_then(Value::as_map) {
        Some(value) => Ok(value),
        None => Err(HandlerFailure::new(format!(
            "missing map property `{name}`"
        ))),
    }
}

fn duration_value(value: &Value) -> Option<Duration> {
    let millis = match value {
        Value::Duration(millis) | Value::Integer(millis) => *millis,
        _ => return None,
    };
    u64::try_from(millis).ok().map(Duration::from_millis)
}

fn bool_value(value: Option<&Value>) -> Option<bool> {
    match value {
        Some(Value::Bool(value)) => Some(*value),
        _ => None,
    }
}

fn service_failure(error: ServiceError) -> HandlerFailure {
    HandlerFailure::new(error.message())
}
