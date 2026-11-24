use std::str::FromStr;

use storage::{id_to_relative_path, s3_key};
use uuid::Uuid;

#[test]
fn s3_keys_use_the_same_uuid_path_and_concat_the_prefix() {
    let id = Uuid::from_str("00010203-0405-0607-0809-0a0b0c0d0e0f").unwrap();

    assert_eq!(s3_key("", id), "00/01/02030405060708090a0b0c0d0e0f");
    assert_eq!(
        s3_key("objects/", id),
        format!("objects/{}", id_to_relative_path(id))
    );
}

#[test]
#[ignore = "requires PENPOT_TEST_S3_BUCKET, AWS credentials and network access"]
fn s3_round_trip_against_a_real_bucket() {
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let store = storage::S3Store::from_environment()
            .await
            .expect("S3 environment");
        let id = Uuid::new_v4();
        let object = storage::StorageObject {
            id,
            size: 7,
            created_at: chrono::Utc::now(),
            expired_at: None,
            touched_at: None,
            backend: storage::StorageBackend::S3,
            metadata: storage::StorageMetadata::new(storage::Bucket::FileMediaObject, "text/plain"),
            status: storage::ObjectStatus::Valid,
            deletion_attempts: 0,
        };

        storage::ObjectStore::put(
            &store,
            &object,
            &storage::Content::bytes(b"content".to_vec()),
        )
        .await
        .unwrap();
        assert_eq!(
            storage::ObjectStore::get_bytes(&store, id).await.unwrap(),
            b"content"
        );
        storage::ObjectStore::delete(&store, id).await.unwrap();
    });
}
