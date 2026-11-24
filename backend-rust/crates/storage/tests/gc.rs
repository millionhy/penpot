use chrono::{Duration, TimeZone, Utc};

use storage::{
    classify_deletion_failure, decide_touched, pending_is_eligible, Bucket, DeletionFailure,
    GcDecision, DELETED_CHUNK_SIZE, MAX_DELETION_ATTEMPTS, PENDING_CHUNK_SIZE, PENDING_MAX_AGE,
    TOUCHED_CHUNK_SIZE, TOUCHED_MIN_AGE,
};

const TOUCHED_CLJ: &str = include_str!("../../../../backend/src/app/storage/gc_touched.clj");
const DELETED_CLJ: &str = include_str!("../../../../backend/src/app/storage/gc_deleted.clj");
const PENDING_CLJ: &str = include_str!("../../../../backend/src/app/storage/pending_gc.clj");

#[test]
fn gc_thresholds_match_the_clojure_contract() {
    assert_eq!(PENDING_MAX_AGE, Duration::hours(24));
    assert_eq!(PENDING_CHUNK_SIZE, 100);
    assert_eq!(TOUCHED_MIN_AGE, Duration::hours(2));
    assert_eq!(TOUCHED_CHUNK_SIZE, 10);
    assert_eq!(DELETED_CHUNK_SIZE, 25);
    assert_eq!(MAX_DELETION_ATTEMPTS, 7);
}

#[test]
fn pending_rows_are_eligible_only_after_twenty_four_hours() {
    let now = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();

    assert!(!pending_is_eligible(
        storage::ObjectStatus::Valid,
        now - Duration::hours(25),
        now
    ));
    assert!(!pending_is_eligible(
        storage::ObjectStatus::Pending,
        now - Duration::hours(23),
        now
    ));
    assert!(pending_is_eligible(
        storage::ObjectStatus::Pending,
        now - Duration::hours(24),
        now
    ));
}

#[test]
fn reference_bearing_buckets_freeze_when_referenced() {
    for bucket in [
        Bucket::FileMediaObject,
        Bucket::TeamFontVariant,
        Bucket::FileObjectThumbnail,
        Bucket::FileThumbnail,
        Bucket::Profile,
        Bucket::FileData,
    ] {
        assert_eq!(decide_touched(bucket, true).unwrap(), GcDecision::Freeze);
        assert_eq!(decide_touched(bucket, false).unwrap(), GcDecision::Delete);
    }
}

#[test]
fn reference_free_buckets_always_delete() {
    for bucket in [
        Bucket::Tempfile,
        Bucket::UploadSession,
        Bucket::Organization,
    ] {
        assert_eq!(decide_touched(bucket, true).unwrap(), GcDecision::Delete);
        assert_eq!(decide_touched(bucket, false).unwrap(), GcDecision::Delete);
    }
}

#[test]
fn compatibility_only_buckets_are_rejected_by_the_collector() {
    for bucket in [Bucket::FileDataFragment, Bucket::FileChange] {
        assert!(decide_touched(bucket, false).is_err());
    }
}

#[test]
fn a_failed_blob_deletion_is_retried_until_attempt_seven() {
    let now = Utc.with_ymd_and_hms(2026, 11, 24, 12, 0, 0).unwrap();

    assert_eq!(
        classify_deletion_failure(0, now),
        DeletionFailure::Retry {
            attempts: 1,
            defer_until: now + Duration::days(1),
        }
    );
    assert_eq!(
        classify_deletion_failure(5, now),
        DeletionFailure::Retry {
            attempts: 6,
            defer_until: now + Duration::days(1),
        }
    );
    assert_eq!(classify_deletion_failure(6, now), DeletionFailure::GiveUp);
}

#[test]
fn sql_constants_keep_the_clojure_locking_and_filters() {
    for (sql, needles) in [
        (
            storage::SQL_GET_TOUCHED,
            ["status = 'valid'", "LIMIT 10", "FOR UPDATE", "SKIP LOCKED"],
        ),
        (
            storage::SQL_GET_DELETED,
            [
                "status = 'valid'",
                "deleted_at <= ?",
                "LIMIT ?",
                "SKIP LOCKED",
            ],
        ),
        (
            storage::SQL_GET_PENDING,
            [
                "status = 'pending'",
                "interval '24 hours'",
                "LIMIT ?",
                "SKIP LOCKED",
            ],
        ),
    ] {
        for needle in needles {
            assert!(sql.contains(needle), "missing {needle} in {sql}");
        }
    }

    assert!(TOUCHED_CLJ.contains("LIMIT 10"));
    assert!(DELETED_CLJ.contains("25"));
    assert!(PENDING_CLJ.contains("interval '24 hours'"));
}
