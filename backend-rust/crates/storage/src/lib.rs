//! Penpot object storage, milestone M5 of `backend-rust/PLAN.md`.
//!
//! The crate keeps the three contracts separate:
//!
//! * [`StorageMetadata`] is the closed `storage_object.metadata` schema. Reads
//!   accept legacy Transit verbose and plain JSON; both normalize to the same
//!   typed value.
//! * [`Storage`] implements the write-ahead lifecycle: insert `pending`, write
//!   the blob, promote to `valid`; deduplicate by hash and repair a stale row
//!   under its existing id.
//! * [`ObjectStore`] is the physical boundary with filesystem ([`FsStore`]) and
//!   S3 ([`S3Store`]) implementations.
//!
//! Garbage collection decisions live in the `gc` module as pure functions plus SQL
//! constants. They are intentionally not wired to a database adapter yet: the
//! module has no live PostgreSQL dependency, which keeps the M5 gate offline.

mod content;
mod error;
mod fs;
mod gc;
mod metadata;
mod object;
mod path;
mod repository;
mod s3;
mod service;
mod store;

pub use content::{
    calculate_hash, calculate_hash_bytes, calculate_hash_reader, Content, ContentSource,
    HASH_PREFIX,
};
pub use error::{Result, StorageError};
pub use fs::FsStore;
pub use gc::{
    classify_deletion_failure, decide_touched, pending_cutoff, pending_is_eligible,
    poison_defer_until, touched_threshold, DeletionFailure, GcDecision, DELETED_CHUNK_SIZE,
    MAX_DELETION_ATTEMPTS, PENDING_CHUNK_SIZE, PENDING_MAX_AGE, SQL_GET_DELETED, SQL_GET_PENDING,
    SQL_GET_TOUCHED, TOUCHED_CHUNK_SIZE, TOUCHED_MIN_AGE,
};
pub use metadata::{
    is_transit_encoded, AssetAccess, Bucket, MetadataEncoding, StorageMetadata, DEFAULT_BUCKET,
    TEMPFILE_BUCKET, UPLOAD_SESSION_BUCKET,
};
pub use object::{BackendKind, ObjectStatus, StorageBackend, StorageObject};
pub use path::{
    fs_object_path, fs_object_url, fs_redirect_path, id_to_relative_path, object_to_relative_path,
};
pub use repository::{MemoryRepository, StorageRepository};
pub use s3::{s3_key, S3Config, S3Store};
pub use service::{
    default_url_max_age, Clock, DedupOutcome, FixedClock, PutParams, PutResult, Storage,
    SystemClock,
};
pub use store::{ObjectStore, UrlOptions};
