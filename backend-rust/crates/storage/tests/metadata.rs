use std::str::FromStr;

use storage::{
    Bucket, MetadataEncoding, StorageMetadata, DEFAULT_BUCKET, TEMPFILE_BUCKET,
    UPLOAD_SESSION_BUCKET,
};
use uuid::Uuid;

const PROFILE_ID: &str = "86907e95-1cb8-8122-8008-4eb7ba07d89d";
const FILE_ID: &str = "83df2f92-6bd4-4e6d-9c9a-3f6d2b1a4c55";

#[test]
fn transit_metadata_decodes_native_types() {
    let raw = r#"{"~:hash":"blake2b:9f1c2e","~:bucket":"tempfile","~:content-type":"application/zip","~:profile-id":"~u86907e95-1cb8-8122-8008-4eb7ba07d89d"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket, Bucket::Tempfile);
    assert_eq!(metadata.content_type, "application/zip");
    assert_eq!(metadata.hash.as_deref(), Some("blake2b:9f1c2e"));
    assert_eq!(
        metadata.profile_id,
        Some(Uuid::from_str(PROFILE_ID).unwrap())
    );
}

#[test]
fn legacy_reference_is_promoted_to_bucket() {
    let raw = r#"{"~:reference":"~:file-media-object","~:content-type":"image/png","~:hash":"blake2b:9f1c2e"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket, Bucket::FileMediaObject);
    assert_eq!(metadata.content_type, "image/png");
}

#[test]
fn plain_json_prefers_bucket_and_drops_the_legacy_reference() {
    let raw =
        r#"{"bucket":"tempfile","content-type":"application/zip","reference":"file-media-object"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket, Bucket::Tempfile);
}

#[test]
fn empty_bucket_falls_back_to_the_legacy_reference() {
    let raw = r#"{"bucket":"","content-type":"image/svg+xml","reference":"organization","organization-id":"11111111-2222-3333-4444-555555555555"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket, Bucket::Organization);
}

#[test]
fn transit_empty_bucket_falls_back_to_a_keyword_reference() {
    let raw = r#"{"~:bucket":"","~:content-type":"image/svg+xml","~:reference":"~:organization","~:organization-id":"~u11111111-2222-3333-4444-555555555555"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket, Bucket::Organization);
}

#[test]
fn missing_bucket_uses_file_media_object_default() {
    let raw = r#"{"~:content-type":"image/svg+xml"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket.as_str(), DEFAULT_BUCKET);
    assert_eq!(metadata.content_type, "image/svg+xml");
}

#[test]
fn legacy_upload_keys_are_dropped_after_normalization() {
    let raw = r#"{"~:bucket":"tempfile","~:content-type":"application/zip","~:upload-id":"~u86907e95-1cb8-8122-8008-4eb7ba07d89d","~:chunk-index":3}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");
    let encoded = metadata.encode(MetadataEncoding::Json).expect("encode");

    assert_eq!(metadata.bucket.as_str(), TEMPFILE_BUCKET);
    assert!(!encoded.contains("upload-id"));
    assert!(!encoded.contains("chunk-index"));
}

#[test]
fn json_metadata_coerces_uuid_strings_on_read() {
    let raw = r#"{"bucket":"file-data","content-type":"application/octet-stream","file-id":"86907e95-1cb8-8122-8008-4eb7ba07d89d","id":"83df2f92-6bd4-4e6d-9c9a-3f6d2b1a4c55"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.bucket, Bucket::FileData);
    assert_eq!(metadata.file_id, Some(Uuid::from_str(PROFILE_ID).unwrap()));
    assert_eq!(metadata.id, Some(Uuid::from_str(FILE_ID).unwrap()));
}

#[test]
fn transit_sniff_is_anchored_to_the_first_key() {
    let raw = r#"{"bucket":"tempfile","content-type":"text/plain;~:x"}"#;

    let metadata = StorageMetadata::decode(raw).expect("metadata");

    assert_eq!(metadata.content_type, "text/plain;~:x");
}

#[test]
fn transit_and_json_encodings_decode_to_the_same_value() {
    let metadata = StorageMetadata::new(Bucket::Tempfile, "application/zip")
        .with_profile_id(Uuid::from_str(PROFILE_ID).unwrap());

    let transit = metadata.encode(MetadataEncoding::Transit).expect("encode");
    let json = metadata.encode(MetadataEncoding::Json).expect("encode");

    assert!(transit.starts_with(r#"{"~:"#));
    assert!(!json.contains(r#""~:"#));
    assert_eq!(StorageMetadata::decode(&transit).unwrap(), metadata);
    assert_eq!(StorageMetadata::decode(&json).unwrap(), metadata);
}

#[test]
fn the_write_default_stays_on_legacy_transit() {
    assert_eq!(MetadataEncoding::default(), MetadataEncoding::Transit);
}

#[test]
fn all_buckets_round_trip_in_both_encodings() {
    let samples = bucket_samples();

    for metadata in samples {
        for encoding in [MetadataEncoding::Transit, MetadataEncoding::Json] {
            let raw = metadata.encode(encoding).expect("encode");
            assert_eq!(
                StorageMetadata::decode(&raw).expect("round trip"),
                metadata,
                "{encoding:?}"
            );
        }
    }
}

#[test]
fn canonical_bucket_set_matches_the_clojure_contract() {
    let names = Bucket::ALL
        .iter()
        .map(|bucket| bucket.as_str())
        .collect::<Vec<_>>();

    assert_eq!(
        names,
        vec![
            "file-media-object",
            "team-font-variant",
            "file-object-thumbnail",
            "file-thumbnail",
            "profile",
            "organization",
            TEMPFILE_BUCKET,
            UPLOAD_SESSION_BUCKET,
            "file-data",
            "file-data-fragment",
            "file-change",
        ]
    );
}

#[test]
fn unknown_bucket_is_rejected() {
    let raw = r#"{"bucket":"no-such-bucket","content-type":"image/png"}"#;

    assert!(StorageMetadata::decode(raw).is_err());
}

#[test]
fn extra_key_is_rejected() {
    let raw = r#"{"bucket":"file-media-object","content-type":"image/png","other":"data"}"#;

    assert!(StorageMetadata::decode(raw).is_err());
}

#[test]
fn missing_content_type_is_rejected() {
    let raw = r#"{"bucket":"file-media-object"}"#;

    assert!(StorageMetadata::decode(raw).is_err());
}

#[test]
fn malformed_uuid_is_rejected() {
    let raw = r#"{"bucket":"file-data","content-type":"application/octet-stream","file-id":"not-a-uuid","id":"83df2f92-6bd4-4e6d-9c9a-3f6d2b1a4c55"}"#;

    assert!(StorageMetadata::decode(raw).is_err());
}

#[test]
fn file_data_requires_both_ids() {
    let raw = r#"{"bucket":"file-data","content-type":"application/octet-stream","file-id":"86907e95-1cb8-8122-8008-4eb7ba07d89d"}"#;

    assert!(StorageMetadata::decode(raw).is_err());
}

#[test]
fn organization_requires_an_organization_id() {
    let raw = r#"{"bucket":"organization","content-type":"image/svg+xml"}"#;

    assert!(StorageMetadata::decode(raw).is_err());
}

fn bucket_samples() -> Vec<StorageMetadata> {
    vec![
        StorageMetadata::new(Bucket::FileMediaObject, "image/png").with_hash("blake2b:9f1c2e"),
        StorageMetadata::new(Bucket::TeamFontVariant, "font/woff2"),
        StorageMetadata::new(Bucket::FileObjectThumbnail, "image/png"),
        StorageMetadata::new(Bucket::FileThumbnail, "image/png"),
        StorageMetadata::new(Bucket::Profile, "image/png"),
        StorageMetadata::new(Bucket::Organization, "image/svg+xml")
            .with_organization_id(Uuid::from_str("11111111-2222-3333-4444-555555555555").unwrap()),
        StorageMetadata::new(Bucket::Tempfile, "application/zip")
            .with_profile_id(Uuid::from_str(PROFILE_ID).unwrap()),
        StorageMetadata::new(Bucket::UploadSession, "application/octet-stream"),
        StorageMetadata::new(Bucket::FileData, "application/octet-stream")
            .with_file_id(Uuid::from_str(PROFILE_ID).unwrap())
            .with_id(Uuid::from_str(FILE_ID).unwrap()),
        StorageMetadata::new(Bucket::FileDataFragment, "application/octet-stream"),
        StorageMetadata::new(Bucket::FileChange, "application/octet-stream"),
    ]
}
