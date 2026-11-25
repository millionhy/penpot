//! Penpot background tasks, milestone M6 of `backend-rust/PLAN.md`.
//!
//! The crate is split along four boundaries:
//!
//! * [`CronExpression`] parses the Quartz syntax used by `#penpot/cron` and
//!   computes the next matching instant.
//! * [`Task`] owns the persisted row shape and the retry/status transitions.
//! * [`TaskRepository`] and [`TaskQueue`] isolate PostgreSQL and Redis.
//! * [`Dispatcher`] and [`Runner`] orchestrate claiming and execution without
//!   depending on live services, so the full workflow is testable in memory.
//!
//! `task.props` is Transit JSON stored as JSONB. The worker does not touch
//! Fressian file data (`PLAN.md` section 6).

pub mod cron;
pub mod dispatcher;
pub mod error;
pub mod handler;
pub mod queue;
pub mod repository;
pub mod runner;
pub mod task;
pub mod tasks;

pub use cron::{validate_penpot_entries, CronEntry, CronExpression};
pub use dispatcher::{
    decode_payload, encode_payload, BatchOutcome, ClaimedTask, Dispatcher, DispatcherConfig,
    QueueRef, TaskMessage, BATCH_SIZE, DISPATCHER_TIMEOUT, LOST_TASK_AFTER, ORPHAN_AFTER,
    SQL_CLEAN_ORPHAN, SQL_MARK_TASK_SCHEDULED, SQL_RESCHEDULE_LOST, SQL_SELECT_NEXT_TASKS,
    WAIT_DURATION,
};
pub use error::{Result, ServiceError, WorkerError};
pub use handler::{
    penpot_registry, Mailer, ObjectsGc, PenpotTaskServices, SessionGc, TaskHandler, TaskRegistry,
    TasksGc, WebhookRunner,
};
pub use queue::RedisTaskQueue;
pub use repository::{TaskQueue, TaskRepository};
pub use runner::{ProcessOutcome, Runner, RunnerConfig, RUNNER_QUEUE_TIMEOUT};
pub use task::{
    task_queue, HandlerFailure, HandlerResult, SubmitOptions, Task, TaskStatus,
    DEFAULT_MAX_RETRIES, DEFAULT_PRIORITY, DEFAULT_QUEUE, DEFAULT_RETRY_DELAY, SQL_INSERT_NEW_TASK,
    SQL_REMOVE_NOT_STARTED_TASKS,
};
pub use tasks::{
    PENPOT_TASK_NAMES, SQL_OBJECTS_GC_DELETE_CHUNKS, SQL_OBJECTS_GC_UPLOAD_SESSIONS,
    SQL_SESSION_GC, SQL_TASKS_GC, SQL_WEBHOOK_DELIVERY, SQL_WEBHOOK_ERROR, SQL_WEBHOOK_SUCCESS,
    TASK_OBJECTS_GC, TASK_RUN_WEBHOOK, TASK_SENDMAIL, TASK_SESSION_GC, TASK_TASKS_GC,
};
