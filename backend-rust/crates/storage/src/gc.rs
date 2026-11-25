//! Pure garbage-collection decisions and the SQL contracts they guard.

use chrono::{DateTime, Duration, Utc};

use crate::{Bucket, ObjectStatus, Result, StorageError};

/// Pending rows older than this are reclaimed.
pub const PENDING_MAX_AGE: Duration = Duration::hours(24);
/// Pending rows processed per transaction.
pub const PENDING_CHUNK_SIZE: usize = 100;
/// Touched rows are evaluated after this delay by default.
pub const TOUCHED_MIN_AGE: Duration = Duration::hours(2);
/// Touched rows processed per batch.
pub const TOUCHED_CHUNK_SIZE: usize = 10;
/// Deleted rows processed per transaction.
pub const DELETED_CHUNK_SIZE: usize = 25;
/// Failed physical deletion attempts before the row is abandoned.
pub const MAX_DELETION_ATTEMPTS: u32 = 7;

/// `sql:get-touched-storage-objects`.
pub const SQL_GET_TOUCHED: &str = "SELECT so.*
  FROM storage_object AS so
 WHERE so.touched_at IS NOT NULL
   AND so.touched_at <= ?
   AND so.status = 'valid'
 ORDER BY touched_at ASC
   FOR UPDATE
  SKIP LOCKED
 LIMIT 10";

/// `sql:get-deleted-chunk`.
pub const SQL_GET_DELETED: &str = "SELECT id, backend
  FROM storage_object
 WHERE deleted_at IS NOT NULL
   AND deleted_at <= ?
   AND status = 'valid'
 ORDER BY deleted_at ASC
 LIMIT ?
   FOR UPDATE
  SKIP LOCKED";

/// `sql:get-pending-sobjects`.
pub const SQL_GET_PENDING: &str = "SELECT id, backend
  FROM storage_object
 WHERE status = 'pending'
   AND created_at <= now() - interval '24 hours'
 ORDER BY created_at ASC
 LIMIT ?
   FOR UPDATE
  SKIP LOCKED";

/// Action chosen for a touched object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GcDecision {
    /// A live reference still points at the object.
    Freeze,
    /// Mark the object deleted.
    Delete,
}

/// Whether a failed physical deletion retries or gives up.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DeletionFailure {
    /// Increment attempts and defer the row by one day.
    Retry {
        /// New attempt count.
        attempts: u32,
        /// New `deleted_at` value.
        defer_until: DateTime<Utc>,
    },
    /// Remove the row after the seventh failed attempt.
    GiveUp,
}

/// Whether a pending row is old enough to reclaim.
#[must_use]
pub fn pending_is_eligible(
    status: ObjectStatus,
    created_at: DateTime<Utc>,
    now: DateTime<Utc>,
) -> bool {
    status == ObjectStatus::Pending && created_at <= pending_cutoff(now)
}

/// Pending GC threshold.
#[must_use]
pub fn pending_cutoff(now: DateTime<Utc>) -> DateTime<Utc> {
    now - PENDING_MAX_AGE
}

/// Touched GC threshold; `skip_delay` uses now.
#[must_use]
pub fn touched_threshold(now: DateTime<Utc>, skip_delay: bool) -> DateTime<Utc> {
    if skip_delay {
        now
    } else {
        now - TOUCHED_MIN_AGE
    }
}

/// Decide a touched object from its bucket and reference probe.
///
/// # Errors
///
/// Returns [`StorageError::UnexpectedUnknownReference`] for compatibility
/// buckets that have no collector case in `gc_touched.clj`.
pub fn decide_touched(bucket: Bucket, has_references: bool) -> Result<GcDecision> {
    match bucket {
        Bucket::FileMediaObject
        | Bucket::TeamFontVariant
        | Bucket::FileObjectThumbnail
        | Bucket::FileThumbnail
        | Bucket::Profile
        | Bucket::FileData => Ok(if has_references {
            GcDecision::Freeze
        } else {
            GcDecision::Delete
        }),
        Bucket::Tempfile | Bucket::UploadSession | Bucket::Organization => Ok(GcDecision::Delete),
        Bucket::FileDataFragment | Bucket::FileChange => {
            Err(StorageError::UnexpectedUnknownReference(bucket.to_string()))
        }
    }
}

/// Classify a failed bulk blob deletion.
#[must_use]
pub fn classify_deletion_failure(attempts: u32, now: DateTime<Utc>) -> DeletionFailure {
    let attempts = attempts.saturating_add(1);
    if attempts >= MAX_DELETION_ATTEMPTS {
        DeletionFailure::GiveUp
    } else {
        DeletionFailure::Retry {
            attempts,
            defer_until: deletion_retry_until(now),
        }
    }
}

/// Failed deletions are retried after one day.
#[must_use]
pub fn deletion_retry_until(now: DateTime<Utc>) -> DateTime<Utc> {
    now + Duration::days(1)
}

/// Poison metadata is deferred exactly one day.
#[must_use]
pub fn poison_defer_until(now: DateTime<Utc>) -> DateTime<Utc> {
    deletion_retry_until(now)
}
