//! `task` table adapter for the worker dispatcher and runner.
//!
//! The queries restate `app.worker.dispatcher`, `app.worker.runner` and
//! `app.worker` with PostgreSQL placeholders. Two details keep the Rust and
//! Clojure workers compatible:
//!
//! * `props` is a Transit JSON document stored in JSONB. Reads take `props::text`
//!   and decode with the verbose Transit reader; writes encode with the verbose
//!   writer, like `app.db/tjson`.
//! * The dispatcher runs recovery, selection and the scheduled acknowledgement
//!   in one transaction. `FOR UPDATE SKIP LOCKED` only protects the rows while
//!   that transaction is open, so [`PgTaskRepository::begin_batch`] hands the
//!   dispatcher a [`DispatchBatch`] that owns the transaction.

use chrono::{DateTime, TimeDelta, Utc};
use sqlx::postgres::types::PgInterval;
use sqlx::postgres::{PgExecutor, PgRow};
use sqlx::Row;
use transit::{Map, Value};
use uuid::Uuid;
use worker::{
    ClaimedTask, DispatchBatch, QueueRef, Result, Task, TaskRepository, TaskStatus, WorkerError,
};

/// Due rows in Clojure's priority order, locked until the batch commits.
const SQL_SELECT_NEXT: &str = "SELECT id, queue, \
        (extract(epoch FROM scheduled_at) * 1000)::bigint AS scheduled_at_ms \
   FROM task AS t \
  WHERE t.scheduled_at <= to_timestamp($1::bigint::double precision / 1000.0) \
    AND (t.status = 'new' OR t.status = 'retry') \
    AND queue ~~* $2::text \
  ORDER BY t.priority DESC, t.scheduled_at \
  LIMIT $3 \
    FOR UPDATE \
   SKIP LOCKED";

/// Scheduled acknowledgement written after Redis RPUSH succeeds.
const SQL_MARK_SCHEDULED: &str = "UPDATE task SET status = 'scheduled' WHERE id = ANY($1::uuid[])";

/// Lost `scheduled` rows returned to `new`.
const SQL_RESCHEDULE_LOST: &str = "UPDATE task \
      SET status='new', \
          scheduled_at=to_timestamp($1::bigint::double precision / 1000.0) \
     FROM (SELECT t.id \
             FROM task AS t \
            WHERE status = 'scheduled' \
              AND (to_timestamp($1::bigint::double precision / 1000.0) \
                   - t.scheduled_at) > $2) AS subquery \
    WHERE task.id=subquery.id \
RETURNING task.id, task.queue";

/// Stale `running` rows marked as failed orphans.
const SQL_CLEAN_ORPHAN: &str = "UPDATE task \
      SET status='failed', \
          modified_at=to_timestamp($1::bigint::double precision / 1000.0), \
          error='orphan with running status' \
     FROM (SELECT t.id \
             FROM task AS t \
            WHERE status = 'running' \
              AND (to_timestamp($1::bigint::double precision / 1000.0) \
                   - t.modified_at) > $2) AS subquery \
    WHERE task.id=subquery.id \
RETURNING task.id, task.queue";

/// Full row used by the runner.
const SQL_GET_TASK: &str = "SELECT id, name, props::text AS props, queue, \
        coalesce(label, '') AS label, status, \
        coalesce(priority, 100::smallint) AS priority, \
        retry_num, max_retries, \
        (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms, \
        (extract(epoch FROM scheduled_at) * 1000)::bigint AS scheduled_at_ms, \
        (extract(epoch FROM completed_at) * 1000)::bigint AS completed_at_ms, \
        error \
   FROM task \
  WHERE id = $1";

/// Runner claim.
const SQL_MARK_RUNNING: &str = "UPDATE task \
      SET status='running', \
          modified_at=to_timestamp($2::bigint::double precision / 1000.0) \
    WHERE id=$1";

/// Terminal or retry state, mirroring the three `db/update!` calls in
/// `app.worker.runner`.
const SQL_SAVE_TASK: &str = "UPDATE task \
      SET status=$2, \
          error=$3, \
          modified_at=to_timestamp($4::bigint::double precision / 1000.0), \
          scheduled_at=to_timestamp($5::bigint::double precision / 1000.0), \
          completed_at=to_timestamp($6::bigint::double precision / 1000.0), \
          retry_num=$7 \
    WHERE id=$1";

/// Submission insert, the same columns as `sql:insert-new-task`.
const SQL_INSERT_TASK: &str = "insert into task \
        (id, name, props, queue, label, priority, max_retries, \
         created_at, modified_at, scheduled_at) \
   values ($1, $2, $3::text::jsonb, $4, $5, $6, $7, \
           to_timestamp($8::bigint::double precision / 1000.0), \
           to_timestamp($9::bigint::double precision / 1000.0), \
           to_timestamp($10::bigint::double precision / 1000.0)) \
  returning id";

/// PostgreSQL task repository.
#[derive(Debug, Clone)]
pub struct PgTaskRepository {
    database: db::Database,
}

impl PgTaskRepository {
    /// Wrap a database handle.
    #[must_use]
    pub fn new(database: db::Database) -> Self {
        Self { database }
    }

    /// The wrapped database handle.
    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }

    /// Insert one `new` task.
    ///
    /// # Errors
    ///
    /// Returns a repository error when the row cannot be encoded or written.
    pub async fn insert(&self, task: &Task) -> Result<bool> {
        let props = transit::encode_verbose(&task.props_value());
        let result = sqlx::query(SQL_INSERT_TASK)
            .bind(task.id)
            .bind(&task.name)
            .bind(props)
            .bind(&task.queue)
            .bind(&task.label)
            .bind(task.priority)
            .bind(task.max_retries)
            .bind(task.created_at.timestamp_millis())
            .bind(task.modified_at.timestamp_millis())
            .bind(task.scheduled_at.timestamp_millis())
            .execute(self.database.pool())
            .await
            .map_err(WorkerError::repository)?;
        Ok(result.rows_affected() > 0)
    }
}

#[async_trait::async_trait]
impl TaskRepository for PgTaskRepository {
    async fn select_next(
        &self,
        now: DateTime<Utc>,
        tenant: &str,
        limit: usize,
    ) -> Result<Vec<ClaimedTask>> {
        select_next_rows(self.database.pool(), now, tenant, limit).await
    }

    async fn mark_scheduled(&self, ids: &[Uuid]) -> Result<usize> {
        mark_scheduled_rows(self.database.pool(), ids.to_vec()).await
    }

    async fn reschedule_lost(
        &self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>> {
        reschedule_lost_rows(self.database.pool(), now, max_age).await
    }

    async fn fail_orphans(&self, now: DateTime<Utc>, max_age: TimeDelta) -> Result<Vec<QueueRef>> {
        fail_orphan_rows(self.database.pool(), now, max_age).await
    }

    async fn get(&self, id: Uuid) -> Result<Option<Task>> {
        let row = sqlx::query(SQL_GET_TASK)
            .bind(id)
            .fetch_optional(self.database.pool())
            .await
            .map_err(WorkerError::repository)?;
        row.as_ref().map(task_from_row).transpose()
    }

    async fn mark_running(&self, id: Uuid, now: DateTime<Utc>) -> Result<bool> {
        let result = sqlx::query(SQL_MARK_RUNNING)
            .bind(id)
            .bind(now.timestamp_millis())
            .execute(self.database.pool())
            .await
            .map_err(WorkerError::repository)?;
        Ok(result.rows_affected() > 0)
    }

    async fn save(&self, task: &Task) -> Result<bool> {
        let result = sqlx::query(SQL_SAVE_TASK)
            .bind(task.id)
            .bind(task.status.as_str())
            .bind(task.error.as_deref())
            .bind(task.modified_at.timestamp_millis())
            .bind(task.scheduled_at.timestamp_millis())
            .bind(task.completed_at.map(|instant| instant.timestamp_millis()))
            .bind(task.retry_num)
            .execute(self.database.pool())
            .await
            .map_err(WorkerError::repository)?;
        Ok(result.rows_affected() > 0)
    }

    async fn begin_batch<'a>(&'a self) -> Result<Box<dyn DispatchBatch + 'a>> {
        let transaction = self
            .database
            .pool()
            .begin()
            .await
            .map_err(WorkerError::repository)?;
        Ok(Box::new(PgDispatchBatch { transaction }))
    }
}

/// Dispatcher transaction on a dedicated connection.
struct PgDispatchBatch {
    transaction: sqlx::Transaction<'static, db::Postgres>,
}

#[async_trait::async_trait]
impl DispatchBatch for PgDispatchBatch {
    async fn reschedule_lost(
        &mut self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>> {
        reschedule_lost_rows(&mut *self.transaction, now, max_age).await
    }

    async fn fail_orphans(
        &mut self,
        now: DateTime<Utc>,
        max_age: TimeDelta,
    ) -> Result<Vec<QueueRef>> {
        fail_orphan_rows(&mut *self.transaction, now, max_age).await
    }

    async fn select_next(
        &mut self,
        now: DateTime<Utc>,
        tenant: &str,
        limit: usize,
    ) -> Result<Vec<ClaimedTask>> {
        select_next_rows(&mut *self.transaction, now, tenant, limit).await
    }

    async fn mark_scheduled(&mut self, ids: &[Uuid]) -> Result<usize> {
        mark_scheduled_rows(&mut *self.transaction, ids.to_vec()).await
    }

    async fn commit(self: Box<Self>) -> Result<()> {
        self.transaction
            .commit()
            .await
            .map_err(WorkerError::repository)
    }
}

async fn select_next_rows<'e, E>(
    executor: E,
    now: DateTime<Utc>,
    tenant: &str,
    limit: usize,
) -> Result<Vec<ClaimedTask>>
where
    E: PgExecutor<'e>,
{
    let limit = i64::try_from(limit)
        .map_err(|_| WorkerError::repository("batch size does not fit in bigint"))?;
    let pattern = format!("{tenant}:%");
    let rows = sqlx::query(SQL_SELECT_NEXT)
        .bind(now.timestamp_millis())
        .bind(pattern)
        .bind(limit)
        .fetch_all(executor)
        .await
        .map_err(WorkerError::repository)?;
    rows.iter().map(claimed_from_row).collect()
}

async fn mark_scheduled_rows<'e, E>(executor: E, ids: Vec<Uuid>) -> Result<usize>
where
    E: PgExecutor<'e>,
{
    if ids.is_empty() {
        return Ok(0);
    }
    let result = sqlx::query(SQL_MARK_SCHEDULED)
        .bind(ids)
        .execute(executor)
        .await
        .map_err(WorkerError::repository)?;
    usize::try_from(result.rows_affected())
        .map_err(|_| WorkerError::repository("updated row count overflowed usize"))
}

async fn reschedule_lost_rows<'e, E>(
    executor: E,
    now: DateTime<Utc>,
    max_age: TimeDelta,
) -> Result<Vec<QueueRef>>
where
    E: PgExecutor<'e>,
{
    let rows = sqlx::query(SQL_RESCHEDULE_LOST)
        .bind(now.timestamp_millis())
        .bind(interval(max_age))
        .fetch_all(executor)
        .await
        .map_err(WorkerError::repository)?;
    rows.iter().map(queue_ref_from_row).collect()
}

async fn fail_orphan_rows<'e, E>(
    executor: E,
    now: DateTime<Utc>,
    max_age: TimeDelta,
) -> Result<Vec<QueueRef>>
where
    E: PgExecutor<'e>,
{
    let rows = sqlx::query(SQL_CLEAN_ORPHAN)
        .bind(now.timestamp_millis())
        .bind(interval(max_age))
        .fetch_all(executor)
        .await
        .map_err(WorkerError::repository)?;
    rows.iter().map(queue_ref_from_row).collect()
}

fn claimed_from_row(row: &PgRow) -> Result<ClaimedTask> {
    Ok(ClaimedTask {
        id: row.try_get("id").map_err(WorkerError::repository)?,
        queue: row.try_get("queue").map_err(WorkerError::repository)?,
        scheduled_at: instant(
            row.try_get("scheduled_at_ms")
                .map_err(WorkerError::repository)?,
        )?,
    })
}

fn queue_ref_from_row(row: &PgRow) -> Result<QueueRef> {
    Ok(QueueRef {
        id: row.try_get("id").map_err(WorkerError::repository)?,
        queue: row.try_get("queue").map_err(WorkerError::repository)?,
    })
}

fn task_from_row(row: &PgRow) -> Result<Task> {
    let props: String = row.try_get("props").map_err(WorkerError::repository)?;
    let status: String = row.try_get("status").map_err(WorkerError::repository)?;
    let completed_at: Option<i64> = row
        .try_get("completed_at_ms")
        .map_err(WorkerError::repository)?;

    Ok(Task {
        id: row.try_get("id").map_err(WorkerError::repository)?,
        name: row.try_get("name").map_err(WorkerError::repository)?,
        props: decode_props(&props)?,
        queue: row.try_get("queue").map_err(WorkerError::repository)?,
        label: row.try_get("label").map_err(WorkerError::repository)?,
        status: status.parse::<TaskStatus>()?,
        priority: row.try_get("priority").map_err(WorkerError::repository)?,
        retry_num: row.try_get("retry_num").map_err(WorkerError::repository)?,
        max_retries: row
            .try_get("max_retries")
            .map_err(WorkerError::repository)?,
        created_at: instant(
            row.try_get("created_at_ms")
                .map_err(WorkerError::repository)?,
        )?,
        modified_at: instant(
            row.try_get("modified_at_ms")
                .map_err(WorkerError::repository)?,
        )?,
        scheduled_at: instant(
            row.try_get("scheduled_at_ms")
                .map_err(WorkerError::repository)?,
        )?,
        completed_at: completed_at.map(instant).transpose()?,
        error: row.try_get("error").map_err(WorkerError::repository)?,
    })
}

/// Decode the verbose Transit document stored in `props`.
fn decode_props(text: &str) -> Result<Map> {
    match transit::decode(text) {
        Ok(Value::Map(props)) => Ok(props),
        Ok(other) => Err(WorkerError::repository(format!(
            "task props must be a Transit map, got {other:?}"
        ))),
        Err(error) => Err(WorkerError::repository(format!(
            "invalid task props Transit: {error}"
        ))),
    }
}

fn instant(millis: i64) -> Result<DateTime<Utc>> {
    DateTime::from_timestamp_millis(millis).ok_or_else(|| {
        WorkerError::repository(format!("timestamp {millis} is outside the supported range"))
    })
}

pub(crate) fn interval(duration: TimeDelta) -> PgInterval {
    PgInterval {
        months: 0,
        days: 0,
        microseconds: duration.num_microseconds().unwrap_or(i64::MAX),
    }
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn verbose_transit_props_decode_to_a_map() {
        let props = decode_props(r#"{"~:email":"a@example.com"}"#).expect("map");
        assert_eq!(
            props.get(&Value::Keyword("email".into())),
            Some(&Value::Str("a@example.com".into()))
        );
    }

    #[test]
    fn non_map_props_are_rejected() {
        assert!(decode_props(r#"["~#list",[1,2]]"#).is_err());
        assert!(decode_props("not transit").is_err());
    }

    #[test]
    fn millis_round_trip_through_the_row_helper() {
        let instant = Utc
            .with_ymd_and_hms(2026, 11, 25, 12, 34, 56)
            .single()
            .expect("valid instant");
        assert_eq!(
            super::instant(instant.timestamp_millis()).expect("instant"),
            instant
        );
        assert!(super::instant(i64::MAX).is_err());
    }

    #[test]
    fn interval_uses_microseconds_only() {
        let interval = interval(TimeDelta::minutes(5));
        assert_eq!(interval.months, 0);
        assert_eq!(interval.days, 0);
        assert_eq!(interval.microseconds, 300_000_000);
    }
}
