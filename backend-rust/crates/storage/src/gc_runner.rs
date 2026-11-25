//! Batch drivers for the three storage GC tasks.
//!
//! `app.storage.pending-gc`, `app.storage.gc-touched` and
//! `app.storage.gc-deleted` keep the decisions in the `gc` namespace and the
//! SQL in the adapter. This module keeps the same split: it drives chunks
//! through [`GcTransaction`], asks [`decide_touched`] for each row and leaves
//! blob removal to [`ObjectStore`].

use std::{
    collections::{BTreeMap, BTreeSet},
    sync::Arc,
};

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use uuid::Uuid;

use crate::{
    decide_touched, deletion_retry_until, pending_cutoff, poison_defer_until, touched_threshold,
    BackendKind, Clock, GcDecision, ObjectStore, Result, StorageBackend, StorageObject,
    SystemClock, DELETED_CHUNK_SIZE, MAX_DELETION_ATTEMPTS, PENDING_CHUNK_SIZE, TOUCHED_CHUNK_SIZE,
};

/// One row reserved by a pending or deleted scan.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct GcItem {
    /// `storage_object.id`.
    pub id: Uuid,
    /// Persisted backend spelling.
    pub backend: StorageBackend,
}

/// Rows returned by a touched scan.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct TouchedChunk {
    /// Rows whose metadata decoded.
    pub objects: Vec<StorageObject>,
    /// Rows whose metadata could not be decoded; they must be deferred.
    pub poison: Vec<Uuid>,
}

/// Counters for one GC pass.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct GcReport {
    /// Pending rows removed.
    pub pending_removed: u64,
    /// Touched rows frozen because a live reference still exists.
    pub frozen: u64,
    /// Touched rows marked deleted.
    pub marked_deleted: u64,
    /// Deleted rows and blobs removed.
    pub deleted: u64,
    /// Rows deferred because their metadata did not decode.
    pub poisoned: u64,
    /// Rows abandoned after repeated blob deletion failures.
    pub abandoned: u64,
    /// Blob deletions that failed and were deferred.
    pub blob_failures: u64,
}

impl GcReport {
    /// Add another pass into this one.
    pub fn merge(&mut self, other: Self) {
        self.pending_removed += other.pending_removed;
        self.frozen += other.frozen;
        self.marked_deleted += other.marked_deleted;
        self.deleted += other.deleted;
        self.poisoned += other.poisoned;
        self.abandoned += other.abandoned;
        self.blob_failures += other.blob_failures;
    }
}

/// SQL operations required for one GC transaction.
///
/// Dropping the transaction without calling [`commit`](GcTransaction::commit)
/// rolls it back.
#[async_trait]
pub trait GcTransaction: Send {
    /// Reserve pending rows older than `cutoff`.
    async fn pending_chunk(&mut self, cutoff: DateTime<Utc>, limit: usize) -> Result<Vec<GcItem>>;

    /// Delete reserved pending rows.
    async fn delete_pending(&mut self, ids: &[Uuid]) -> Result<u64>;

    /// Reserve touched rows at or before `threshold`.
    async fn touched_chunk(
        &mut self,
        threshold: DateTime<Utc>,
        limit: usize,
    ) -> Result<TouchedChunk>;

    /// Whether a live domain row still references the object.
    async fn has_references(&mut self, object: &StorageObject) -> Result<bool>;

    /// Clear `touched_at`.
    async fn freeze(&mut self, ids: &[Uuid]) -> Result<u64>;

    /// Set `deleted_at` and clear `touched_at`.
    async fn mark_deleted(&mut self, ids: &[Uuid], deleted_at: DateTime<Utc>) -> Result<u64>;

    /// Move `touched_at` forward.
    async fn defer_touched(&mut self, ids: &[Uuid], until: DateTime<Utc>) -> Result<u64>;

    /// Reserve deleted rows at or before `cutoff`.
    async fn deleted_chunk(&mut self, cutoff: DateTime<Utc>, limit: usize) -> Result<Vec<GcItem>>;

    /// Re-lock rows and return the ones this transaction owns.
    async fn lock_rows(&mut self, ids: &[Uuid]) -> Result<Vec<Uuid>>;

    /// Remove chunk mappings before the storage rows (`NO ACTION` keys).
    async fn delete_upload_session_chunks(&mut self, ids: &[Uuid]) -> Result<u64>;

    /// Delete storage rows.
    async fn delete_rows(&mut self, ids: &[Uuid]) -> Result<u64>;

    /// Increment `deletion_attempts` and defer the tombstone by one day.
    async fn defer_deleted(&mut self, ids: &[Uuid], until: DateTime<Utc>) -> Result<u64>;

    /// Delete rows whose attempt count reached `max_attempts`.
    async fn give_up(&mut self, ids: &[Uuid], max_attempts: u32) -> Result<u64>;

    /// Commit the transaction.
    async fn commit(self: Box<Self>) -> Result<()>;
}

/// Opens GC transactions.
#[async_trait]
pub trait GcRepository: Send + Sync {
    /// Begin a transaction.
    async fn begin(&self) -> Result<Box<dyn GcTransaction>>;
}

/// Drives the three GC phases over a repository and object stores.
pub struct StorageGc<R: GcRepository> {
    repository: Arc<R>,
    stores: BTreeMap<BackendKind, Arc<dyn ObjectStore>>,
    clock: Arc<dyn Clock>,
    pending_limit: usize,
    touched_limit: usize,
    deleted_limit: usize,
}

impl<R: GcRepository> StorageGc<R> {
    /// Build a runner with one object store.
    #[must_use]
    pub fn new(repository: R, store: Arc<dyn ObjectStore>) -> Self {
        let mut stores = BTreeMap::new();
        stores.insert(store.backend_kind(), store);
        Self {
            repository: Arc::new(repository),
            stores,
            clock: Arc::new(SystemClock),
            pending_limit: PENDING_CHUNK_SIZE,
            touched_limit: TOUCHED_CHUNK_SIZE,
            deleted_limit: DELETED_CHUNK_SIZE,
        }
    }

    /// Register another object store.
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

    /// Override chunk sizes.
    #[must_use]
    pub fn with_limits(mut self, pending: usize, touched: usize, deleted: usize) -> Self {
        self.pending_limit = pending;
        self.touched_limit = touched;
        self.deleted_limit = deleted;
        self
    }

    /// Run pending, touched and deleted phases in order.
    ///
    /// # Errors
    ///
    /// Propagates repository failures and unknown touched buckets.
    pub async fn run_all(&self, skip_delay: bool) -> Result<GcReport> {
        let mut report = self.run_pending().await?;
        report.merge(self.run_touched(skip_delay).await?);
        report.merge(self.run_deleted().await?);
        Ok(report)
    }

    /// Reclaim pending rows whose blob write never finished.
    ///
    /// Rows are removed in one transaction and their blobs afterwards, so a
    /// blob failure leaves only an orphan, never a visible row.
    ///
    /// # Errors
    ///
    /// Propagates repository failures. Blob failures are counted, not raised.
    pub async fn run_pending(&self) -> Result<GcReport> {
        let mut report = GcReport::default();
        loop {
            let chunk = {
                let mut tx = self.repository.begin().await?;
                let cutoff = pending_cutoff(self.clock.now());
                let chunk = tx.pending_chunk(cutoff, self.pending_limit).await?;
                if chunk.is_empty() {
                    tx.commit().await?;
                    break;
                }
                let ids: Vec<Uuid> = chunk.iter().map(|item| item.id).collect();
                tx.delete_pending(&ids).await?;
                tx.commit().await?;
                chunk
            };

            report.pending_removed += chunk.len() as u64;
            let failed = self.delete_blobs(&chunk).await;
            report.blob_failures += failed.len() as u64;
        }
        Ok(report)
    }

    /// Evaluate touched rows and freeze or mark them deleted.
    ///
    /// Poison rows are deferred by one day in their own transaction before the
    /// healthy rows are processed, matching `app.storage.gc-touched`.
    ///
    /// # Errors
    ///
    /// Propagates repository failures and
    /// [`StorageError::UnexpectedUnknownReference`](crate::StorageError::UnexpectedUnknownReference)
    /// for compatibility buckets.
    pub async fn run_touched(&self, skip_delay: bool) -> Result<GcReport> {
        let threshold = touched_threshold(self.clock.now(), skip_delay);
        let mut report = GcReport::default();
        loop {
            let chunk = {
                let mut tx = self.repository.begin().await?;
                let chunk = tx.touched_chunk(threshold, self.touched_limit).await?;
                if chunk.objects.is_empty() && chunk.poison.is_empty() {
                    tx.commit().await?;
                    break;
                }
                if !chunk.poison.is_empty() {
                    let until = poison_defer_until(self.clock.now());
                    tx.defer_touched(&chunk.poison, until).await?;
                    report.poisoned += chunk.poison.len() as u64;
                }
                tx.commit().await?;
                chunk
            };

            if chunk.objects.is_empty() {
                continue;
            }

            let now = self.clock.now();
            let mut freeze = Vec::new();
            let mut delete = Vec::new();
            let mut tx = self.repository.begin().await?;
            for object in &chunk.objects {
                let has_references = tx.has_references(object).await?;
                match decide_touched(object.metadata.bucket, has_references)? {
                    GcDecision::Freeze => freeze.push(object.id),
                    GcDecision::Delete => delete.push(object.id),
                }
            }
            if !freeze.is_empty() {
                report.frozen += tx.freeze(&freeze).await?;
            }
            if !delete.is_empty() {
                report.marked_deleted += tx.mark_deleted(&delete, now).await?;
            }
            tx.commit().await?;
        }
        Ok(report)
    }

    /// Physically delete tombstones and their blobs.
    ///
    /// A failed blob deletion increments `deletion_attempts`, defers the row
    /// by one day and gives up after [`MAX_DELETION_ATTEMPTS`].
    ///
    /// # Errors
    ///
    /// Propagates repository failures. Blob failures are counted, not raised.
    pub async fn run_deleted(&self) -> Result<GcReport> {
        let mut report = GcReport::default();
        loop {
            let mut deleted_this_round = 0_u64;
            let mut tx = self.repository.begin().await?;
            let chunk = tx
                .deleted_chunk(self.clock.now(), self.deleted_limit)
                .await?;
            if chunk.is_empty() {
                tx.commit().await?;
                break;
            }

            let ids: Vec<Uuid> = chunk.iter().map(|item| item.id).collect();
            let locked = tx.lock_rows(&ids).await?;
            if locked.is_empty() {
                tx.commit().await?;
                break;
            }

            let mut by_kind: BTreeMap<BackendKind, Vec<Uuid>> = BTreeMap::new();
            for item in chunk {
                if locked.contains(&item.id) {
                    by_kind
                        .entry(item.backend.kind())
                        .or_default()
                        .push(item.id);
                }
            }

            for (kind, group) in by_kind {
                let failed = self.delete_blobs_for(kind, &group).await;
                let ok: Vec<Uuid> = group
                    .iter()
                    .copied()
                    .filter(|id| !failed.contains(id))
                    .collect();
                let failed: Vec<Uuid> =
                    group.into_iter().filter(|id| failed.contains(id)).collect();

                if !ok.is_empty() {
                    tx.delete_upload_session_chunks(&ok).await?;
                    tx.delete_rows(&ok).await?;
                    deleted_this_round += ok.len() as u64;
                }
                if !failed.is_empty() {
                    let until = deletion_retry_until(self.clock.now());
                    tx.defer_deleted(&failed, until).await?;
                    tx.delete_upload_session_chunks(&failed).await?;
                    report.abandoned += tx.give_up(&failed, MAX_DELETION_ATTEMPTS).await?;
                    report.blob_failures += failed.len() as u64;
                }
            }
            tx.commit().await?;
            report.deleted += deleted_this_round;
            if deleted_this_round == 0 {
                break;
            }
        }
        Ok(report)
    }

    async fn delete_blobs(&self, items: &[GcItem]) -> BTreeSet<Uuid> {
        let mut failed = BTreeSet::new();
        let mut by_kind: BTreeMap<BackendKind, Vec<Uuid>> = BTreeMap::new();
        for item in items {
            by_kind
                .entry(item.backend.kind())
                .or_default()
                .push(item.id);
        }
        for (kind, ids) in by_kind {
            failed.extend(self.delete_blobs_for(kind, &ids).await);
        }
        failed
    }

    async fn delete_blobs_for(&self, kind: BackendKind, ids: &[Uuid]) -> BTreeSet<Uuid> {
        match self.stores.get(&kind) {
            Some(store) => match store.delete_bulk(ids).await {
                Ok(failed) => failed.into_iter().collect(),
                Err(_) => ids.iter().copied().collect(),
            },
            None => ids.iter().copied().collect(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{
        collections::{BTreeMap, BTreeSet, HashSet},
        sync::{Arc, Mutex, MutexGuard},
    };

    use chrono::{Duration, TimeZone};

    use crate::{
        Bucket, Content, FixedClock, ObjectStatus, StorageError, StorageMetadata, UrlOptions,
    };

    use super::*;

    #[derive(Default)]
    struct FakeState {
        rows: BTreeMap<Uuid, StorageObject>,
        poison: BTreeSet<Uuid>,
        references: BTreeSet<Uuid>,
    }

    #[derive(Clone, Default)]
    struct FakeRepository {
        state: Arc<Mutex<FakeState>>,
    }

    impl FakeRepository {
        fn state(&self) -> MutexGuard<'_, FakeState> {
            self.state.lock().expect("fake state")
        }

        fn insert(&self, object: StorageObject) {
            self.state().rows.insert(object.id, object);
        }

        fn row(&self, id: Uuid) -> StorageObject {
            self.state().rows.get(&id).cloned().expect("row")
        }
    }

    struct FakeTransaction {
        state: Arc<Mutex<FakeState>>,
    }

    #[async_trait]
    impl GcRepository for FakeRepository {
        async fn begin(&self) -> Result<Box<dyn GcTransaction>> {
            Ok(Box::new(FakeTransaction {
                state: Arc::clone(&self.state),
            }))
        }
    }

    #[async_trait]
    impl GcTransaction for FakeTransaction {
        async fn pending_chunk(
            &mut self,
            cutoff: DateTime<Utc>,
            limit: usize,
        ) -> Result<Vec<GcItem>> {
            let state = self.state.lock().expect("fake state");
            let mut rows: Vec<_> = state
                .rows
                .values()
                .filter(|row| row.status == ObjectStatus::Pending && row.created_at <= cutoff)
                .collect();
            rows.sort_by_key(|row| row.created_at);
            Ok(rows
                .into_iter()
                .take(limit)
                .map(|row| GcItem {
                    id: row.id,
                    backend: row.backend,
                })
                .collect())
        }

        async fn delete_pending(&mut self, ids: &[Uuid]) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut removed = 0;
            for id in ids {
                if state
                    .rows
                    .get(id)
                    .is_some_and(|row| row.status == ObjectStatus::Pending)
                {
                    state.rows.remove(id);
                    removed += 1;
                }
            }
            Ok(removed)
        }

        async fn touched_chunk(
            &mut self,
            threshold: DateTime<Utc>,
            limit: usize,
        ) -> Result<TouchedChunk> {
            let state = self.state.lock().expect("fake state");
            let mut chunk = TouchedChunk::default();
            let mut selected = 0;
            for row in state.rows.values() {
                if selected == limit {
                    break;
                }
                if row.status != ObjectStatus::Valid
                    || row.touched_at.is_none_or(|touched| touched > threshold)
                {
                    continue;
                }
                selected += 1;
                if state.poison.contains(&row.id) {
                    chunk.poison.push(row.id);
                } else {
                    chunk.objects.push(row.clone());
                }
            }
            Ok(chunk)
        }

        async fn has_references(&mut self, object: &StorageObject) -> Result<bool> {
            Ok(self
                .state
                .lock()
                .expect("fake state")
                .references
                .contains(&object.id))
        }

        async fn freeze(&mut self, ids: &[Uuid]) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut changed = 0;
            for id in ids {
                if let Some(row) = state.rows.get_mut(id) {
                    row.touched_at = None;
                    changed += 1;
                }
            }
            Ok(changed)
        }

        async fn mark_deleted(&mut self, ids: &[Uuid], deleted_at: DateTime<Utc>) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut changed = 0;
            for id in ids {
                if let Some(row) = state.rows.get_mut(id) {
                    row.expired_at = Some(deleted_at);
                    row.touched_at = None;
                    changed += 1;
                }
            }
            Ok(changed)
        }

        async fn defer_touched(&mut self, ids: &[Uuid], until: DateTime<Utc>) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut changed = 0;
            for id in ids {
                if let Some(row) = state.rows.get_mut(id) {
                    row.touched_at = Some(until);
                    changed += 1;
                }
            }
            Ok(changed)
        }

        async fn deleted_chunk(
            &mut self,
            cutoff: DateTime<Utc>,
            limit: usize,
        ) -> Result<Vec<GcItem>> {
            let state = self.state.lock().expect("fake state");
            let mut rows: Vec<_> = state
                .rows
                .values()
                .filter(|row| {
                    row.status == ObjectStatus::Valid
                        && row.expired_at.is_some_and(|deleted| deleted <= cutoff)
                })
                .collect();
            rows.sort_by_key(|row| row.expired_at);
            Ok(rows
                .into_iter()
                .take(limit)
                .map(|row| GcItem {
                    id: row.id,
                    backend: row.backend,
                })
                .collect())
        }

        async fn lock_rows(&mut self, ids: &[Uuid]) -> Result<Vec<Uuid>> {
            let state = self.state.lock().expect("fake state");
            Ok(ids
                .iter()
                .copied()
                .filter(|id| state.rows.contains_key(id))
                .collect())
        }

        async fn delete_upload_session_chunks(&mut self, _ids: &[Uuid]) -> Result<u64> {
            Ok(0)
        }

        async fn delete_rows(&mut self, ids: &[Uuid]) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut removed = 0;
            for id in ids {
                if state.rows.remove(id).is_some() {
                    removed += 1;
                }
            }
            Ok(removed)
        }

        async fn defer_deleted(&mut self, ids: &[Uuid], until: DateTime<Utc>) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut changed = 0;
            for id in ids {
                if let Some(row) = state.rows.get_mut(id) {
                    row.deletion_attempts = row.deletion_attempts.saturating_add(1);
                    row.expired_at = Some(until);
                    changed += 1;
                }
            }
            Ok(changed)
        }

        async fn give_up(&mut self, ids: &[Uuid], max_attempts: u32) -> Result<u64> {
            let mut state = self.state.lock().expect("fake state");
            let mut removed = 0;
            for id in ids {
                if state
                    .rows
                    .get(id)
                    .is_some_and(|row| row.deletion_attempts >= max_attempts)
                {
                    state.rows.remove(id);
                    removed += 1;
                }
            }
            Ok(removed)
        }

        async fn commit(self: Box<Self>) -> Result<()> {
            Ok(())
        }
    }

    #[derive(Default)]
    struct MockStoreState {
        attempted: BTreeSet<Uuid>,
        deleted: BTreeSet<Uuid>,
        fail: BTreeSet<Uuid>,
    }

    #[derive(Clone, Default)]
    struct MockStore {
        state: Arc<Mutex<MockStoreState>>,
    }

    impl MockStore {
        fn failing(ids: impl IntoIterator<Item = Uuid>) -> Self {
            let store = Self::default();
            store.state.lock().expect("mock state").fail.extend(ids);
            store
        }

        fn deleted(&self) -> BTreeSet<Uuid> {
            self.state.lock().expect("mock state").deleted.clone()
        }
    }

    #[async_trait]
    impl ObjectStore for MockStore {
        fn backend_kind(&self) -> BackendKind {
            BackendKind::Fs
        }

        async fn put(&self, _object: &StorageObject, _content: &Content) -> Result<()> {
            Err(StorageError::BackendNotConfigured("mock".to_owned()))
        }

        async fn exists(&self, _id: Uuid) -> Result<bool> {
            Ok(false)
        }

        async fn get_bytes(&self, _id: Uuid) -> Result<Vec<u8>> {
            Err(StorageError::BackendNotConfigured("mock".to_owned()))
        }

        async fn url(&self, _id: Uuid, _options: &UrlOptions) -> Result<String> {
            Err(StorageError::BackendNotConfigured("mock".to_owned()))
        }

        async fn delete(&self, id: Uuid) -> Result<()> {
            self.delete_bulk(&[id]).await.map(|_| ())
        }

        async fn delete_bulk(&self, ids: &[Uuid]) -> Result<HashSet<Uuid>> {
            let mut state = self.state.lock().expect("mock state");
            state.attempted.extend(ids.iter().copied());
            let mut failed = HashSet::new();
            for id in ids {
                if state.fail.contains(id) {
                    failed.insert(*id);
                } else {
                    state.deleted.insert(*id);
                }
            }
            Ok(failed)
        }
    }

    fn now() -> DateTime<Utc> {
        Utc.with_ymd_and_hms(2026, 11, 25, 12, 0, 0)
            .single()
            .expect("timestamp")
    }

    fn object(
        id: Uuid,
        bucket: Bucket,
        status: ObjectStatus,
        created_at: DateTime<Utc>,
    ) -> StorageObject {
        let mut object = StorageObject::new_pending(
            id,
            10,
            created_at,
            StorageBackend::Fs,
            StorageMetadata::new(bucket, "text/plain"),
        );
        object.status = status;
        object
    }

    fn runner(repository: &FakeRepository, store: &MockStore) -> StorageGc<FakeRepository> {
        StorageGc::new(repository.clone(), Arc::new(store.clone()))
            .with_clock(Arc::new(FixedClock::new(now())))
    }

    #[tokio::test]
    async fn pending_pass_removes_old_rows_and_blobs() {
        let repository = FakeRepository::default();
        let old = object(
            Uuid::new_v4(),
            Bucket::Tempfile,
            ObjectStatus::Pending,
            now() - Duration::hours(25),
        );
        let fresh = object(
            Uuid::new_v4(),
            Bucket::Tempfile,
            ObjectStatus::Pending,
            now(),
        );
        repository.insert(old.clone());
        repository.insert(fresh.clone());

        let store = MockStore::default();
        let report = runner(&repository, &store)
            .run_pending()
            .await
            .expect("pending pass");

        assert_eq!(report.pending_removed, 1);
        assert_eq!(report.blob_failures, 0);
        assert_eq!(store.deleted(), BTreeSet::from([old.id]));
        assert!(!repository.state().rows.contains_key(&old.id));
        assert!(repository.state().rows.contains_key(&fresh.id));
    }

    #[tokio::test]
    async fn touched_pass_freezes_referenced_rows_and_deletes_orphans() {
        let repository = FakeRepository::default();
        let mut referenced = object(
            Uuid::new_v4(),
            Bucket::FileMediaObject,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        referenced.touched_at = Some(now() - Duration::hours(3));
        let mut orphan = object(
            Uuid::new_v4(),
            Bucket::FileMediaObject,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        orphan.touched_at = Some(now() - Duration::hours(3));
        repository.insert(referenced.clone());
        repository.insert(orphan.clone());
        repository.state().references.insert(referenced.id);

        let store = MockStore::default();
        let report = runner(&repository, &store)
            .run_touched(false)
            .await
            .expect("touched pass");

        assert_eq!(report.frozen, 1);
        assert_eq!(report.marked_deleted, 1);
        assert_eq!(repository.row(referenced.id).touched_at, None);
        assert_eq!(repository.row(orphan.id).expired_at, Some(now()));
        assert!(store.deleted().is_empty());
    }

    #[tokio::test]
    async fn touched_poison_is_deferred_by_one_day() {
        let repository = FakeRepository::default();
        let mut poison = object(
            Uuid::new_v4(),
            Bucket::FileMediaObject,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        poison.touched_at = Some(now() - Duration::hours(3));
        repository.insert(poison.clone());
        repository.state().poison.insert(poison.id);

        let store = MockStore::default();
        let report = runner(&repository, &store)
            .run_touched(false)
            .await
            .expect("poison pass");

        assert_eq!(report.poisoned, 1);
        assert_eq!(report.frozen, 0);
        assert_eq!(report.marked_deleted, 0);
        assert_eq!(
            repository.row(poison.id).touched_at,
            Some(now() + Duration::days(1))
        );
    }

    #[tokio::test]
    async fn touched_compatibility_bucket_is_an_error() {
        let repository = FakeRepository::default();
        let mut object = object(
            Uuid::new_v4(),
            Bucket::FileChange,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        object.touched_at = Some(now() - Duration::hours(3));
        repository.insert(object);

        let store = MockStore::default();
        let error = runner(&repository, &store)
            .run_touched(false)
            .await
            .expect_err("unknown reference bucket");
        assert!(matches!(
            error,
            StorageError::UnexpectedUnknownReference(bucket) if bucket == "file-change"
        ));
    }

    #[tokio::test]
    async fn deleted_pass_removes_ok_rows_and_defers_blob_failures() {
        let repository = FakeRepository::default();
        let mut ok = object(
            Uuid::new_v4(),
            Bucket::Tempfile,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        ok.expired_at = Some(now() - Duration::hours(1));
        let mut failed = ok.clone();
        failed.id = Uuid::new_v4();
        repository.insert(ok.clone());
        repository.insert(failed.clone());

        let store = MockStore::failing([failed.id]);
        let report = runner(&repository, &store)
            .run_deleted()
            .await
            .expect("deleted pass");

        assert_eq!(report.deleted, 1);
        assert_eq!(report.blob_failures, 1);
        assert_eq!(report.abandoned, 0);
        assert!(!repository.state().rows.contains_key(&ok.id));
        let deferred = repository.row(failed.id);
        assert_eq!(deferred.deletion_attempts, 1);
        assert_eq!(deferred.expired_at, Some(now() + Duration::days(1)));
    }

    #[tokio::test]
    async fn deleted_pass_gives_up_after_max_attempts() {
        let repository = FakeRepository::default();
        let mut failed = object(
            Uuid::new_v4(),
            Bucket::Tempfile,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        failed.expired_at = Some(now() - Duration::hours(1));
        failed.deletion_attempts = MAX_DELETION_ATTEMPTS - 1;
        repository.insert(failed.clone());

        let store = MockStore::failing([failed.id]);
        let report = runner(&repository, &store)
            .run_deleted()
            .await
            .expect("give-up pass");

        assert_eq!(report.deleted, 0);
        assert_eq!(report.blob_failures, 1);
        assert_eq!(report.abandoned, 1);
        assert!(!repository.state().rows.contains_key(&failed.id));
    }

    #[tokio::test]
    async fn run_all_covers_the_three_phases() {
        let repository = FakeRepository::default();
        let pending = object(
            Uuid::new_v4(),
            Bucket::Tempfile,
            ObjectStatus::Pending,
            now() - Duration::hours(25),
        );
        let mut touched = object(
            Uuid::new_v4(),
            Bucket::FileMediaObject,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        touched.touched_at = Some(now() - Duration::hours(3));
        let mut deleted = object(
            Uuid::new_v4(),
            Bucket::Tempfile,
            ObjectStatus::Valid,
            now() - Duration::days(1),
        );
        deleted.expired_at = Some(now() - Duration::hours(1));
        repository.insert(pending);
        repository.insert(touched);
        repository.insert(deleted);

        let store = MockStore::default();
        let report = runner(&repository, &store)
            .run_all(false)
            .await
            .expect("full pass");

        assert_eq!(report.pending_removed, 1);
        assert_eq!(report.marked_deleted, 1);
        assert_eq!(report.deleted, 2);
        assert!(repository.state().rows.is_empty());
    }
}
