//! `storage_object` adapter for the storage service.
//!
//! The queries restate `app.storage` with PostgreSQL placeholders:
//!
//! * reads only accept `status = 'valid'` and `deleted_at IS NULL`;
//! * deduplication probes both metadata encodings (legacy `~:hash`/`~:bucket`
//!   keys and plain `hash`/`bucket` keys) in one union, as the Clojure code
//!   does while Transit rows still exist;
//! * inserts write `expired_at` to the `deleted_at` column and keep the
//!   write-ahead `status`;
//! * `promote`, `set_touched` and `soft_delete` mirror the three update
//!   statements in `app.storage`.
//!
//! New rows use verbose Transit metadata by default, matching the backend
//! while `:storage-metadata-as-json` is unset. Construct the repository with
//! [`PgStorageRepository::with_metadata_encoding`] to write plain JSON once
//! that flag is on.

use chrono::{DateTime, Utc};
use sqlx::Row;
use storage::{
    MetadataEncoding, ObjectStatus, Result, StorageBackend, StorageError, StorageMetadata,
    StorageObject, StorageRepository,
};
use uuid::Uuid;

/// Live, valid row by id.
const SQL_GET_VALID: &str = "SELECT id, size, \
        (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM deleted_at) * 1000)::bigint AS deleted_at_ms, \
        (extract(epoch FROM touched_at) * 1000)::bigint AS touched_at_ms, \
        backend, metadata::text AS metadata, status, deletion_attempts \
   FROM storage_object \
  WHERE id = $1 \
    AND deleted_at IS NULL \
    AND status = 'valid'";

/// Deduplication probe over both metadata encodings.
const SQL_FIND_DEDUP: &str = "(\
     SELECT id, size, \
            (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
            (extract(epoch FROM deleted_at) * 1000)::bigint AS deleted_at_ms, \
            (extract(epoch FROM touched_at) * 1000)::bigint AS touched_at_ms, \
            backend, metadata::text AS metadata, status, deletion_attempts \
       FROM storage_object \
      WHERE (metadata->>'~:hash') = $1 \
        AND (metadata->>'~:bucket') = $2 \
        AND backend = $3 \
        AND deleted_at IS NULL \
        AND status = 'valid' \
      LIMIT 1\
   ) UNION ALL (\
     SELECT id, size, \
            (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
            (extract(epoch FROM deleted_at) * 1000)::bigint AS deleted_at_ms, \
            (extract(epoch FROM touched_at) * 1000)::bigint AS touched_at_ms, \
            backend, metadata::text AS metadata, status, deletion_attempts \
       FROM storage_object \
      WHERE (metadata->>'hash') = $1 \
        AND (metadata->>'bucket') = $2 \
        AND backend = $3 \
        AND deleted_at IS NULL \
        AND status = 'valid' \
      LIMIT 1\
   ) LIMIT 1";

/// Write-ahead insert.
const SQL_INSERT: &str = "INSERT INTO storage_object \
        (id, size, backend, metadata, deleted_at, touched_at, status, \
         created_at, deletion_attempts) \
   VALUES ($1, $2, $3::text, $4::text::jsonb, \
           to_timestamp($5::bigint::double precision / 1000.0), \
           to_timestamp($6::bigint::double precision / 1000.0), \
           $7::text, \
           to_timestamp($8::bigint::double precision / 1000.0), \
           $9::bigint)";

/// Blob write finished.
const SQL_PROMOTE: &str = "UPDATE storage_object SET status = 'valid' WHERE id = $1";

/// Reference scan timestamp.
const SQL_SET_TOUCHED: &str = "UPDATE storage_object \
        SET touched_at = to_timestamp($2::bigint::double precision / 1000.0) \
      WHERE id = $1";

/// Soft delete, only while the tombstone is still absent.
const SQL_SOFT_DELETE: &str = "UPDATE storage_object \
        SET deleted_at = to_timestamp($2::bigint::double precision / 1000.0) \
      WHERE id = $1 AND deleted_at IS NULL";

/// PostgreSQL `storage_object` repository.
#[derive(Debug, Clone)]
pub struct PgStorageRepository {
    database: db::Database,
    metadata_encoding: MetadataEncoding,
}

impl PgStorageRepository {
    /// Wrap a database handle; new rows use verbose Transit metadata.
    #[must_use]
    pub fn new(database: db::Database) -> Self {
        Self {
            database,
            metadata_encoding: MetadataEncoding::Transit,
        }
    }

    /// Choose the encoding used by [`StorageRepository::insert`].
    #[must_use]
    pub fn with_metadata_encoding(mut self, metadata_encoding: MetadataEncoding) -> Self {
        self.metadata_encoding = metadata_encoding;
        self
    }

    /// The wrapped database handle.
    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }
}

#[async_trait::async_trait]
impl StorageRepository for PgStorageRepository {
    async fn get_valid(&self, id: Uuid) -> Result<Option<StorageObject>> {
        let row = sqlx::query(SQL_GET_VALID)
            .bind(id)
            .fetch_optional(self.database.pool())
            .await
            .map_err(repository_error)?;
        row.as_ref().map(object_from_row).transpose()
    }

    async fn find_dedup(
        &self,
        backend: StorageBackend,
        bucket: &str,
        hash: &str,
    ) -> Result<Option<StorageObject>> {
        let row = sqlx::query(SQL_FIND_DEDUP)
            .bind(hash)
            .bind(bucket)
            .bind(backend.as_str())
            .fetch_optional(self.database.pool())
            .await
            .map_err(repository_error)?;
        row.as_ref().map(object_from_row).transpose()
    }

    async fn insert(&self, object: &StorageObject) -> Result<()> {
        let metadata = object.metadata.encode(self.metadata_encoding)?;
        sqlx::query(SQL_INSERT)
            .bind(object.id)
            .bind(object.size)
            .bind(object.backend.as_str())
            .bind(metadata)
            .bind(object.expired_at.map(|instant| instant.timestamp_millis()))
            .bind(object.touched_at.map(|instant| instant.timestamp_millis()))
            .bind(object.status.as_str())
            .bind(object.created_at.timestamp_millis())
            .bind(i64::from(object.deletion_attempts))
            .execute(self.database.pool())
            .await
            .map_err(repository_error)?;
        Ok(())
    }

    async fn promote(&self, id: Uuid) -> Result<bool> {
        let result = sqlx::query(SQL_PROMOTE)
            .bind(id)
            .execute(self.database.pool())
            .await
            .map_err(repository_error)?;
        Ok(result.rows_affected() > 0)
    }

    async fn set_touched(&self, id: Uuid, touched_at: Option<DateTime<Utc>>) -> Result<bool> {
        let result = sqlx::query(SQL_SET_TOUCHED)
            .bind(id)
            .bind(touched_at.map(|instant| instant.timestamp_millis()))
            .execute(self.database.pool())
            .await
            .map_err(repository_error)?;
        Ok(result.rows_affected() > 0)
    }

    async fn soft_delete(&self, id: Uuid, deleted_at: DateTime<Utc>) -> Result<bool> {
        let result = sqlx::query(SQL_SOFT_DELETE)
            .bind(id)
            .bind(deleted_at.timestamp_millis())
            .execute(self.database.pool())
            .await
            .map_err(repository_error)?;
        Ok(result.rows_affected() > 0)
    }
}

pub(crate) fn object_from_row(row: &sqlx::postgres::PgRow) -> Result<StorageObject> {
    let backend: String = row.try_get("backend").map_err(repository_error)?;
    let backend = StorageBackend::from_name(&backend)
        .ok_or_else(|| StorageError::InvalidBackend(backend.clone()))?;
    let status: String = row.try_get("status").map_err(repository_error)?;
    let status = ObjectStatus::from_name(&status).ok_or_else(|| {
        StorageError::Repository(format!("invalid storage object status: {status}"))
    })?;
    let metadata: Option<String> = row.try_get("metadata").map_err(repository_error)?;
    let deleted_at: Option<i64> = row.try_get("deleted_at_ms").map_err(repository_error)?;
    let touched_at: Option<i64> = row.try_get("touched_at_ms").map_err(repository_error)?;
    let deletion_attempts: i64 = row.try_get("deletion_attempts").map_err(repository_error)?;

    Ok(StorageObject {
        id: row.try_get("id").map_err(repository_error)?,
        size: row.try_get("size").map_err(repository_error)?,
        created_at: instant(row.try_get("created_at_ms").map_err(repository_error)?)?,
        expired_at: deleted_at.map(instant).transpose()?,
        touched_at: touched_at.map(instant).transpose()?,
        backend,
        metadata: decode_metadata(metadata.as_deref())?,
        status,
        deletion_attempts: u32::try_from(deletion_attempts).map_err(|_| {
            StorageError::Repository(format!(
                "deletion_attempts {deletion_attempts} is outside the supported range"
            ))
        })?,
    })
}

fn decode_metadata(raw: Option<&str>) -> Result<StorageMetadata> {
    let raw = raw
        .ok_or_else(|| StorageError::Repository("storage object metadata is missing".to_owned()))?;
    StorageMetadata::decode(raw)
}

fn instant(millis: i64) -> Result<DateTime<Utc>> {
    DateTime::from_timestamp_millis(millis).ok_or_else(|| {
        StorageError::Repository(format!("timestamp {millis} is outside the supported range"))
    })
}

fn repository_error(error: sqlx::Error) -> StorageError {
    StorageError::Repository(error.to_string())
}

#[cfg(test)]
mod tests {
    use chrono::TimeZone;

    use super::*;

    #[test]
    fn transit_metadata_decodes_from_a_row_value() {
        let raw = r#"{"~:bucket":"file-media-object","~:content-type":"image/png"}"#;
        let metadata = decode_metadata(Some(raw)).expect("metadata");
        assert_eq!(metadata.bucket.as_str(), "file-media-object");
        assert_eq!(metadata.content_type, "image/png");
    }

    #[test]
    fn missing_metadata_is_a_repository_error() {
        assert!(matches!(
            decode_metadata(None),
            Err(StorageError::Repository(_))
        ));
    }

    #[test]
    fn millis_round_trip() {
        let value = Utc
            .with_ymd_and_hms(2026, 11, 25, 9, 8, 7)
            .single()
            .expect("valid instant");
        assert_eq!(instant(value.timestamp_millis()).expect("instant"), value);
        assert!(instant(i64::MAX).is_err());
    }

    #[tokio::test]
    async fn new_repository_writes_transit_metadata_by_default() {
        let repository = PgStorageRepository::new(
            db::Database::connect(db::DbOptions::new("postgres://localhost/penpot"))
                .expect("lazy pool"),
        );
        assert_eq!(repository.metadata_encoding, MetadataEncoding::Transit);
    }
}
