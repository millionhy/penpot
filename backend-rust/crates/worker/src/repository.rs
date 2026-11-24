//! PostgreSQL and Redis boundaries used by the dispatcher and runner.

use std::time::Duration;

use async_trait::async_trait;
use chrono::{DateTime, TimeDelta, Utc};
use uuid::Uuid;

use crate::{Result, Task};

/// A row selected by the dispatcher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedTask {
    /// Task identifier.
    pub id: Uuid,
    /// Tenant-prefixed queue.
    pub queue: String,
    /// Timestamp encoded in the Redis payload.
    pub scheduled_at: DateTime<Utc>,
}

/// A task moved back to a queue by recovery logic.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueueRef {
    /// Task identifier.
    pub id: Uuid,
    /// Tenant-prefixed queue.
    pub queue: String,
}

/// Persistence operations required by the task workflow.
///
/// A live implementation must run `select_next`, `mark_scheduled`,
/// `reschedule_lost`, and `fail_orphans` inside the transactions described by
/// the SQL constants in [`crate::dispatcher`].
#[async_trait]
pub trait TaskRepository: Send + Sync {
    /// Lock and return due `new`/`retry` rows for one tenant.
    async fn select_next(
        &self,
        now: DateTime<Utc>,
        tenant: &str,
        limit: usize,
    ) -> Result<Vec<ClaimedTask>>;

    /// Set the selected rows to `scheduled`.
    async fn mark_scheduled(&self, ids: &[Uuid]) -> Result<usize>;

    /// Return lost `scheduled` rows to `new`.
    async fn reschedule_lost(
        &self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>>;

    /// Mark stale `running` rows as failed orphans.
    async fn fail_orphans(&self, now: DateTime<Utc>, max_age: TimeDelta) -> Result<Vec<QueueRef>>;

    /// Fetch one row by id, decoding Transit props from JSONB.
    async fn get(&self, id: Uuid) -> Result<Option<Task>>;

    /// Set `status = running` and `modified_at = now`.
    async fn mark_running(&self, id: Uuid, now: DateTime<Utc>) -> Result<bool>;

    /// Persist the terminal or retry fields of a task.
    async fn save(&self, task: &Task) -> Result<bool>;
}

/// Redis list operations used by the worker.
#[async_trait]
pub trait TaskQueue: Send + Sync {
    /// Push encoded payloads to one queue key.
    async fn push(&self, queue: &str, payloads: Vec<String>) -> Result<()>;

    /// Pop one payload, waiting up to `timeout`.
    async fn pop(&self, queue: &str, timeout: Duration) -> Result<Option<String>>;
}
