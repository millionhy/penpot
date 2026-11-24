//! Repository boundary for `storage_object` persistence.

use std::{collections::BTreeMap, sync::Arc};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{Result, StorageBackend, StorageError, StorageObject};

/// Persistence operations required by the storage service.
#[async_trait]
pub trait StorageRepository: Send + Sync {
    /// Fetch a live, valid row by id.
    async fn get_valid(&self, id: Uuid) -> Result<Option<StorageObject>>;

    /// Find a live, valid row matching the exact backend/bucket/hash tuple.
    async fn find_dedup(
        &self,
        backend: StorageBackend,
        bucket: &str,
        hash: &str,
    ) -> Result<Option<StorageObject>>;

    /// Insert a pending row.
    async fn insert(&self, object: &StorageObject) -> Result<()>;

    /// Set `status = 'valid'`.
    async fn promote(&self, id: Uuid) -> Result<bool>;

    /// Set or clear `touched_at`.
    async fn set_touched(&self, id: Uuid, touched_at: Option<DateTime<Utc>>) -> Result<bool>;

    /// Soft-delete a row whose `deleted_at` is still null.
    async fn soft_delete(&self, id: Uuid, deleted_at: DateTime<Utc>) -> Result<bool>;
}

/// In-memory repository used by service tests and offline integrations.
#[derive(Clone, Default)]
pub struct MemoryRepository {
    rows: Arc<std::sync::Mutex<BTreeMap<Uuid, StorageObject>>>,
}

impl MemoryRepository {
    /// All rows in UUID order.
    #[must_use]
    pub fn objects(&self) -> Vec<StorageObject> {
        self.lock().values().cloned().collect()
    }

    /// Number of rows.
    #[must_use]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Whether the repository is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    /// Fetch any row, including pending or deleted ones.
    #[must_use]
    pub fn get_any(&self, id: Uuid) -> Option<StorageObject> {
        self.lock().get(&id).cloned()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, BTreeMap<Uuid, StorageObject>> {
        self.rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl StorageRepository for MemoryRepository {
    async fn get_valid(&self, id: Uuid) -> Result<Option<StorageObject>> {
        Ok(self.lock().get(&id).filter(|row| row.is_live()).cloned())
    }

    async fn find_dedup(
        &self,
        backend: StorageBackend,
        bucket: &str,
        hash: &str,
    ) -> Result<Option<StorageObject>> {
        Ok(self
            .lock()
            .values()
            .find(|row| {
                row.is_live()
                    && row.backend == backend
                    && row.metadata.bucket.as_str() == bucket
                    && row.metadata.hash.as_deref() == Some(hash)
            })
            .cloned())
    }

    async fn insert(&self, object: &StorageObject) -> Result<()> {
        let mut rows = self.lock();
        if rows.insert(object.id, object.clone()).is_some() {
            return Err(StorageError::Repository(format!(
                "duplicate storage object {}",
                object.id
            )));
        }
        Ok(())
    }

    async fn promote(&self, id: Uuid) -> Result<bool> {
        let mut rows = self.lock();
        let Some(row) = rows.get_mut(&id) else {
            return Ok(false);
        };
        row.status = crate::ObjectStatus::Valid;
        Ok(true)
    }

    async fn set_touched(&self, id: Uuid, touched_at: Option<DateTime<Utc>>) -> Result<bool> {
        let mut rows = self.lock();
        let Some(row) = rows.get_mut(&id) else {
            return Ok(false);
        };
        row.touched_at = touched_at;
        Ok(true)
    }

    async fn soft_delete(&self, id: Uuid, deleted_at: DateTime<Utc>) -> Result<bool> {
        let mut rows = self.lock();
        let Some(row) = rows.get_mut(&id) else {
            return Ok(false);
        };
        if row.expired_at.is_some() {
            return Ok(false);
        }
        row.expired_at = Some(deleted_at);
        Ok(true)
    }
}
