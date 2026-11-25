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
/// The scalar methods are the non-transactional fallback. The dispatcher uses
/// [`TaskRepository::begin_batch`] instead so a live adapter can keep the
/// `FOR UPDATE SKIP LOCKED` locks from selection until the Redis pushes are
/// acknowledged. Dropping a [`DispatchBatch`] without
/// [`commit`](DispatchBatch::commit) rolls the batch back.
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

    /// Open the transaction used by one dispatcher iteration.
    ///
    /// The default runs every operation on its own, which is enough for the
    /// in-memory fakes but leaves a race between selection and the scheduled
    /// acknowledgement. A PostgreSQL adapter overrides this method.
    async fn begin_batch<'a>(&'a self) -> Result<Box<dyn DispatchBatch + 'a>> {
        Ok(Box::new(SequentialBatch { repository: self }))
    }
}

/// One dispatcher iteration's transaction.
///
/// `reschedule_lost`, `fail_orphans` and `select_next` run first, then the
/// dispatcher publishes the selected rows and calls `mark_scheduled` for each
/// queue group. Only `commit` makes the recovery and scheduled states durable.
#[async_trait]
pub trait DispatchBatch: Send {
    /// Return lost `scheduled` rows to `new`.
    async fn reschedule_lost(
        &mut self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>>;

    /// Mark stale `running` rows as failed orphans.
    async fn fail_orphans(
        &mut self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>>;

    /// Lock and return due `new`/`retry` rows for one tenant.
    async fn select_next(
        &mut self,
        now: DateTime<Utc>,
        tenant: &str,
        limit: usize,
    ) -> Result<Vec<ClaimedTask>>;

    /// Set the selected rows to `scheduled`.
    async fn mark_scheduled(&mut self, ids: &[Uuid]) -> Result<usize>;

    /// Commit recovery, selection and acknowledgement.
    async fn commit(self: Box<Self>) -> Result<()>;
}

/// Default batch for repositories that have no transaction boundary.
struct SequentialBatch<'a, R: TaskRepository + ?Sized> {
    repository: &'a R,
}

#[async_trait]
impl<R: TaskRepository + ?Sized> DispatchBatch for SequentialBatch<'_, R> {
    async fn reschedule_lost(
        &mut self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>> {
        self.repository.reschedule_lost(now, max_age).await
    }

    async fn fail_orphans(
        &mut self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>> {
        self.repository.fail_orphans(now, max_age).await
    }

    async fn select_next(
        &mut self,
        now: DateTime<Utc>,
        tenant: &str,
        limit: usize,
    ) -> Result<Vec<ClaimedTask>> {
        self.repository.select_next(now, tenant, limit).await
    }

    async fn mark_scheduled(&mut self, ids: &[Uuid]) -> Result<usize> {
        self.repository.mark_scheduled(ids).await
    }

    async fn commit(self: Box<Self>) -> Result<()> {
        Ok(())
    }
}

/// Redis list operations used by the worker.
#[async_trait]
pub trait TaskQueue: Send + Sync {
    /// Push encoded payloads to one queue key.
    async fn push(&self, queue: &str, payloads: Vec<String>) -> Result<()>;

    /// Pop one payload, waiting up to `timeout`.
    async fn pop(&self, queue: &str, timeout: Duration) -> Result<Option<String>>;
}
