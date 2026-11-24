//! Runner loop: pop one payload, revalidate it against PostgreSQL and execute.

use std::{sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::{
    decode_payload, HandlerResult, Result, TaskQueue, TaskRegistry, TaskRepository, TaskStatus,
};

/// Redis BLPOP timeout used by every runner.
pub const RUNNER_QUEUE_TIMEOUT: Duration = Duration::from_secs(5);

/// Runtime settings for one runner instance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RunnerConfig {
    /// Tenant-prefixed queue name.
    pub queue: String,
    /// Stable runner id used in logs.
    pub id: String,
    /// Queue pop timeout.
    pub pop_timeout: Duration,
    /// Sleep before retrying after a repository or queue error.
    pub error_backoff: Duration,
}

impl Default for RunnerConfig {
    fn default() -> Self {
        Self {
            queue: "default:default".into(),
            id: "default/0".into(),
            pop_timeout: RUNNER_QUEUE_TIMEOUT,
            error_backoff: Duration::from_secs(1),
        }
    }
}

/// Outcome of one Redis message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessOutcome {
    /// Payload or row no longer applies.
    Ignored,
    /// Scheduled timestamp changed after dispatch.
    Skipped,
    /// Task completed.
    Completed,
    /// Terminal failure was persisted.
    Failed,
    /// Retry was persisted.
    Retried,
}

/// Runner over repository, queue and handler registry boundaries.
pub struct Runner<R, Q> {
    repository: Arc<R>,
    queue: Arc<Q>,
    registry: TaskRegistry,
    config: RunnerConfig,
}

impl<R, Q> Clone for Runner<R, Q> {
    fn clone(&self) -> Self {
        Self {
            repository: Arc::clone(&self.repository),
            queue: Arc::clone(&self.queue),
            registry: self.registry.clone(),
            config: self.config.clone(),
        }
    }
}

impl<R, Q> Runner<R, Q>
where
    R: TaskRepository,
    Q: TaskQueue,
{
    /// Create a runner.
    #[must_use]
    pub fn new(
        repository: Arc<R>,
        queue: Arc<Q>,
        registry: TaskRegistry,
        config: RunnerConfig,
    ) -> Self {
        Self {
            repository,
            queue,
            registry,
            config,
        }
    }

    /// Process one payload at an explicit instant.
    ///
    /// # Errors
    ///
    /// Returns a payload, repository or handler-persistence error. Handler
    /// failures become retry or failed rows and are not returned as errors.
    pub async fn process_payload_at(
        &self,
        payload: &str,
        now: DateTime<Utc>,
    ) -> Result<ProcessOutcome> {
        let message = decode_payload(payload)?;
        let Some(mut task) = self.repository.get(message.id).await? else {
            tracing::warn!(
                runner_id = %self.config.id,
                task_id = %message.id,
                "task row no longer exists"
            );
            return Ok(ProcessOutcome::Ignored);
        };

        if task.scheduled_millis() != message.scheduled_at.timestamp_millis() {
            tracing::warn!(
                runner_id = %self.config.id,
                task_id = %message.id,
                "skip stale task message"
            );
            return Ok(ProcessOutcome::Skipped);
        }

        if !self.repository.mark_running(task.id, now).await? {
            return Ok(ProcessOutcome::Ignored);
        }
        task.status = TaskStatus::Running;
        task.modified_at = now;

        let result = if let Some(handler) = self.registry.get(&task.name) {
            match handler.handle(&task).await {
                Ok(result) => result,
                Err(failure) => {
                    task.apply_failure(&failure, now);
                    self.repository.save(&task).await?;
                    return Ok(match task.status {
                        TaskStatus::Failed => ProcessOutcome::Failed,
                        _ => ProcessOutcome::Retried,
                    });
                }
            }
        } else {
            tracing::warn!(
                runner_id = %self.config.id,
                task_id = %task.id,
                task = %task.name,
                "no task handler found"
            );
            HandlerResult::Completed
        };

        task.apply_result(result, now);
        self.repository.save(&task).await?;
        Ok(match task.status {
            TaskStatus::Completed => ProcessOutcome::Completed,
            TaskStatus::Retry => ProcessOutcome::Retried,
            TaskStatus::Failed => ProcessOutcome::Failed,
            _ => ProcessOutcome::Ignored,
        })
    }

    /// Process one payload using the system clock.
    ///
    /// # Errors
    ///
    /// Returns the same errors as [`Self::process_payload_at`].
    pub async fn process_payload(&self, payload: &str) -> Result<ProcessOutcome> {
        self.process_payload_at(payload, Utc::now()).await
    }

    /// Pop and process at most one Redis message.
    ///
    /// # Errors
    ///
    /// Returns a queue error or any error raised by payload processing.
    pub async fn run_once(&self) -> Result<Option<ProcessOutcome>> {
        let key = format!("penpot.worker.queue:{}", self.config.queue);
        let Some(payload) = self.queue.pop(&key, self.config.pop_timeout).await? else {
            return Ok(None);
        };
        self.process_payload(&payload).await.map(Some)
    }

    /// Poll until `shutdown` changes.
    ///
    /// # Errors
    ///
    /// Returns the first error raised outside the retry loop. Errors inside
    /// the loop are logged and followed by a backoff.
    pub async fn run_loop(&self, mut shutdown: watch::Receiver<bool>) -> Result<()> {
        while !*shutdown.borrow() {
            match self.run_once().await {
                Ok(Some(_) | None) => {}
                Err(error) => {
                    tracing::error!(runner_id = %self.config.id, %error, "worker runner failed");
                    tokio::select! {
                        () = tokio::time::sleep(self.config.error_backoff) => {}
                        result = shutdown.changed() => {
                            if result.is_err() || *shutdown.borrow() {
                                break;
                            }
                        }
                    }
                }
            }
        }
        Ok(())
    }

    /// Spawn `parallelism` independent loops.
    #[must_use]
    pub fn spawn_pool(
        self,
        parallelism: usize,
        shutdown: watch::Receiver<bool>,
    ) -> Vec<JoinHandle<()>>
    where
        R: 'static,
        Q: 'static,
    {
        (0..parallelism)
            .map(|_| {
                let runner = self.clone();
                let shutdown = shutdown.clone();
                tokio::spawn(async move {
                    if let Err(error) = runner.run_loop(shutdown).await {
                        tracing::error!(
                            runner_id = %runner.config.id,
                            %error,
                            "worker runner loop stopped"
                        );
                    }
                })
            })
            .collect()
    }
}
