//! Worker errors shared by repositories, queues and handlers.

/// Result type used by the worker crate.
pub type Result<T> = std::result::Result<T, WorkerError>;

/// Failure discovered before a task can reach a handler.
#[derive(Debug, thiserror::Error)]
pub enum WorkerError {
    /// Quartz expression is malformed or unsupported.
    #[error("invalid cron expression `{expr}`: {reason}")]
    InvalidCron {
        /// Original expression.
        expr: String,
        /// Human-readable parser reason.
        reason: String,
    },

    /// Redis payload is not the expected Transit vector.
    #[error("invalid task payload: {0}")]
    InvalidPayload(String),

    /// A persisted status is outside the six values used by the backend.
    #[error("invalid task status: {0}")]
    InvalidStatus(String),

    /// PostgreSQL adapter failed.
    #[error("task repository: {0}")]
    Repository(String),

    /// Redis adapter failed.
    #[error("task queue: {0}")]
    Queue(String),

    /// A task name was requested from an empty registry.
    #[error("task `{0}` is not registered")]
    MissingTask(String),
}

impl WorkerError {
    /// Build a repository error without exposing sqlx types in this crate.
    #[must_use]
    pub fn repository(error: impl std::fmt::Display) -> Self {
        Self::Repository(error.to_string())
    }

    /// Build a queue error without exposing Redis types in this crate.
    #[must_use]
    pub fn queue(error: impl std::fmt::Display) -> Self {
        Self::Queue(error.to_string())
    }
}

/// Error returned by a task service.
///
/// The runner treats every service error as a task failure. The task retries
/// until `max_retries`, matching the Clojure runner.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{message}")]
pub struct ServiceError {
    message: String,
}

impl ServiceError {
    /// Create a service error with a stable message.
    #[must_use]
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    /// Error text persisted in `task.error`.
    #[must_use]
    pub fn message(&self) -> &str {
        &self.message
    }
}
