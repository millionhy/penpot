//! Structured storage failures.

use std::path::PathBuf;

use thiserror::Error;
use uuid::Uuid;

/// A storage-layer failure.
#[derive(Debug, Error)]
pub enum StorageError {
    /// Metadata does not satisfy the closed schema.
    #[error("invalid storage object metadata: {message}")]
    InvalidMetadata {
        /// Why validation failed.
        message: String,
    },
    /// A backend name is not one of the four accepted spellings.
    #[error("invalid storage backend: {0}")]
    InvalidBackend(String),
    /// No object store is registered for the requested physical backend.
    #[error("storage backend is not configured: {0}")]
    BackendNotConfigured(String),
    /// The logical object has no readable blob.
    #[error("storage object not found: {0}")]
    ObjectNotFound(Uuid),
    /// A remote storage operation failed.
    #[error("storage backend {operation} failed for {object_id}: {message}")]
    Backend {
        /// Operation name.
        operation: &'static str,
        /// Object being operated on.
        object_id: Uuid,
        /// Provider or transport message.
        message: String,
    },
    /// A local filesystem operation failed.
    #[error("storage I/O {operation} failed for {path}: {message}")]
    Io {
        /// Operation name.
        operation: &'static str,
        /// Affected path.
        path: PathBuf,
        /// Operating-system message.
        message: String,
    },
    /// A content hash cannot be produced for this source.
    #[error("content hash failed: {0}")]
    ContentHash(String),
    /// A repository adapter failed.
    #[error("storage repository failed: {0}")]
    Repository(String),
    /// Configuration is missing a required value.
    #[error("storage configuration is invalid: {0}")]
    Configuration(String),
    /// The touched-object collector has no rule for the bucket.
    #[error("unexpected unknown storage reference bucket: {0}")]
    UnexpectedUnknownReference(String),
}

/// Crate result alias.
pub type Result<T> = std::result::Result<T, StorageError>;

pub(crate) fn io_error(
    operation: &'static str,
    path: &std::path::Path,
    error: &std::io::Error,
) -> StorageError {
    StorageError::Io {
        operation,
        path: path.to_path_buf(),
        message: error.to_string(),
    }
}
