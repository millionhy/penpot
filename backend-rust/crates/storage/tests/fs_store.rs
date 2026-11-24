use std::{collections::HashSet, str::FromStr};

use chrono::{TimeZone, Utc};
use storage::{
    Bucket, Content, FsStore, ObjectStatus, ObjectStore, StorageBackend, StorageMetadata,
    StorageObject, UrlOptions,
};
use tempfile::TempDir;
use uuid::Uuid;

fn object(id: Uuid) -> StorageObject {
    StorageObject {
        id,
        size: 7,
        created_at: Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap(),
        expired_at: None,
        touched_at: None,
        backend: StorageBackend::Fs,
        metadata: StorageMetadata::new(Bucket::FileMediaObject, "text/plain"),
        status: ObjectStatus::Valid,
        deletion_attempts: 0,
    }
}

#[tokio::test]
async fn put_read_url_and_delete_an_object() {
    let dir = TempDir::new().unwrap();
    let store = FsStore::new(dir.path());
    let id = Uuid::from_str("00010203-0405-0607-0809-0a0b0c0d0e0f").unwrap();
    let object = object(id);

    store
        .put(&object, &Content::bytes(b"content".to_vec()))
        .await
        .unwrap();

    assert!(store.exists(id).await.unwrap());
    assert_eq!(store.get_bytes(id).await.unwrap(), b"content");
    assert!(store
        .url(id, &UrlOptions::default())
        .await
        .unwrap()
        .ends_with("00/01/02030405060708090a0b0c0d0e0f"));

    store.delete(id).await.unwrap();
    assert!(!store.exists(id).await.unwrap());
    store.delete(id).await.unwrap();
}

#[tokio::test]
async fn bulk_delete_returns_failed_ids() {
    let dir = TempDir::new().unwrap();
    let store = FsStore::new(dir.path());
    let first = Uuid::new_v4();
    let second = Uuid::new_v4();
    store
        .put(&object(first), &Content::bytes(b"first".to_vec()))
        .await
        .unwrap();
    store
        .put(&object(second), &Content::bytes(b"second".to_vec()))
        .await
        .unwrap();

    let path = storage::fs_redirect_path(dir.path(), second);
    tokio::fs::remove_file(&path).await.unwrap();
    tokio::fs::create_dir_all(&path).await.unwrap();

    let failed = store.delete_bulk(&[first, second]).await.unwrap();

    assert_eq!(failed, HashSet::from([second]));
    assert!(!store.exists(first).await.unwrap());
}

#[tokio::test]
async fn put_replaces_an_existing_blob() {
    let dir = TempDir::new().unwrap();
    let store = FsStore::new(dir.path());
    let id = Uuid::new_v4();

    store
        .put(&object(id), &Content::bytes(b"first".to_vec()))
        .await
        .unwrap();
    store
        .put(&object(id), &Content::bytes(b"second".to_vec()))
        .await
        .unwrap();

    assert_eq!(store.get_bytes(id).await.unwrap(), b"second");
}

#[tokio::test]
async fn reads_a_missing_object_as_not_found() {
    let dir = TempDir::new().unwrap();
    let store = FsStore::new(dir.path());
    let id = Uuid::new_v4();

    assert!(matches!(
        store.get_bytes(id).await,
        Err(storage::StorageError::ObjectNotFound(missing)) if missing == id
    ));
}
