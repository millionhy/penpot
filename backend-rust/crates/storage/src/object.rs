//! Database object model and backend names.

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::StorageMetadata;

/// Backend name persisted in `storage_object.backend`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum StorageBackend {
    /// Current filesystem backend.
    Fs,
    /// Current S3 backend.
    S3,
    /// Legacy filesystem row spelling.
    AssetsFs,
    /// Legacy S3 row spelling.
    AssetsS3,
}

impl StorageBackend {
    /// Parse a persisted backend name.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "fs" => Some(Self::Fs),
            "s3" => Some(Self::S3),
            "assets-fs" => Some(Self::AssetsFs),
            "assets-s3" => Some(Self::AssetsS3),
            _ => None,
        }
    }

    /// Persisted spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Fs => "fs",
            Self::S3 => "s3",
            Self::AssetsFs => "assets-fs",
            Self::AssetsS3 => "assets-s3",
        }
    }

    /// Physical implementation, with legacy aliases folded into the current kind.
    #[must_use]
    pub fn kind(self) -> BackendKind {
        match self {
            Self::Fs | Self::AssetsFs => BackendKind::Fs,
            Self::S3 | Self::AssetsS3 => BackendKind::S3,
        }
    }
}

impl std::fmt::Display for StorageBackend {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.as_str())
    }
}

/// Physical backend implementation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum BackendKind {
    /// Local filesystem.
    Fs,
    /// S3-compatible object storage.
    S3,
}

/// `storage_object.status`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ObjectStatus {
    /// Visible to reads, deduplication and GC.
    Valid,
    /// Inserted before the blob write, invisible to normal lifecycle operations.
    Pending,
}

impl ObjectStatus {
    /// Parse the database value.
    #[must_use]
    pub fn from_name(name: &str) -> Option<Self> {
        match name {
            "valid" => Some(Self::Valid),
            "pending" => Some(Self::Pending),
            _ => None,
        }
    }

    /// Database spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Valid => "valid",
            Self::Pending => "pending",
        }
    }
}

/// Logical `storage_object` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageObject {
    /// Object UUID and physical path seed.
    pub id: Uuid,
    /// Blob size in bytes.
    pub size: i64,
    /// Row creation time.
    pub created_at: DateTime<Utc>,
    /// Tombstone/expiry timestamp stored in `deleted_at`.
    pub expired_at: Option<DateTime<Utc>>,
    /// Last reference scan time.
    pub touched_at: Option<DateTime<Utc>>,
    /// Backend persisted with the row.
    pub backend: StorageBackend,
    /// Decoded metadata.
    pub metadata: StorageMetadata,
    /// Write-ahead lifecycle state.
    pub status: ObjectStatus,
    /// Failed physical deletion attempts.
    pub deletion_attempts: u32,
}

impl StorageObject {
    /// Build the row inserted before a blob write.
    #[must_use]
    pub fn new_pending(
        id: Uuid,
        size: i64,
        created_at: DateTime<Utc>,
        backend: StorageBackend,
        metadata: StorageMetadata,
    ) -> Self {
        Self {
            id,
            size,
            created_at,
            expired_at: None,
            touched_at: None,
            backend,
            metadata,
            status: ObjectStatus::Pending,
            deletion_attempts: 0,
        }
    }

    /// Set the expiry/tombstone timestamp.
    #[must_use]
    pub fn with_expired_at(mut self, expired_at: Option<DateTime<Utc>>) -> Self {
        self.expired_at = expired_at;
        self
    }

    /// Set the touched timestamp.
    #[must_use]
    pub fn with_touched_at(mut self, touched_at: Option<DateTime<Utc>>) -> Self {
        self.touched_at = touched_at;
        self
    }

    /// A live row is valid and neither expired nor deleted.
    #[must_use]
    pub fn is_live(&self) -> bool {
        self.status == ObjectStatus::Valid && self.expired_at.is_none()
    }

    /// Data reads allow an expiry strictly later than `now`.
    #[must_use]
    pub fn can_read(&self, now: DateTime<Utc>) -> bool {
        self.expired_at.is_none_or(|expired_at| expired_at > now)
    }
}
