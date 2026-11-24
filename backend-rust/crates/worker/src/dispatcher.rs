//! Dispatcher loop: recover stale rows, claim due tasks and publish payloads.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use chrono::{DateTime, TimeDelta, Utc};
use tokio::sync::watch;
use transit::Value;
use uuid::Uuid;

pub use crate::repository::{ClaimedTask, QueueRef};
use crate::{Result, TaskQueue, TaskRepository, WorkerError};

/// SQL selecting due rows with the exact priority/order contract.
pub const SQL_SELECT_NEXT_TASKS: &str = "SELECT id, queue, scheduled_at from task AS t
    WHERE t.scheduled_at <= ?::timestamptz
      AND (t.status = 'new' OR t.status = 'retry')
      AND queue ~~* ?::text
    ORDER BY t.priority DESC, t.scheduled_at
    LIMIT ?
      FOR UPDATE
     SKIP LOCKED";

/// Publish acknowledgement written after Redis RPUSH succeeds.
pub const SQL_MARK_TASK_SCHEDULED: &str = "UPDATE task SET status = 'scheduled' WHERE id = ANY(?)";

/// Return lost scheduled rows after five minutes.
pub const SQL_RESCHEDULE_LOST: &str = "UPDATE task
      SET status='new', scheduled_at=?::timestamptz
     FROM (SELECT t.id
             FROM task AS t
            WHERE status = 'scheduled'
              AND (?::timestamptz - t.scheduled_at) > '5 min'::interval) AS subquery
    WHERE task.id=subquery.id
RETURNING task.id, task.queue";

/// Fail running rows that stopped heartbeating for 24 hours.
pub const SQL_CLEAN_ORPHAN: &str = "UPDATE task
      SET status='failed', modified_at=?::timestamptz,
          error='orphan with running status'
     FROM (SELECT t.id
             FROM task AS t
            WHERE status = 'running'
              AND (?::timestamptz - t.modified_at) > '24 hour'::interval) AS subquery
    WHERE task.id=subquery.id
RETURNING task.id, task.queue";

/// Redis operation timeout after an adapter error.
pub const DISPATCHER_TIMEOUT: Duration = Duration::from_secs(10);
/// Number of rows selected per batch.
pub const BATCH_SIZE: usize = 100;
/// Sleep after an empty batch.
pub const WAIT_DURATION: Duration = Duration::from_secs(5);
/// Scheduled rows older than this are considered lost.
pub const LOST_TASK_AFTER: TimeDelta = TimeDelta::minutes(5);
/// Running rows older than this are failed as orphans.
pub const ORPHAN_AFTER: TimeDelta = TimeDelta::hours(24);

/// Redis payload `[task-id scheduled-at]`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TaskMessage {
    /// Task identifier.
    pub id: Uuid,
    /// Scheduled instant used by the stale-message check.
    pub scheduled_at: DateTime<Utc>,
}

/// Dispatcher sizing and polling settings.
#[derive(Debug, Clone)]
pub struct DispatcherConfig {
    /// Tenant prefix used to select rows.
    pub tenant: String,
    /// Rows per claim.
    pub batch_size: usize,
    /// Sleep after no due rows.
    pub wait_duration: Duration,
    /// Sleep after database or Redis errors.
    pub error_backoff: Duration,
}

impl Default for DispatcherConfig {
    fn default() -> Self {
        Self {
            tenant: "default".into(),
            batch_size: BATCH_SIZE,
            wait_duration: WAIT_DURATION,
            error_backoff: DISPATCHER_TIMEOUT,
        }
    }
}

/// Result of one dispatcher iteration.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum BatchOutcome {
    /// Rows were published to one or more queues.
    Published {
        /// Number of Redis queue batches.
        batches: usize,
        /// Number of task rows.
        tasks: usize,
    },
    /// No due rows were found.
    Waited,
}

/// Dispatcher over repository and queue boundaries.
pub struct Dispatcher<R, Q> {
    repository: Arc<R>,
    queue: Arc<Q>,
    config: DispatcherConfig,
}

impl<R, Q> Dispatcher<R, Q>
where
    R: TaskRepository,
    Q: TaskQueue,
{
    /// Create a dispatcher.
    #[must_use]
    pub fn new(repository: Arc<R>, queue: Arc<Q>, config: DispatcherConfig) -> Self {
        Self {
            repository,
            queue,
            config,
        }
    }

    /// Redis key for a tenant-prefixed queue.
    #[must_use]
    pub fn queue_key(&self, queue: &str) -> String {
        format!("penpot.worker.queue:{queue}")
    }

    /// Execute one recovery, claim and publish cycle.
    ///
    /// # Errors
    ///
    /// Returns a repository or queue error when recovery, selection, Redis
    /// publishing or the scheduled acknowledgement fails.
    pub async fn run_once(&self, now: DateTime<Utc>) -> Result<BatchOutcome> {
        for item in self
            .repository
            .reschedule_lost(now, LOST_TASK_AFTER)
            .await?
        {
            tracing::warn!(task_id = %item.id, queue = %item.queue, "reschedule lost task");
        }
        for item in self.repository.fail_orphans(now, ORPHAN_AFTER).await? {
            tracing::warn!(task_id = %item.id, queue = %item.queue, "fail orphan task");
        }

        let tasks = self
            .repository
            .select_next(now, &self.config.tenant, self.config.batch_size)
            .await?;
        if tasks.is_empty() {
            return Ok(BatchOutcome::Waited);
        }

        let mut groups: BTreeMap<String, Vec<ClaimedTask>> = BTreeMap::new();
        for task in &tasks {
            groups
                .entry(task.queue.clone())
                .or_default()
                .push(task.clone());
        }

        for (queue, group) in &groups {
            let messages: Vec<_> = group
                .iter()
                .map(|task| {
                    encode_payload(&TaskMessage {
                        id: task.id,
                        scheduled_at: task.scheduled_at,
                    })
                })
                .collect();
            self.queue.push(&self.queue_key(queue), messages).await?;
            let ids: Vec<_> = group.iter().map(|task| task.id).collect();
            self.repository.mark_scheduled(&ids).await?;
        }

        Ok(BatchOutcome::Published {
            batches: groups.len(),
            tasks: tasks.len(),
        })
    }

    /// Poll until `shutdown` changes.
    ///
    /// # Errors
    ///
    /// Returns the first repository or queue error raised outside the retry
    /// loop. Errors inside the loop are logged and followed by a backoff.
    pub async fn run_loop(&self, mut shutdown: watch::Receiver<bool>) -> Result<()> {
        while !*shutdown.borrow() {
            let delay = match self.run_once(Utc::now()).await {
                Ok(BatchOutcome::Published { .. }) => continue,
                Ok(BatchOutcome::Waited) => self.config.wait_duration,
                Err(error) => {
                    tracing::error!(%error, "worker dispatcher failed");
                    self.config.error_backoff
                }
            };

            tokio::select! {
                () = tokio::time::sleep(delay) => {}
                result = shutdown.changed() => {
                    if result.is_err() || *shutdown.borrow() {
                        break;
                    }
                }
            }
        }
        Ok(())
    }
}

/// Encode the Clojure `[id scheduled-at]` Redis payload.
#[must_use]
pub fn encode_payload(message: &TaskMessage) -> String {
    transit::encode(&Value::vector([
        Value::Uuid(message.id),
        Value::Instant(message.scheduled_at.timestamp_millis()),
    ]))
}

/// Decode a Redis payload without assuming any queue name.
///
/// # Errors
///
/// Returns [`WorkerError::InvalidPayload`] when Transit decoding fails or the
/// value is not a `[uuid instant]` pair.
pub fn decode_payload(payload: &str) -> Result<TaskMessage> {
    let value =
        transit::decode(payload).map_err(|error| WorkerError::InvalidPayload(error.to_string()))?;
    let items = match value {
        Value::List(items) | Value::Array(items) => items,
        other => {
            return Err(WorkerError::InvalidPayload(format!(
                "expected a two-item vector, got {other:?}"
            )));
        }
    };
    let [Value::Uuid(id), Value::Instant(millis)] = items.as_slice() else {
        return Err(WorkerError::InvalidPayload(
            "expected [uuid, instant]".into(),
        ));
    };
    let scheduled_at = DateTime::from_timestamp_millis(*millis).ok_or_else(|| {
        WorkerError::InvalidPayload(format!("instant {millis} is outside the supported range"))
    })?;
    Ok(TaskMessage {
        id: *id,
        scheduled_at,
    })
}
