//! Storage lifecycle operations over repository and object-store boundaries.

use std::{collections::BTreeMap, sync::Arc, time::Duration};

use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{
    object_to_relative_path, BackendKind, Content, ObjectStatus, ObjectStore, Result,
    StorageBackend, StorageError, StorageMetadata, StorageObject, StorageRepository, UrlOptions,
};

/// Clock used by lifecycle operations; deterministic tests inject a fixed clock.
pub trait Clock: Send + Sync {
    /// Current time.
    fn now(&self) -> DateTime<Utc>;
}

/// System clock.
#[derive(Debug, Clone, Copy, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now(&self) -> DateTime<Utc> {
        Utc::now()
    }
}

/// Fixed clock for tests and replays.
#[derive(Debug, Clone, Copy)]
pub struct FixedClock {
    now: DateTime<Utc>,
}

impl FixedClock {
    /// Freeze time at `now`.
    #[must_use]
    pub fn new(now: DateTime<Utc>) -> Self {
        Self { now }
    }
}

impl Clock for FixedClock {
    fn now(&self) -> DateTime<Utc> {
        self.now
    }
}

/// Parameters for `put-object!`.
#[derive(Debug, Clone)]
pub struct PutParams {
    /// Blob bytes.
    pub content: Content,
    /// Validated metadata.
    pub metadata: StorageMetadata,
    /// Optional explicit id.
    pub id: Option<Uuid>,
    /// Stored as the tombstone column (`expired-at` in the Clojure model).
    pub expired_at: Option<DateTime<Utc>>,
    /// Explicit touched timestamp.
    pub touched_at: Option<DateTime<Utc>>,
    /// Whether to set `touched_at` to now when absent.
    pub touch: bool,
    /// Whether hash deduplication is allowed.
    pub deduplicate: bool,
    /// Backend override.
    pub backend: Option<StorageBackend>,
}

impl PutParams {
    /// Build parameters with content and metadata.
    #[must_use]
    pub fn new(content: Content, metadata: StorageMetadata) -> Self {
        Self {
            content,
            metadata,
            id: None,
            expired_at: None,
            touched_at: None,
            touch: false,
            deduplicate: false,
            backend: None,
        }
    }

    /// Set explicit content.
    #[must_use]
    pub fn content(mut self, content: Content) -> Self {
        self.content = content;
        self
    }

    /// Set an explicit object id.
    #[must_use]
    pub fn id(mut self, id: Uuid) -> Self {
        self.id = Some(id);
        self
    }

    /// Set an expiry/tombstone timestamp.
    #[must_use]
    pub fn expired_at(mut self, expired_at: Option<DateTime<Utc>>) -> Self {
        self.expired_at = expired_at;
        self
    }

    /// Set an explicit touched timestamp.
    #[must_use]
    pub fn touched_at(mut self, touched_at: Option<DateTime<Utc>>) -> Self {
        self.touched_at = touched_at;
        self
    }

    /// Enable or disable automatic touch.
    #[must_use]
    pub fn touch(mut self, touch: bool) -> Self {
        self.touch = touch;
        self
    }

    /// Enable or disable deduplication.
    #[must_use]
    pub fn deduplicate(mut self, deduplicate: bool) -> Self {
        self.deduplicate = deduplicate;
        self
    }

    /// Override the backend for this write.
    #[must_use]
    pub fn backend(mut self, backend: StorageBackend) -> Self {
        self.backend = Some(backend);
        self
    }
}

/// Deduplication outcome.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DedupOutcome {
    /// Existing live blob reused.
    Hit,
    /// Existing row kept and its missing blob rewritten.
    Repair,
    /// Deduplication ran but found no row.
    Miss,
    /// No lookup was attempted.
    Skip,
}

/// Result of a put.
#[derive(Debug, Clone)]
pub struct PutResult {
    /// Persisted object.
    pub object: StorageObject,
    /// Deduplication result.
    pub dedup: DedupOutcome,
}

/// Storage lifecycle service.
pub struct Storage<R: StorageRepository> {
    repository: Arc<R>,
    stores: BTreeMap<BackendKind, Arc<dyn ObjectStore>>,
    default_backend: StorageBackend,
    clock: Arc<dyn Clock>,
}

impl<R: StorageRepository> Storage<R> {
    /// Build a service with one object store.
    #[must_use]
    pub fn new(
        repository: R,
        default_backend: StorageBackend,
        store: Arc<dyn ObjectStore>,
    ) -> Self {
        let mut stores = BTreeMap::new();
        stores.insert(store.backend_kind(), store);
        Self {
            repository: Arc::new(repository),
            stores,
            default_backend,
            clock: Arc::new(SystemClock),
        }
    }

    /// Register another object-store implementation.
    #[must_use]
    pub fn with_store(mut self, store: Arc<dyn ObjectStore>) -> Self {
        self.stores.insert(store.backend_kind(), store);
        self
    }

    /// Replace the clock.
    #[must_use]
    pub fn with_clock(mut self, clock: Arc<dyn Clock>) -> Self {
        self.clock = clock;
        self
    }

    /// Repository handle, for tests and adapters.
    #[must_use]
    pub fn repository(&self) -> &Arc<R> {
        &self.repository
    }

    /// Create or deduplicate an object.
    ///
    /// # Errors
    ///
    /// Returns [`StorageError::InvalidMetadata`] before any write when the
    /// bucket requirements are missing, a backend error when the blob write
    /// fails, or a repository error when persistence fails. A failed blob
    /// write leaves the inserted row in `pending` state.
    pub async fn put(&self, params: PutParams) -> Result<PutResult> {
        let backend = params.backend.unwrap_or(self.default_backend);
        let store = self.store(backend.kind())?;
        let now = self.clock.now();

        let mut metadata = params.metadata;
        if let Some(hash) = params.content.precomputed_hash() {
            metadata.hash = Some(hash.to_owned());
        }
        metadata.validate()?;
        let touched_at = if params.touch {
            Some(params.touched_at.unwrap_or(now))
        } else {
            params.touched_at
        };
        let deduplicable =
            params.deduplicate && metadata.hash.is_some() && metadata.is_deduplicable();

        let hit = match (deduplicable, metadata.hash.as_deref()) {
            (true, Some(hash)) => {
                self.repository
                    .find_dedup(backend, metadata.bucket.as_str(), hash)
                    .await?
            }
            _ => None,
        };

        if let Some(mut object) = hit {
            if store.exists(object.id).await? {
                if params.touch && touched_at.is_some() {
                    let changed = self.repository.set_touched(object.id, touched_at).await?;
                    if changed {
                        object.touched_at = touched_at;
                    }
                }
                return Ok(PutResult {
                    object,
                    dedup: DedupOutcome::Hit,
                });
            }

            store.put(&object, &params.content).await?;
            self.repository.promote(object.id).await?;
            object.status = ObjectStatus::Valid;
            return Ok(PutResult {
                object,
                dedup: DedupOutcome::Repair,
            });
        }

        let id = params.id.unwrap_or_else(Uuid::new_v4);
        let size = params.content.size()?;
        let mut object = StorageObject::new_pending(id, size, now, backend, metadata)
            .with_expired_at(params.expired_at)
            .with_touched_at(touched_at);
        self.repository.insert(&object).await?;
        store.put(&object, &params.content).await?;
        self.repository.promote(object.id).await?;
        object.status = ObjectStatus::Valid;

        Ok(PutResult {
            object,
            dedup: if deduplicable {
                DedupOutcome::Miss
            } else {
                DedupOutcome::Skip
            },
        })
    }

    /// Fetch a live, valid object.
    ///
    /// # Errors
    ///
    /// Propagates repository failures.
    pub async fn get_object(&self, id: Uuid) -> Result<Option<StorageObject>> {
        self.repository.get_valid(id).await
    }

    /// Read object bytes unless the expiry is at or before now.
    ///
    /// # Errors
    ///
    /// Propagates backend failures.
    pub async fn get_data(&self, object: &StorageObject) -> Result<Option<Vec<u8>>> {
        if !object.can_read(self.clock.now()) {
            return Ok(None);
        }
        self.store(object.backend.kind())?
            .get_bytes(object.id)
            .await
            .map(Some)
    }

    /// Produce a browser-facing URL unless the object is expired.
    ///
    /// # Errors
    ///
    /// Propagates backend failures.
    pub async fn get_url(
        &self,
        object: &StorageObject,
        options: &UrlOptions,
    ) -> Result<Option<String>> {
        if !object.can_read(self.clock.now()) {
            return Ok(None);
        }
        self.store(object.backend.kind())?
            .url(object.id, options)
            .await
            .map(Some)
    }

    /// Local path for the filesystem redirect contract, unless expired.
    #[must_use]
    pub fn get_path(&self, object: &StorageObject) -> Option<std::path::PathBuf> {
        if !object.can_read(self.clock.now()) {
            return None;
        }
        self.stores
            .get(&object.backend.kind())
            .and_then(|store| store.local_path(object.id))
    }

    /// Relative object path (`object->relative-path`).
    #[must_use]
    pub fn relative_path(&self, object: &StorageObject) -> String {
        object_to_relative_path(object)
    }

    /// Set `touched_at` to now.
    ///
    /// # Errors
    ///
    /// Propagates repository failures.
    pub async fn touch(&self, id: Uuid) -> Result<bool> {
        self.repository
            .set_touched(id, Some(self.clock.now()))
            .await
    }

    /// Soft-delete a live row.
    ///
    /// # Errors
    ///
    /// Propagates repository failures.
    pub async fn delete(&self, id: Uuid) -> Result<bool> {
        self.repository.soft_delete(id, self.clock.now()).await
    }

    fn store(&self, kind: BackendKind) -> Result<&Arc<dyn ObjectStore>> {
        self.stores.get(&kind).ok_or_else(|| {
            let name = match kind {
                BackendKind::Fs => "fs",
                BackendKind::S3 => "s3",
            };
            StorageError::BackendNotConfigured(name.to_owned())
        })
    }
}

/// Default presigned URL lifetime (`10m`).
#[must_use]
pub fn default_url_max_age() -> Duration {
    Duration::from_mins(10)
}
