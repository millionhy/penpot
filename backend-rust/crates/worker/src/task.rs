//! Persisted task row and deterministic status transitions.

use std::{fmt, str::FromStr, time::Duration};

use chrono::{DateTime, TimeDelta, TimeZone, Utc};
use transit::{Map, Value};
use uuid::Uuid;

use crate::{Result, WorkerError};

/// Default queue used by `submit!`.
pub const DEFAULT_QUEUE: &str = "default";
/// Default scheduler priority.
pub const DEFAULT_PRIORITY: i16 = 100;
/// Default number of retries.
pub const DEFAULT_MAX_RETRIES: i16 = 3;
/// Default first retry delay.
pub const DEFAULT_RETRY_DELAY: Duration = Duration::from_secs(1);

/// SQL used by task submission.
pub const SQL_INSERT_NEW_TASK: &str = "insert into task (id, name, props, queue, label, priority, max_retries, created_at, modified_at, scheduled_at)
   values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   returning id";

/// Deduplication only removes tasks that have not become due.
pub const SQL_REMOVE_NOT_STARTED_TASKS: &str = "DELETE FROM task
    WHERE name=?
      AND queue=?
      AND label=?
      AND status = 'new'
      AND scheduled_at > ?";

/// The six status values accepted by the Clojure runner schema.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum TaskStatus {
    /// Ready for the dispatcher.
    New,
    /// Waiting for exponential backoff.
    Retry,
    /// Published to Redis.
    Scheduled,
    /// Claimed by a runner.
    Running,
    /// Finished successfully.
    Completed,
    /// Terminal failure.
    Failed,
}

impl TaskStatus {
    /// Exact string stored in PostgreSQL.
    #[must_use]
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::New => "new",
            Self::Retry => "retry",
            Self::Scheduled => "scheduled",
            Self::Running => "running",
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    /// Whether the normal dispatcher/runner workflow may use this edge.
    #[must_use]
    pub const fn can_transition_to(self, next: Self) -> bool {
        matches!(
            (self, next),
            (Self::New, Self::Scheduled | Self::Completed | Self::Failed)
                | (Self::Retry, Self::Scheduled)
                | (Self::Scheduled, Self::Running | Self::New | Self::Failed)
                | (Self::Running, Self::Completed | Self::Retry | Self::Failed)
        )
    }
}

impl fmt::Display for TaskStatus {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl FromStr for TaskStatus {
    type Err = WorkerError;

    fn from_str(value: &str) -> Result<Self> {
        match value {
            "new" => Ok(Self::New),
            "retry" => Ok(Self::Retry),
            "scheduled" => Ok(Self::Scheduled),
            "running" => Ok(Self::Running),
            "completed" => Ok(Self::Completed),
            "failed" => Ok(Self::Failed),
            other => Err(WorkerError::InvalidStatus(other.to_owned())),
        }
    }
}

/// Options accepted by the submit helper.
#[derive(Debug, Clone)]
pub struct SubmitOptions {
    /// Registered task name.
    pub task: String,
    /// Transit task properties.
    pub params: Map,
    /// Delay before the task becomes due.
    pub delay: Duration,
    /// Queue without the tenant prefix.
    pub queue: String,
    /// Larger values dispatch first.
    pub priority: i16,
    /// Maximum retry count.
    pub max_retries: i16,
    /// Deduplication label.
    pub label: String,
    /// Remove a not-yet-due `new` task with the same name/queue/label.
    pub dedupe: bool,
}

impl SubmitOptions {
    /// Start with the backend defaults.
    #[must_use]
    pub fn new(task: impl Into<String>) -> Self {
        Self {
            task: task.into(),
            params: Map::new(),
            delay: Duration::ZERO,
            queue: DEFAULT_QUEUE.to_owned(),
            priority: DEFAULT_PRIORITY,
            max_retries: DEFAULT_MAX_RETRIES,
            label: String::new(),
            dedupe: false,
        }
    }

    /// Set Transit properties.
    #[must_use]
    pub fn props(mut self, props: Map) -> Self {
        self.params = props;
        self
    }

    /// Set the initial delay.
    #[must_use]
    pub fn delay(mut self, delay: Duration) -> Self {
        self.delay = delay;
        self
    }

    /// Set the queue name before tenant prefixing.
    #[must_use]
    pub fn queue(mut self, queue: impl Into<String>) -> Self {
        self.queue = queue.into();
        self
    }

    /// Set scheduler priority.
    #[must_use]
    pub fn priority(mut self, priority: i16) -> Self {
        self.priority = priority;
        self
    }

    /// Set the retry cap.
    #[must_use]
    pub fn max_retries(mut self, max_retries: i16) -> Self {
        self.max_retries = max_retries;
        self
    }

    /// Set the deduplication label.
    #[must_use]
    pub fn label(mut self, label: impl Into<String>) -> Self {
        self.label = label.into();
        self
    }

    /// Enable or disable submission deduplication.
    #[must_use]
    pub fn dedupe(mut self, dedupe: bool) -> Self {
        self.dedupe = dedupe;
        self
    }
}

/// A row in the partitioned `task` table.
#[derive(Debug, Clone, PartialEq)]
pub struct Task {
    /// Task identifier.
    pub id: Uuid,
    /// Registered handler name.
    pub name: String,
    /// Transit properties stored in JSONB.
    pub props: Map,
    /// Tenant-prefixed queue.
    pub queue: String,
    /// Deduplication label.
    pub label: String,
    /// Current status.
    pub status: TaskStatus,
    /// Scheduler priority.
    pub priority: i16,
    /// Number of retries already recorded.
    pub retry_num: i16,
    /// Retry cap.
    pub max_retries: i16,
    /// Creation timestamp.
    pub created_at: DateTime<Utc>,
    /// Last mutation timestamp.
    pub modified_at: DateTime<Utc>,
    /// Time when the dispatcher may claim the row.
    pub scheduled_at: DateTime<Utc>,
    /// Completion timestamp.
    pub completed_at: Option<DateTime<Utc>>,
    /// Last error text.
    pub error: Option<String>,
}

impl Task {
    /// Build a new `new` task using the Clojure submit defaults.
    #[must_use]
    pub fn new(id: Uuid, tenant: &str, options: SubmitOptions, now: DateTime<Utc>) -> Self {
        let created_at = truncate_millis(now);
        let scheduled_at = truncate_millis(now + duration_to_delta(options.delay));
        Self {
            id,
            name: options.task,
            props: options.params,
            queue: task_queue(tenant, &options.queue),
            label: options.label,
            status: TaskStatus::New,
            priority: options.priority,
            retry_num: 0,
            max_retries: options.max_retries,
            created_at,
            modified_at: created_at,
            scheduled_at,
            completed_at: None,
            error: None,
        }
    }

    /// Epoch milliseconds used by dispatcher payloads and stale checks.
    #[must_use]
    pub fn scheduled_millis(&self) -> i64 {
        self.scheduled_at.timestamp_millis()
    }

    /// Task props as the Transit value stored in JSONB.
    #[must_use]
    pub fn props_value(&self) -> Value {
        Value::Map(self.props.clone())
    }

    /// Apply the classified handler result.
    pub fn apply_result(&mut self, result: HandlerResult, now: DateTime<Utc>) {
        match result {
            HandlerResult::Completed => {
                self.status = TaskStatus::Completed;
                self.completed_at = Some(now);
                self.modified_at = now;
                self.error = None;
            }
            HandlerResult::Failed { error } => {
                self.status = TaskStatus::Failed;
                self.modified_at = now;
                self.error = Some(error);
            }
            HandlerResult::Retry {
                error,
                delay,
                inc_by,
            } => {
                let next_retry = self.retry_num.saturating_add(inc_by.max(0));
                let delay = retry_delay(delay.unwrap_or(DEFAULT_RETRY_DELAY), next_retry);
                self.status = TaskStatus::Retry;
                self.retry_num = next_retry;
                self.modified_at = now;
                self.scheduled_at = truncate_millis(now + duration_to_delta(delay));
                self.completed_at = None;
                self.error = Some(error);
            }
        }
    }

    /// Convert an uncaught handler error into retry or terminal failure.
    pub fn apply_failure(&mut self, failure: &HandlerFailure, now: DateTime<Utc>) {
        let error = failure.message().to_owned();
        if self.retry_num >= self.max_retries {
            self.apply_result(HandlerResult::Failed { error }, now);
            return;
        }

        self.apply_result(
            HandlerResult::Retry {
                error,
                delay: failure.delay(),
                inc_by: i16::from(!failure.is_noop()),
            },
            now,
        );
    }

    /// Dispatcher marks a selected row as published.
    pub fn mark_scheduled(&mut self) {
        self.status = TaskStatus::Scheduled;
    }

    /// A Redis message was lost and the row becomes immediately claimable.
    pub fn reschedule_lost(&mut self, now: DateTime<Utc>) {
        self.status = TaskStatus::New;
        self.scheduled_at = now;
        self.modified_at = now;
    }

    /// A row stayed `running` for more than the orphan threshold.
    pub fn mark_orphan_failed(&mut self, now: DateTime<Utc>) {
        self.status = TaskStatus::Failed;
        self.error = Some("orphan with running status".into());
        self.modified_at = now;
    }
}

/// Successful result shape returned by a handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum HandlerResult {
    /// Task finished.
    Completed,
    /// Task stopped with a terminal error.
    Failed {
        /// Text persisted in `task.error`.
        error: String,
    },
    /// Handler deliberately asks for another attempt.
    Retry {
        /// Text persisted in `task.error`.
        error: String,
        /// Base delay; defaults to one second.
        delay: Option<Duration>,
        /// Retry-number increment; `0` is the `::noop` strategy.
        inc_by: i16,
    },
}

/// Error raised by a handler.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HandlerFailure {
    message: String,
    delay: Option<Duration>,
    noop: bool,
}

impl HandlerFailure {
    /// Build a normal handler failure.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            delay: None,
            noop: false,
        }
    }

    /// Override the first retry delay.
    #[must_use]
    pub fn with_delay(mut self, delay: Duration) -> Self {
        self.delay = Some(delay);
        self
    }

    /// Retry without increasing `retry_num`.
    #[must_use]
    pub fn noop(mut self) -> Self {
        self.noop = true;
        self
    }

    /// Persisted error text.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }

    /// Optional base delay.
    #[must_use]
    pub fn delay(&self) -> Option<Duration> {
        self.delay
    }

    /// Whether `retry_num` stays unchanged.
    #[must_use]
    pub const fn is_noop(&self) -> bool {
        self.noop
    }
}

impl fmt::Display for HandlerFailure {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for HandlerFailure {}

/// Format `tenant:queue`.
#[must_use]
pub fn task_queue(tenant: &str, queue: &str) -> String {
    format!("{tenant}:{queue}")
}

fn retry_delay(base: Duration, retry_num: i16) -> Duration {
    let exponent = u32::try_from(retry_num.saturating_sub(1).max(0)).unwrap_or(u32::MAX);
    let factor = 1_u32.checked_shl(exponent).unwrap_or(u32::MAX);
    let millis = base
        .as_millis()
        .saturating_mul(u128::from(factor))
        .min(i64::MAX as u128);
    Duration::from_millis(u64::try_from(millis).unwrap_or(u64::MAX))
}

fn duration_to_delta(duration: Duration) -> TimeDelta {
    TimeDelta::from_std(duration).unwrap_or(TimeDelta::MAX)
}

fn truncate_millis(value: DateTime<Utc>) -> DateTime<Utc> {
    Utc.timestamp_millis_opt(value.timestamp_millis())
        .single()
        .unwrap_or(value)
}
