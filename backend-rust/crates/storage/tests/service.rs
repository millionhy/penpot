use std::{collections::HashSet, sync::Arc};

use async_trait::async_trait;
use chrono::{TimeZone, Utc};
use storage::{
    Bucket, Content, DedupOutcome, FixedClock, FsStore, MemoryRepository, ObjectStatus,
    ObjectStore, PutParams, Storage, StorageBackend, StorageError, StorageMetadata, StorageObject,
    StorageRepository, UrlOptions,
};
use tempfile::TempDir;
use uuid::Uuid;

struct Fixture {
    _dir: TempDir,
    repo: MemoryRepository,
    storage: Storage<MemoryRepository>,
}

fn fixture() -> Fixture {
    let dir = tempfile::tempdir().unwrap();
    let repo = MemoryRepository::default();
    let store = Arc::new(FsStore::new(dir.path()));
    let now = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();
    let storage = Storage::new(repo.clone(), StorageBackend::Fs, store)
        .with_clock(Arc::new(FixedClock::new(now)));
    Fixture {
        _dir: dir,
        repo,
        storage,
    }
}

fn params(content: &str) -> PutParams {
    PutParams::new(
        Content::bytes(content.as_bytes().to_vec()),
        StorageMetadata::new(Bucket::FileMediaObject, "text/plain"),
    )
}

#[tokio::test]
async fn put_writes_the_blob_and_promotes_the_row() {
    let fixture = fixture();

    let result = fixture.storage.put(params("content")).await.unwrap();
    let loaded = fixture
        .storage
        .get_object(result.object.id)
        .await
        .unwrap()
        .unwrap();

    assert_eq!(result.dedup, DedupOutcome::Skip);
    assert_eq!(loaded.status, ObjectStatus::Valid);
    assert_eq!(
        fixture.storage.get_data(&loaded).await.unwrap(),
        Some(b"content".to_vec())
    );
}

#[tokio::test]
async fn identical_hash_reuses_the_existing_object() {
    let fixture = fixture();
    let first = fixture
        .storage
        .put(
            params("same")
                .deduplicate(true)
                .content(Content::bytes(b"same".to_vec()).with_hash("same-hash")),
        )
        .await
        .unwrap();
    let second = fixture
        .storage
        .put(
            params("same")
                .deduplicate(true)
                .content(Content::bytes(b"same".to_vec()).with_hash("same-hash")),
        )
        .await
        .unwrap();

    assert_eq!(first.object.id, second.object.id);
    assert_eq!(second.dedup, DedupOutcome::Hit);
    assert_eq!(fixture.repo.len(), 1);
}

#[tokio::test]
async fn tempfile_and_upload_session_buckets_never_deduplicate() {
    for bucket in [Bucket::Tempfile, Bucket::UploadSession] {
        let fixture = fixture();
        let metadata = StorageMetadata::new(bucket, "application/octet-stream");
        let first = fixture
            .storage
            .put(
                PutParams::new(
                    Content::bytes(b"same".to_vec()).with_hash("same-hash"),
                    metadata.clone(),
                )
                .deduplicate(true),
            )
            .await
            .unwrap();
        let second = fixture
            .storage
            .put(
                PutParams::new(
                    Content::bytes(b"same".to_vec()).with_hash("same-hash"),
                    metadata,
                )
                .deduplicate(true),
            )
            .await
            .unwrap();

        assert_ne!(first.object.id, second.object.id);
        assert_eq!(second.dedup, DedupOutcome::Skip);
    }
}

#[tokio::test]
async fn a_missing_blob_is_repaired_under_the_existing_id() {
    let fixture = fixture();
    let first = fixture
        .storage
        .put(
            params("repair")
                .deduplicate(true)
                .content(Content::bytes(b"repair".to_vec()).with_hash("repair-hash")),
        )
        .await
        .unwrap();
    let path = fixture
        .storage
        .get_path(&first.object)
        .expect("filesystem path");
    tokio::fs::remove_file(path).await.unwrap();

    let second = fixture
        .storage
        .put(
            params("repair")
                .deduplicate(true)
                .content(Content::bytes(b"repair".to_vec()).with_hash("repair-hash")),
        )
        .await
        .unwrap();

    assert_eq!(first.object.id, second.object.id);
    assert_eq!(second.dedup, DedupOutcome::Repair);
    assert_eq!(
        fixture.storage.get_data(&second.object).await.unwrap(),
        Some(b"repair".to_vec())
    );
    assert_eq!(fixture.repo.len(), 1);
}

#[tokio::test]
async fn a_failed_blob_write_leaves_a_pending_row() {
    let repo = MemoryRepository::default();
    let store = Arc::new(FailingStore);
    let now = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();
    let storage = Storage::new(repo.clone(), StorageBackend::Fs, store)
        .with_clock(Arc::new(FixedClock::new(now)));

    let error = storage.put(params("content")).await.unwrap_err();
    let rows = repo.objects();

    assert!(matches!(error, StorageError::Backend { .. }));
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].status, ObjectStatus::Pending);
    assert!(storage.get_object(rows[0].id).await.unwrap().is_none());
}

#[tokio::test]
async fn invalid_metadata_is_rejected_before_any_row_is_inserted() {
    let fixture = fixture();
    let error = fixture
        .storage
        .put(PutParams::new(
            Content::bytes(b"encoded".to_vec()),
            StorageMetadata::new(Bucket::FileData, "application/octet-stream"),
        ))
        .await
        .unwrap_err();

    assert!(matches!(error, StorageError::InvalidMetadata { .. }));
    assert_eq!(fixture.repo.len(), 0);
}

#[tokio::test]
async fn pending_rows_are_invisible_to_deduplication() {
    let fixture = fixture();
    let now = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();
    let pending_id = Uuid::new_v4();
    fixture
        .repo
        .insert(&StorageObject::new_pending(
            pending_id,
            4,
            now,
            StorageBackend::Fs,
            StorageMetadata::new(Bucket::FileMediaObject, "text/plain").with_hash("same-hash"),
        ))
        .await
        .unwrap();

    let result = fixture
        .storage
        .put(
            params("same")
                .deduplicate(true)
                .content(Content::bytes(b"same".to_vec()).with_hash("same-hash")),
        )
        .await
        .unwrap();

    assert_ne!(result.object.id, pending_id);
    assert_eq!(result.dedup, DedupOutcome::Miss);
}

#[tokio::test]
async fn touch_on_a_healthy_hit_updates_touched_at() {
    let fixture = fixture();
    let first = fixture
        .storage
        .put(
            params("touch")
                .deduplicate(true)
                .content(Content::bytes(b"touch".to_vec()).with_hash("touch-hash"))
                .touch(true),
        )
        .await
        .unwrap();
    let later = Utc.with_ymd_and_hms(2026, 11, 24, 13, 0, 0).unwrap();
    let storage = fixture.storage.with_clock(Arc::new(FixedClock::new(later)));

    let second = storage
        .put(
            params("touch")
                .deduplicate(true)
                .content(Content::bytes(b"touch".to_vec()).with_hash("touch-hash"))
                .touch(true),
        )
        .await
        .unwrap();
    let row = fixture.repo.get_any(first.object.id).unwrap();

    assert_eq!(second.object.id, first.object.id);
    assert_eq!(row.touched_at, Some(later));
}

#[tokio::test]
async fn expired_objects_are_hidden_and_cannot_be_soft_deleted() {
    let fixture = fixture();
    let now = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();
    let result = fixture
        .storage
        .put(params("expired").expired_at(Some(now)))
        .await
        .unwrap();

    assert!(fixture
        .storage
        .get_object(result.object.id)
        .await
        .unwrap()
        .is_none());
    assert!(!fixture.storage.delete(result.object.id).await.unwrap());
    assert!(fixture
        .storage
        .get_data(&result.object)
        .await
        .unwrap()
        .is_none());
    assert!(fixture.storage.get_path(&result.object).is_none());
    assert!(fixture
        .storage
        .get_url(&result.object, &UrlOptions::default())
        .await
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn touch_and_delete_report_whether_a_live_row_changed() {
    let fixture = fixture();
    let result = fixture.storage.put(params("content")).await.unwrap();

    assert!(fixture.storage.touch(result.object.id).await.unwrap());
    assert!(fixture.storage.delete(result.object.id).await.unwrap());
    assert!(!fixture.storage.delete(result.object.id).await.unwrap());
}

#[derive(Debug)]
struct FailingStore;

#[async_trait]
impl ObjectStore for FailingStore {
    fn backend_kind(&self) -> storage::BackendKind {
        storage::BackendKind::Fs
    }

    async fn put(&self, object: &StorageObject, _content: &Content) -> storage::Result<()> {
        Err(StorageError::Backend {
            operation: "put",
            object_id: object.id,
            message: "write failed".to_owned(),
        })
    }

    async fn exists(&self, _id: Uuid) -> storage::Result<bool> {
        Ok(false)
    }

    async fn get_bytes(&self, id: Uuid) -> storage::Result<Vec<u8>> {
        Err(StorageError::ObjectNotFound(id))
    }

    async fn url(&self, _id: Uuid, _options: &UrlOptions) -> storage::Result<String> {
        Err(StorageError::Backend {
            operation: "url",
            object_id: Uuid::nil(),
            message: "not supported".to_owned(),
        })
    }

    async fn delete(&self, _id: Uuid) -> storage::Result<()> {
        Ok(())
    }

    async fn delete_bulk(&self, _ids: &[Uuid]) -> storage::Result<HashSet<Uuid>> {
        Ok(HashSet::new())
    }
}
