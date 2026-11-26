//! `objects-gc` adapter: purge soft-deleted rows in dependency order.
//!
//! The procedure order and the cascade come from `app.tasks.objects-gc` and
//! `app.tasks.delete-object`. Upload sessions go first because deleting a
//! profile cascades to its sessions while `upload_session_chunk` still holds
//! `NO ACTION` foreign keys.
//!
//! Every step runs in its own transaction with
//! `SET LOCAL rules.deletion_protection TO off`, and each procedure repeats
//! until it deletes nothing, matching `execute-proc!`.
//!
//! The cascade only covers the profile -> team -> project -> file path that
//! `objects-gc` drives. Clojure skips library absorb for that path by binding
//! `*team-deletion*`, so this adapter never needs the Fressian file data that
//! `app.rpc.commands.files/absorb-library` decodes. Direct object deletion
//! with absorb stays out of scope while M8 excludes Fressian.
//!
//! Storage objects are touched with the wall clock, like `sto/touch-object!`,
//! while soft-delete markers use the run timestamp so `skip-delay` can
//! fast-forward the purge.

use async_trait::async_trait;
use chrono::{DateTime, TimeDelta, Utc};
use sqlx::{Postgres, Row, Transaction};
use transit::{Map, Value};
use uuid::Uuid;
use worker::{ObjectsGc, ServiceError};

/// Rows selected per procedure pass.
pub const DEFAULT_CHUNK_SIZE: i64 = 100;

/// Extra age applied by the `skip-delay` prop, mirroring `(ct/in-future {:days 3650})`.
const SKIP_DELAY_DAYS: i64 = 3650;

const SQL_UPLOAD_SESSIONS: &str = "SELECT us.id \
   FROM upload_session AS us \
  WHERE (us.deleted_at IS NOT NULL \
         AND us.deleted_at <= to_timestamp($1::bigint::double precision / 1000.0)) \
     OR (us.deleted_at IS NULL \
         AND us.created_at <= to_timestamp($2::bigint::double precision / 1000.0)) \
     OR EXISTS (SELECT 1 \
                  FROM profile AS p \
                 WHERE p.id = us.profile_id \
                   AND p.deleted_at IS NOT NULL \
                   AND p.deleted_at <= to_timestamp($3::bigint::double precision / 1000.0)) \
  ORDER BY us.created_at ASC \
  LIMIT $4 \
    FOR UPDATE OF us \
   SKIP LOCKED";

const SQL_DELETE_SESSION_CHUNKS: &str =
    "DELETE FROM upload_session_chunk WHERE session_id = $1 RETURNING object_id";

const SQL_TOUCH_OBJECT: &str = "UPDATE storage_object \
        SET touched_at = to_timestamp($2::bigint::double precision / 1000.0) \
      WHERE id = $1";

const SQL_DELETE_UPLOAD_SESSION: &str = "DELETE FROM upload_session WHERE id = $1";

const SQL_PROFILES: &str = "SELECT id, photo_id \
   FROM profile \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_PROFILE: &str = "DELETE FROM profile WHERE id = $1";

const SQL_TEAMS: &str = "SELECT deleted_at, id, photo_id \
   FROM team \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_TEAM: &str = "DELETE FROM team WHERE id = $1";

const SQL_FONTS: &str = "SELECT id, team_id, deleted_at, \
        woff1_file_id, woff2_file_id, otf_file_id, ttf_file_id \
   FROM team_font_variant \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FONT: &str = "DELETE FROM team_font_variant WHERE id = $1";

const SQL_PROJECTS: &str = "SELECT id, deleted_at, team_id \
   FROM project \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_PROJECT: &str = "DELETE FROM project WHERE id = $1";

const SQL_FILES: &str = "SELECT f.id, f.deleted_at, f.project_id \
   FROM file AS f \
  WHERE f.deleted_at IS NOT NULL \
    AND f.deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY f.deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FILE: &str = "DELETE FROM file WHERE id = $1";

const SQL_FILE_THUMBNAILS: &str = "SELECT file_id, revn, media_id, deleted_at \
   FROM file_thumbnail \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FILE_THUMBNAIL: &str =
    "DELETE FROM file_thumbnail WHERE file_id = $1 AND revn = $2";

const SQL_FILE_OBJECT_THUMBNAILS: &str = "SELECT file_id, object_id, media_id, deleted_at \
   FROM file_tagged_object_thumbnail \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FILE_OBJECT_THUMBNAIL: &str =
    "DELETE FROM file_tagged_object_thumbnail WHERE file_id = $1 AND object_id = $2";

const SQL_FILE_MEDIA_OBJECTS: &str = "SELECT id, file_id, media_id, thumbnail_id, deleted_at \
   FROM file_media_object \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FILE_MEDIA_OBJECT: &str = "DELETE FROM file_media_object WHERE id = $1";

const SQL_FILE_DATA: &str = "SELECT file_id, id, type, deleted_at, backend, \
        metadata->>'storage-ref-id' AS storage_ref_id \
   FROM file_data \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FILE_DATA: &str =
    "DELETE FROM file_data WHERE file_id = $1 AND id = $2 AND type = $3";

const SQL_FILE_CHANGES: &str = "SELECT id, file_id, deleted_at \
   FROM file_change \
  WHERE deleted_at IS NOT NULL \
    AND deleted_at <= to_timestamp($1::bigint::double precision / 1000.0) \
  ORDER BY deleted_at ASC \
  LIMIT $2 \
    FOR UPDATE \
   SKIP LOCKED";

const SQL_DELETE_FILE_CHANGE: &str = "DELETE FROM file_change WHERE id = $1";

const SQL_MARK_PROFILE_DELETED: &str = "UPDATE profile \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE id = $2";

const SQL_OWNED_TEAMS: &str = "SELECT tpr.team_id AS id \
   FROM team_profile_rel AS tpr \
   JOIN team AS t ON (t.id = tpr.team_id) \
  WHERE tpr.is_owner IS TRUE \
    AND tpr.profile_id = $1 \
    AND t.deleted_at IS NULL";

const SQL_MARK_TEAM_DELETED: &str = "UPDATE team \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE id = $2";

const SQL_MARK_TEAM_FONTS_DELETED: &str = "UPDATE team_font_variant \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE team_id = $2";

const SQL_PROJECTS_OF_TEAM: &str = "SELECT id FROM project WHERE team_id = $1";

const SQL_MARK_PROJECT_DELETED: &str = "UPDATE project \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE id = $2";

const SQL_FILES_OF_PROJECT: &str = "SELECT id FROM file WHERE project_id = $1";

const SQL_MARK_FILE_DELETED: &str = "UPDATE file \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0), \
            is_shared = false \
      WHERE id = $2";

const SQL_MARK_FILE_CHANGES_DELETED: &str = "UPDATE file_change \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE file_id = $2";

const SQL_MARK_FILE_DATA_DELETED: &str = "UPDATE file_data \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE file_id = $2";

const SQL_MARK_FILE_MEDIA_DELETED: &str = "UPDATE file_media_object \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE file_id = $2";

const SQL_MARK_FILE_THUMBNAILS_DELETED: &str = "UPDATE file_thumbnail \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE file_id = $2";

const SQL_MARK_FILE_OBJECT_THUMBNAILS_DELETED: &str = "UPDATE file_tagged_object_thumbnail \
        SET deleted_at = to_timestamp($1::bigint::double precision / 1000.0) \
      WHERE file_id = $2";

/// Procedures in `deletion-proc-vars` order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Proc {
    UploadSessions,
    Profiles,
    FileMediaObjects,
    FileObjectThumbnails,
    FileThumbnails,
    FileData,
    FileChanges,
    Files,
    Projects,
    Fonts,
    Teams,
}

const PROC_ORDER: [Proc; 11] = [
    Proc::UploadSessions,
    Proc::Profiles,
    Proc::FileMediaObjects,
    Proc::FileObjectThumbnails,
    Proc::FileThumbnails,
    Proc::FileData,
    Proc::FileChanges,
    Proc::Files,
    Proc::Projects,
    Proc::Fonts,
    Proc::Teams,
];

/// PostgreSQL `objects-gc` service.
#[derive(Debug, Clone)]
pub struct PgObjectsGc {
    database: db::Database,
}

impl PgObjectsGc {
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
impl ObjectsGc for PgObjectsGc {
    async fn run(&self, props: &Map) -> std::result::Result<u64, ServiceError> {
        let options = options(props)?;
        let timestamp = timestamp(options);

        let mut total = 0_u64;
        for proc in PROC_ORDER {
            loop {
                let affected = self.run_pass(proc, timestamp, options.chunk_size).await?;
                total += affected;
                if affected == 0 {
                    break;
                }
            }
        }
        Ok(total)
    }
}

impl PgObjectsGc {
    async fn run_pass(
        &self,
        proc: Proc,
        timestamp: DateTime<Utc>,
        chunk_size: i64,
    ) -> std::result::Result<u64, ServiceError> {
        let mut transaction = self
            .database
            .begin()
            .await
            .map_err(|cause| ServiceError::new(format!("{cause:?}")))?;
        sqlx::query("SET LOCAL rules.deletion_protection TO off")
            .execute(&mut *transaction)
            .await
            .map_err(|cause| ServiceError::new(cause.to_string()))?;
        let affected = run_proc(&mut transaction, proc, timestamp, chunk_size).await?;
        transaction
            .commit()
            .await
            .map_err(|cause| ServiceError::new(cause.to_string()))?;
        Ok(affected)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Options {
    skip_delay: bool,
    chunk_size: i64,
}

fn options(props: &Map) -> std::result::Result<Options, ServiceError> {
    let skip_delay = match props.get_kw("skip-delay") {
        Some(Value::Bool(value)) => *value,
        Some(_) => return Err(ServiceError::new("property `skip-delay` must be a boolean")),
        None => false,
    };
    let chunk_size = match props.get_kw("chunk-size") {
        Some(value) => match value.as_i64() {
            Some(size) if size > 0 => size,
            _ => {
                return Err(ServiceError::new(
                    "property `chunk-size` must be a positive integer",
                ))
            }
        },
        None => DEFAULT_CHUNK_SIZE,
    };
    Ok(Options {
        skip_delay,
        chunk_size,
    })
}

fn millis(timestamp: DateTime<Utc>) -> i64 {
    timestamp.timestamp_millis()
}

fn timestamp(options: Options) -> DateTime<Utc> {
    if options.skip_delay {
        Utc::now() + TimeDelta::days(SKIP_DELAY_DAYS)
    } else {
        Utc::now()
    }
}

fn rows_affected(result: sqlx::postgres::PgQueryResult) -> u64 {
    result.rows_affected()
}

fn error(cause: sqlx::Error) -> ServiceError {
    ServiceError::new(cause.to_string())
}

async fn run_proc(
    tx: &mut Transaction<'static, Postgres>,
    proc: Proc,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    match proc {
        Proc::UploadSessions => delete_upload_sessions(tx, timestamp, chunk_size).await,
        Proc::Profiles => delete_profiles(tx, timestamp, chunk_size).await,
        Proc::FileMediaObjects => delete_file_media_objects(tx, timestamp, chunk_size).await,
        Proc::FileObjectThumbnails => {
            delete_file_object_thumbnails(tx, timestamp, chunk_size).await
        }
        Proc::FileThumbnails => delete_file_thumbnails(tx, timestamp, chunk_size).await,
        Proc::FileData => delete_file_data(tx, timestamp, chunk_size).await,
        Proc::FileChanges => delete_file_changes(tx, timestamp, chunk_size).await,
        Proc::Files => delete_files(tx, timestamp, chunk_size).await,
        Proc::Projects => delete_projects(tx, timestamp, chunk_size).await,
        Proc::Fonts => delete_fonts(tx, timestamp, chunk_size).await,
        Proc::Teams => delete_teams(tx, timestamp, chunk_size).await,
    }
}

async fn touch_object(
    tx: &mut Transaction<'static, Postgres>,
    object_id: Uuid,
    touched_at: DateTime<Utc>,
) -> std::result::Result<(), ServiceError> {
    sqlx::query(SQL_TOUCH_OBJECT)
        .bind(object_id)
        .bind(millis(touched_at))
        .execute(&mut **tx)
        .await
        .map_err(error)?;
    Ok(())
}

async fn touch_optional(
    tx: &mut Transaction<'static, Postgres>,
    object_id: Option<Uuid>,
    touched_at: DateTime<Utc>,
) -> std::result::Result<(), ServiceError> {
    if let Some(object_id) = object_id {
        touch_object(tx, object_id, touched_at).await?;
    }
    Ok(())
}

async fn delete_upload_sessions(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_UPLOAD_SESSIONS)
        .bind(millis(timestamp))
        .bind(millis(timestamp - TimeDelta::hours(1)))
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let session: Uuid = row.try_get("id").map_err(error)?;
        let objects: Vec<Option<Uuid>> = sqlx::query_scalar(SQL_DELETE_SESSION_CHUNKS)
            .bind(session)
            .fetch_all(&mut **tx)
            .await
            .map_err(error)?;
        for object_id in objects.into_iter().flatten() {
            touch_object(tx, object_id, touched_at).await?;
        }
        affected += rows_affected(
            sqlx::query(SQL_DELETE_UPLOAD_SESSION)
                .bind(session)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_profiles(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_PROFILES)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let profile: Uuid = row.try_get("id").map_err(error)?;
        let photo: Option<Uuid> = row.try_get("photo_id").map_err(error)?;
        touch_optional(tx, photo, touched_at).await?;
        cascade_profile(tx, profile, timestamp).await?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_PROFILE)
                .bind(profile)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_teams(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_TEAMS)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let team: Uuid = row.try_get("id").map_err(error)?;
        let photo: Option<Uuid> = row.try_get("photo_id").map_err(error)?;
        touch_optional(tx, photo, touched_at).await?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_TEAM)
                .bind(team)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_fonts(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FONTS)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(error)?;
        for column in [
            "woff1_file_id",
            "woff2_file_id",
            "otf_file_id",
            "ttf_file_id",
        ] {
            let object_id: Option<Uuid> = row.try_get(column).map_err(error)?;
            touch_optional(tx, object_id, touched_at).await?;
        }
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FONT)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_projects(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_PROJECTS)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(error)?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_PROJECT)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_files(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FILES)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(error)?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FILE)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_file_thumbnails(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FILE_THUMBNAILS)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let file_id: Uuid = row.try_get("file_id").map_err(error)?;
        let revn: i64 = row.try_get("revn").map_err(error)?;
        let media: Option<Uuid> = row.try_get("media_id").map_err(error)?;
        touch_optional(tx, media, touched_at).await?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FILE_THUMBNAIL)
                .bind(file_id)
                .bind(revn)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_file_object_thumbnails(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FILE_OBJECT_THUMBNAILS)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let file_id: Uuid = row.try_get("file_id").map_err(error)?;
        let object_id: String = row.try_get("object_id").map_err(error)?;
        let media: Option<Uuid> = row.try_get("media_id").map_err(error)?;
        touch_optional(tx, media, touched_at).await?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FILE_OBJECT_THUMBNAIL)
                .bind(file_id)
                .bind(object_id)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_file_media_objects(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FILE_MEDIA_OBJECTS)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(error)?;
        let media: Uuid = row.try_get("media_id").map_err(error)?;
        let thumbnail: Option<Uuid> = row.try_get("thumbnail_id").map_err(error)?;
        touch_object(tx, media, touched_at).await?;
        touch_optional(tx, thumbnail, touched_at).await?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FILE_MEDIA_OBJECT)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_file_data(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FILE_DATA)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    let touched_at = Utc::now();
    for row in rows {
        let file_id: Uuid = row.try_get("file_id").map_err(error)?;
        let id: Uuid = row.try_get("id").map_err(error)?;
        let data_type: String = row.try_get("type").map_err(error)?;
        let storage_ref: Option<String> = row.try_get("storage_ref_id").map_err(error)?;
        if let Some(value) = storage_ref {
            let object_id = Uuid::parse_str(&value).map_err(|cause| {
                ServiceError::new(format!(
                    "file_data.storage-ref-id is not a UUID ({value}): {cause}"
                ))
            })?;
            touch_object(tx, object_id, touched_at).await?;
        }
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FILE_DATA)
                .bind(file_id)
                .bind(id)
                .bind(data_type)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn delete_file_changes(
    tx: &mut Transaction<'static, Postgres>,
    timestamp: DateTime<Utc>,
    chunk_size: i64,
) -> std::result::Result<u64, ServiceError> {
    let rows = sqlx::query(SQL_FILE_CHANGES)
        .bind(millis(timestamp))
        .bind(chunk_size)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;

    let mut affected = 0_u64;
    for row in rows {
        let id: Uuid = row.try_get("id").map_err(error)?;
        affected += rows_affected(
            sqlx::query(SQL_DELETE_FILE_CHANGE)
                .bind(id)
                .execute(&mut **tx)
                .await
                .map_err(error)?,
        );
    }
    Ok(affected)
}

async fn cascade_profile(
    tx: &mut Transaction<'static, Postgres>,
    profile: Uuid,
    timestamp: DateTime<Utc>,
) -> std::result::Result<(), ServiceError> {
    sqlx::query(SQL_MARK_PROFILE_DELETED)
        .bind(millis(timestamp))
        .bind(profile)
        .execute(&mut **tx)
        .await
        .map_err(error)?;
    let teams: Vec<Uuid> = sqlx::query_scalar(SQL_OWNED_TEAMS)
        .bind(profile)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;
    for team in teams {
        cascade_team(tx, team, timestamp).await?;
    }
    Ok(())
}

async fn cascade_team(
    tx: &mut Transaction<'static, Postgres>,
    team: Uuid,
    timestamp: DateTime<Utc>,
) -> std::result::Result<(), ServiceError> {
    sqlx::query(SQL_MARK_TEAM_DELETED)
        .bind(millis(timestamp))
        .bind(team)
        .execute(&mut **tx)
        .await
        .map_err(error)?;
    sqlx::query(SQL_MARK_TEAM_FONTS_DELETED)
        .bind(millis(timestamp))
        .bind(team)
        .execute(&mut **tx)
        .await
        .map_err(error)?;
    let projects: Vec<Uuid> = sqlx::query_scalar(SQL_PROJECTS_OF_TEAM)
        .bind(team)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;
    for project in projects {
        cascade_project(tx, project, timestamp).await?;
    }
    Ok(())
}

async fn cascade_project(
    tx: &mut Transaction<'static, Postgres>,
    project: Uuid,
    timestamp: DateTime<Utc>,
) -> std::result::Result<(), ServiceError> {
    sqlx::query(SQL_MARK_PROJECT_DELETED)
        .bind(millis(timestamp))
        .bind(project)
        .execute(&mut **tx)
        .await
        .map_err(error)?;
    let files: Vec<Uuid> = sqlx::query_scalar(SQL_FILES_OF_PROJECT)
        .bind(project)
        .fetch_all(&mut **tx)
        .await
        .map_err(error)?;
    for file in files {
        cascade_file(tx, file, timestamp).await?;
    }
    Ok(())
}

async fn cascade_file(
    tx: &mut Transaction<'static, Postgres>,
    file: Uuid,
    timestamp: DateTime<Utc>,
) -> std::result::Result<(), ServiceError> {
    sqlx::query(SQL_MARK_FILE_DELETED)
        .bind(millis(timestamp))
        .bind(file)
        .execute(&mut **tx)
        .await
        .map_err(error)?;

    for statement in [
        SQL_MARK_FILE_CHANGES_DELETED,
        SQL_MARK_FILE_DATA_DELETED,
        SQL_MARK_FILE_MEDIA_DELETED,
        SQL_MARK_FILE_THUMBNAILS_DELETED,
        SQL_MARK_FILE_OBJECT_THUMBNAILS_DELETED,
    ] {
        sqlx::query(statement)
            .bind(millis(timestamp))
            .bind(file)
            .execute(&mut **tx)
            .await
            .map_err(error)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn props(entries: impl IntoIterator<Item = (&'static str, Value)>) -> Map {
        entries
            .into_iter()
            .map(|(key, value)| (Value::Keyword(key.to_owned()), value))
            .collect()
    }

    #[test]
    fn options_default_to_delayed_gc_with_chunks_of_one_hundred() {
        assert_eq!(
            options(&Map::new()).expect("options"),
            Options {
                skip_delay: false,
                chunk_size: DEFAULT_CHUNK_SIZE,
            }
        );
    }

    #[test]
    fn options_read_the_task_props() {
        let props = props([
            ("skip-delay", Value::Bool(true)),
            ("chunk-size", Value::Integer(25)),
        ]);
        assert_eq!(
            options(&props).expect("options"),
            Options {
                skip_delay: true,
                chunk_size: 25,
            }
        );
    }

    #[test]
    fn invalid_options_are_rejected() {
        assert!(options(&props([("skip-delay", Value::Integer(1))])).is_err());
        assert!(options(&props([("chunk-size", Value::Integer(0))])).is_err());
        assert!(options(&props([("chunk-size", Value::Str("10".to_owned()))])).is_err());
    }

    #[test]
    fn skip_delay_moves_the_run_timestamp_ten_years_ahead() {
        let before = Utc::now();
        let plain = timestamp(Options {
            skip_delay: false,
            chunk_size: DEFAULT_CHUNK_SIZE,
        });
        let delayed = timestamp(Options {
            skip_delay: true,
            chunk_size: DEFAULT_CHUNK_SIZE,
        });
        assert!(plain >= before);
        assert!(delayed >= before + TimeDelta::days(SKIP_DELAY_DAYS));
    }

    #[test]
    fn proc_order_matches_the_clojure_list() {
        assert_eq!(
            PROC_ORDER,
            [
                Proc::UploadSessions,
                Proc::Profiles,
                Proc::FileMediaObjects,
                Proc::FileObjectThumbnails,
                Proc::FileThumbnails,
                Proc::FileData,
                Proc::FileChanges,
                Proc::Files,
                Proc::Projects,
                Proc::Fonts,
                Proc::Teams,
            ]
        );
    }

    #[tokio::test]
    async fn invalid_props_fail_before_connecting() {
        let service = PgObjectsGc::new(
            db::Database::connect(db::DbOptions::new(
                "postgres://penpot:penpot@127.0.0.1:9/penpot",
            ))
            .expect("lazy pool"),
        );
        let error = service
            .run(&props([("chunk-size", Value::Integer(-1))]))
            .await
            .expect_err("invalid chunk size");
        assert!(error.message().contains("chunk-size"));
    }
}
