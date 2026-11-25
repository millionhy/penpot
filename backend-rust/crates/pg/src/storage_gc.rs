//! `storage_object` garbage-collection adapter.
//!
//! Each chunk runs through [`GcTransaction`]; the statements restate
//! `app.storage.pending-gc`, `app.storage.gc-touched` and
//! `app.storage.gc-deleted`. The executor in `storage::StorageGc` owns the
//! loops, decision calls and blob deletion.

use async_trait::async_trait;
use chrono::{DateTime, Utc};
use sqlx::{Postgres, Row, Transaction};
use storage::{
    Bucket, GcItem, GcRepository, GcTransaction, Result, StorageBackend, StorageError,
    StorageObject, TouchedChunk,
};
use uuid::Uuid;

use crate::storage::object_from_row;

const SQL_PENDING_CHUNK: &str = "SELECT id, backend \
   FROM storage_object \
  WHERE status = 'pending' \
    AND created_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY created_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_PENDING: &str =
    "DELETE FROM storage_object WHERE id = ANY($1::uuid[]) AND status = 'pending'";

const SQL_TOUCHED_CHUNK: &str = "SELECT id, size, \
        (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM deleted_at) * 1000)::bigint AS deleted_at_ms, \
        (extract(epoch FROM touched_at) * 1000)::bigint AS touched_at_ms, \
        backend, metadata::text AS metadata, status, deletion_attempts \
   FROM storage_object \
  WHERE touched_at IS NOT NULL \
    AND touched_at <= to_timestamp($1::bigint::double precision / 1000.0) \
    AND status = 'valid' \
  ORDER BY touched_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_FREEZE: &str = "UPDATE storage_object SET touched_at = NULL WHERE id = ANY($1::uuid[])";

const SQL_MARK_DELETED: &str = "UPDATE storage_object \
        SET deleted_at = to_timestamp($2::bigint::double precision / 1000.0), \
            touched_at = NULL \
      WHERE id = ANY($1::uuid[])";

const SQL_DEFER_TOUCHED: &str = "UPDATE storage_object \
        SET touched_at = to_timestamp($2::bigint::double precision / 1000.0) \
      WHERE id = ANY($1::uuid[])";

const SQL_DELETED_CHUNK: &str = "SELECT id, backend \
   FROM storage_object \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
    AND status = 'valid' \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_LOCK_ROWS: &str = "SELECT id FROM storage_object \
  WHERE id = ANY($1::uuid[]) \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_CHUNKS: &str =
    "DELETE FROM upload_session_chunk WHERE object_id = ANY($1::uuid[])";

const SQL_DELETE_ROWS: &str = "DELETE FROM storage_object WHERE id = ANY($1::uuid[])";

const SQL_DEFER_DELETED: &str = "UPDATE storage_object \
        SET deletion_attempts = deletion_attempts + 1, \
            deleted_at = to_timestamp($2::bigint::double precision / 1000.0) \
      WHERE id = ANY($1::uuid[])";

const SQL_GIVE_UP: &str = "DELETE FROM storage_object \
  WHERE id = ANY($1::uuid[]) \
    AND deletion_attempts >= $2";

const SQL_HAS_FILE_MEDIA: &str = "SELECT EXISTS ( \
     SELECT 1 FROM file_media_object \
      WHERE media_id = $1 OR thumbnail_id = $1)";

const SQL_HAS_FONT_VARIANT: &str = "SELECT EXISTS ( \
     SELECT 1 FROM team_font_variant \
      WHERE woff1_file_id = $1 \
         OR woff2_file_id = $1 \
         OR otf_file_id = $1 \
         OR ttf_file_id = $1)";

const SQL_HAS_PROFILE: &str = "SELECT EXISTS (SELECT 1 FROM profile WHERE photo_id = $1) \
    OR EXISTS (SELECT 1 FROM team WHERE photo_id = $1)";

const SQL_HAS_OBJECT_THUMBNAIL: &str = "SELECT EXISTS ( \
     SELECT 1 FROM file_tagged_object_thumbnail WHERE media_id = $1)";

const SQL_HAS_FILE_THUMBNAIL: &str = "SELECT EXISTS ( \
     SELECT 1 FROM file_thumbnail WHERE media_id = $1)";

const SQL_HAS_FILE_DATA: &str = "SELECT EXISTS ( \
     SELECT 1 FROM file_data \
      WHERE file_id = $1 \
        AND id = $2 \
        AND metadata->>'storage-ref-id' = $3::text)";

/// PostgreSQL transaction source for the storage GC loops.
#[derive(Debug, Clone)]
pub struct PgStorageGcRepository {
    database: db::Database,
}

impl PgStorageGcRepository {
    /// Wrap a database handle.
    #[must_use]
    pub fn new(database: db::Database) -> Self {
        Self { database }
    }

    /// The wrapped database handle.
    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }
}

#[async_trait]
impl GcRepository for PgStorageGcRepository {
    async fn begin(&self) -> Result<Box<dyn GcTransaction>> {
        let tx = self
            .database
            .begin()
            .await
            .map_err(|cause| StorageError::Repository(format!("{cause:?}")))?;
        Ok(Box::new(PgStorageGcTransaction { tx }))
    }
}

struct PgStorageGcTransaction {
    tx: Transaction<'static, Postgres>,
}

#[async_trait]
impl GcTransaction for PgStorageGcTransaction {
    async fn pending_chunk(&mut self, cutoff: DateTime<Utc>, limit: usize) -> Result<Vec<GcItem>> {
        let rows = sqlx::query(SQL_PENDING_CHUNK)
            .bind(cutoff.timestamp_millis())
            .bind(bigint(limit)?)
            .fetch_all(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        rows.iter().map(item_from_row).collect()
    }

    async fn delete_pending(&mut self, ids: &[Uuid]) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_DELETE_PENDING)
            .bind(ids)
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn touched_chunk(
        &mut self,
        threshold: DateTime<Utc>,
        limit: usize,
    ) -> Result<TouchedChunk> {
        let rows = sqlx::query(SQL_TOUCHED_CHUNK)
            .bind(threshold.timestamp_millis())
            .bind(bigint(limit)?)
            .fetch_all(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        let mut chunk = TouchedChunk::default();
        for row in &rows {
            if let Ok(object) = object_from_row(row) {
                chunk.objects.push(object);
            } else {
                let id: Uuid = row.try_get("id").map_err(sql_error)?;
                chunk.poison.push(id);
            }
        }
        Ok(chunk)
    }

    async fn has_references(&mut self, object: &StorageObject) -> Result<bool> {
        let id = object.id;
        let referenced = match object.metadata.bucket {
            Bucket::FileMediaObject => self.exists(SQL_HAS_FILE_MEDIA, id).await?,
            Bucket::TeamFontVariant => self.exists(SQL_HAS_FONT_VARIANT, id).await?,
            Bucket::Profile => self.exists(SQL_HAS_PROFILE, id).await?,
            Bucket::FileObjectThumbnail => self.exists(SQL_HAS_OBJECT_THUMBNAIL, id).await?,
            Bucket::FileThumbnail => self.exists(SQL_HAS_FILE_THUMBNAIL, id).await?,
            Bucket::FileData => sqlx::query_scalar::<_, bool>(SQL_HAS_FILE_DATA)
                .bind(object.metadata.file_id)
                .bind(object.metadata.id)
                .bind(id.to_string())
                .fetch_one(&mut *self.tx)
                .await
                .map_err(sql_error)?,
            Bucket::Tempfile
            | Bucket::UploadSession
            | Bucket::Organization
            | Bucket::FileDataFragment
            | Bucket::FileChange => false,
        };
        Ok(referenced)
    }

    async fn freeze(&mut self, ids: &[Uuid]) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_FREEZE)
            .bind(ids)
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn mark_deleted(&mut self, ids: &[Uuid], deleted_at: DateTime<Utc>) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_MARK_DELETED)
            .bind(ids)
            .bind(deleted_at.timestamp_millis())
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn defer_touched(&mut self, ids: &[Uuid], until: DateTime<Utc>) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_DEFER_TOUCHED)
            .bind(ids)
            .bind(until.timestamp_millis())
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn deleted_chunk(&mut self, cutoff: DateTime<Utc>, limit: usize) -> Result<Vec<GcItem>> {
        let rows = sqlx::query(SQL_DELETED_CHUNK)
            .bind(cutoff.timestamp_millis())
            .bind(bigint(limit)?)
            .fetch_all(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        rows.iter().map(item_from_row).collect()
    }

    async fn lock_rows(&mut self, ids: &[Uuid]) -> Result<Vec<Uuid>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let rows = sqlx::query(SQL_LOCK_ROWS)
            .bind(ids)
            .fetch_all(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        rows.iter()
            .map(|row| row.try_get("id").map_err(sql_error))
            .collect()
    }

    async fn delete_upload_session_chunks(&mut self, ids: &[Uuid]) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_DELETE_CHUNKS)
            .bind(ids)
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn delete_rows(&mut self, ids: &[Uuid]) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_DELETE_ROWS)
            .bind(ids)
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn defer_deleted(&mut self, ids: &[Uuid], until: DateTime<Utc>) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_DEFER_DELETED)
            .bind(ids)
            .bind(until.timestamp_millis())
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn give_up(&mut self, ids: &[Uuid], max_attempts: u32) -> Result<u64> {
        if ids.is_empty() {
            return Ok(0);
        }
        let result = sqlx::query(SQL_GIVE_UP)
            .bind(ids)
            .bind(i64::from(max_attempts))
            .execute(&mut *self.tx)
            .await
            .map_err(sql_error)?;
        Ok(result.rows_affected())
    }

    async fn commit(self: Box<Self>) -> Result<()> {
        let PgStorageGcTransaction { tx } = *self;
        tx.commit()
            .await
            .map_err(|error| StorageError::Repository(error.to_string()))
    }
}

impl PgStorageGcTransaction {
    async fn exists(&mut self, sql: &'static str, id: Uuid) -> Result<bool> {
        sqlx::query_scalar::<_, bool>(sql)
            .bind(id)
            .fetch_one(&mut *self.tx)
            .await
            .map_err(sql_error)
    }
}

fn item_from_row(row: &sqlx::postgres::PgRow) -> Result<GcItem> {
    let backend: String = row.try_get("backend").map_err(sql_error)?;
    let backend = StorageBackend::from_name(&backend)
        .ok_or_else(|| StorageError::InvalidBackend(backend.clone()))?;
    Ok(GcItem {
        id: row.try_get("id").map_err(sql_error)?,
        backend,
    })
}

fn bigint(value: usize) -> Result<i64> {
    i64::try_from(value)
        .map_err(|_| StorageError::Repository("chunk size does not fit in bigint".to_owned()))
}

fn sql_error(error: sqlx::Error) -> StorageError {
    StorageError::Repository(error.to_string())
}
