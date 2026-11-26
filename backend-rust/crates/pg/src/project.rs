//! Project writes and reads for the dashboard (M21).
//!
//! The permission queries restate `sql:team-permissions` and
//! `sql:project-permissions`; the writes restate `create-project`,
//! `sql:update-project-pin`, `rename-project`, `delete-project` and
//! `sql:project-files`. `create-project` and `delete-project` own one
//! transaction each, because Clojure's `::db/transaction` marker covers
//! several statements.

use async_trait::async_trait;
use db::Database;
use errors::Cause;
use rpc::commands::dashboard::ProjectRow;
use rpc::commands::projects::{non_deletable_project, ProjectFileRow, ProjectStore, RoleFlags};
use sqlx::Row;
use transit::Value;
use uuid::Uuid;

/// `sql:team-permissions` folded into one row.
const SQL_TEAM_PERMISSIONS: &str = "SELECT count(*) AS row_count, \
        COALESCE(bool_or(COALESCE(tpr.is_owner, false)), false) AS is_owner, \
        COALESCE(bool_or(COALESCE(tpr.is_admin, false)), false) AS is_admin, \
        COALESCE(bool_or(COALESCE(tpr.can_edit, false)), false) AS can_edit \
   FROM team_profile_rel AS tpr \
   JOIN team AS t ON (t.id = tpr.team_id) \
  WHERE tpr.profile_id = $1 \
    AND tpr.team_id = $2 \
    AND t.deleted_at IS NULL";

/// `sql:project-permissions`: the team relation plus the project relation.
const SQL_PROJECT_PERMISSIONS: &str = "WITH perms AS ( \
        SELECT COALESCE(tpr.is_owner, false) AS is_owner, \
               COALESCE(tpr.is_admin, false) AS is_admin, \
               COALESCE(tpr.can_edit, false) AS can_edit \
          FROM team_profile_rel AS tpr \
          JOIN project AS p ON (p.team_id = tpr.team_id) \
         WHERE p.id = $1 \
           AND tpr.profile_id = $2 \
        UNION ALL \
        SELECT COALESCE(ppr.is_owner, false), \
               COALESCE(ppr.is_admin, false), \
               COALESCE(ppr.can_edit, false) \
          FROM project_profile_rel AS ppr \
         WHERE ppr.project_id = $1 \
           AND ppr.profile_id = $2 \
    ) \
    SELECT count(*) AS row_count, \
           COALESCE(bool_or(is_owner), false) AS is_owner, \
           COALESCE(bool_or(is_admin), false) AS is_admin, \
           COALESCE(bool_or(can_edit), false) AS can_edit \
      FROM perms";

/// `sql:project-files`.
const SQL_PROJECT_FILES: &str = "SELECT f.id, f.project_id, \
        (extract(epoch FROM f.created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM f.modified_at) * 1000)::bigint AS modified_at_ms, \
        f.name, f.revn, f.vern, f.is_shared, \
        ft.media_id AS thumbnail_id, p.team_id \
   FROM file AS f \
   JOIN project AS p ON (p.id = f.project_id) \
   LEFT JOIN file_thumbnail AS ft ON (ft.file_id = f.id \
                                      AND ft.revn = f.revn \
                                      AND ft.deleted_at IS NULL) \
  WHERE f.project_id = $1 \
    AND f.deleted_at IS NULL \
  ORDER BY f.modified_at DESC";

/// `teams/create-project` insert, returning the row `project_map` wants.
const SQL_INSERT_PROJECT: &str = "INSERT INTO project \
        (id, team_id, name, is_default, created_at, modified_at) \
   VALUES ($1, $2, $3, false, \
           to_timestamp($4::bigint::double precision / 1000.0), \
           to_timestamp($5::bigint::double precision / 1000.0)) \
  RETURNING id, name, team_id, is_default, \
        (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms";

/// `create-project-role` with `:owner` (all three flags true).
const SQL_INSERT_PROJECT_OWNER: &str = "INSERT INTO project_profile_rel \
        (id, project_id, profile_id, is_owner, is_admin, can_edit) \
   VALUES ($1, $2, $3, true, true, true)";

/// The `team-project-profile-rel` insert of `create-project`.
const SQL_INSERT_PROJECT_PIN_ROW: &str = "INSERT INTO team_project_profile_rel \
        (id, team_id, project_id, profile_id, created_at, modified_at, is_pinned) \
   VALUES ($1, $2, $3, $4, \
           to_timestamp($5::bigint::double precision / 1000.0), \
           to_timestamp($6::bigint::double precision / 1000.0), \
           false)";

/// `sql:update-project-pin`, guarded so `team-id` must own the project.
const SQL_UPSERT_PROJECT_PIN: &str = "INSERT INTO team_project_profile_rel \
        (team_id, project_id, profile_id, is_pinned) \
   SELECT p.team_id, p.id, $3, $4 \
     FROM project AS p \
    WHERE p.id = $2 \
      AND p.team_id = $1 \
   ON CONFLICT (team_id, project_id, profile_id) \
   DO UPDATE SET is_pinned = $4";

/// `sql:insert-new-task` (the `delete-object` enqueue).
const SQL_INSERT_TASK: &str = "INSERT INTO task \
        (id, name, props, queue, label, priority, max_retries, \
         created_at, modified_at, scheduled_at) \
   VALUES ($1, $2, $3::text::jsonb, $4, $5, $6, $7, \
           to_timestamp($8::bigint::double precision / 1000.0), \
           to_timestamp($9::bigint::double precision / 1000.0), \
           to_timestamp($10::bigint::double precision / 1000.0))";

/// PostgreSQL project store.
#[derive(Debug, Clone)]
pub struct PgProjectStore {
    database: Database,
}

impl PgProjectStore {
    #[must_use]
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    #[must_use]
    pub fn database(&self) -> &Database {
        &self.database
    }

    async fn role_flags(
        &self,
        sql: &'static str,
        profile_id: Uuid,
        id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause> {
        let row = sqlx::query(sql)
            .bind(profile_id)
            .bind(id)
            .fetch_one(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        let count: i64 = row.try_get("row_count").map_err(db::map_sqlx)?;
        if count == 0 {
            return Ok(None);
        }
        Ok(Some(RoleFlags {
            is_owner: row.try_get("is_owner").map_err(db::map_sqlx)?,
            is_admin: row.try_get("is_admin").map_err(db::map_sqlx)?,
            can_edit: row.try_get("can_edit").map_err(db::map_sqlx)?,
        }))
    }
}

#[async_trait]
impl ProjectStore for PgProjectStore {
    async fn team_permissions(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause> {
        self.role_flags(SQL_TEAM_PERMISSIONS, profile_id, team_id)
            .await
    }

    async fn project_permissions(
        &self,
        profile_id: Uuid,
        project_id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause> {
        // The placeholder order of `SQL_PROJECT_PERMISSIONS` is project first.
        let row = sqlx::query(SQL_PROJECT_PERMISSIONS)
            .bind(project_id)
            .bind(profile_id)
            .fetch_one(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        let count: i64 = row.try_get("row_count").map_err(db::map_sqlx)?;
        if count == 0 {
            return Ok(None);
        }
        Ok(Some(RoleFlags {
            is_owner: row.try_get("is_owner").map_err(db::map_sqlx)?,
            is_admin: row.try_get("is_admin").map_err(db::map_sqlx)?,
            can_edit: row.try_get("can_edit").map_err(db::map_sqlx)?,
        }))
    }

    async fn project_files(&self, project_id: Uuid) -> Result<Vec<ProjectFileRow>, Cause> {
        let rows = sqlx::query(SQL_PROJECT_FILES)
            .bind(project_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        Ok(rows
            .into_iter()
            .map(|row| ProjectFileRow {
                id: row.get("id"),
                project_id: row.get("project_id"),
                team_id: row.get("team_id"),
                name: row.get("name"),
                revn: row.get("revn"),
                vern: row.get("vern"),
                is_shared: row.get("is_shared"),
                thumbnail_id: row.get("thumbnail_id"),
                created_at_ms: row.get("created_at_ms"),
                modified_at_ms: row.get("modified_at_ms"),
            })
            .collect())
    }

    async fn create_project(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
        name: &str,
        now_ms: i64,
    ) -> Result<ProjectRow, Cause> {
        let mut tx = self.database.begin().await?;
        let project_id = Uuid::new_v4();
        let row = sqlx::query(SQL_INSERT_PROJECT)
            .bind(project_id)
            .bind(team_id)
            .bind(name)
            .bind(now_ms)
            .bind(now_ms)
            .fetch_one(&mut *tx)
            .await
            .map_err(db::map_sqlx)?;

        sqlx::query(SQL_INSERT_PROJECT_OWNER)
            .bind(Uuid::new_v4())
            .bind(project_id)
            .bind(profile_id)
            .execute(&mut *tx)
            .await
            .map_err(db::map_sqlx)?;

        sqlx::query(SQL_INSERT_PROJECT_PIN_ROW)
            .bind(Uuid::new_v4())
            .bind(team_id)
            .bind(project_id)
            .bind(profile_id)
            .bind(now_ms)
            .bind(now_ms)
            .execute(&mut *tx)
            .await
            .map_err(db::map_sqlx)?;

        tx.commit().await.map_err(db::map_sqlx)?;

        Ok(ProjectRow {
            id: row.try_get("id").map_err(db::map_sqlx)?,
            name: row.try_get("name").map_err(db::map_sqlx)?,
            team_id: row.try_get("team_id").map_err(db::map_sqlx)?,
            is_default: row.try_get("is_default").map_err(db::map_sqlx)?,
            is_pinned: false,
            count: 0,
            total_count: 0,
            created_at_ms: row.try_get("created_at_ms").map_err(db::map_sqlx)?,
            modified_at_ms: row.try_get("modified_at_ms").map_err(db::map_sqlx)?,
            // A freshly inserted project is never soft deleted.
            deleted_at_ms: None,
        })
    }

    async fn set_project_pin(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
        project_id: Uuid,
        is_pinned: bool,
    ) -> Result<bool, Cause> {
        let result = sqlx::query(SQL_UPSERT_PROJECT_PIN)
            .bind(team_id)
            .bind(project_id)
            .bind(profile_id)
            .bind(is_pinned)
            .execute(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        Ok(result.rows_affected() > 0)
    }

    async fn rename_project(&self, project_id: Uuid, name: &str) -> Result<(), Cause> {
        let mut tx = self.database.begin().await?;
        let row = sqlx::query(
            "SELECT id FROM project \
              WHERE id = $1 \
                AND deleted_at IS NULL \
                FOR UPDATE",
        )
        .bind(project_id)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db::map_sqlx)?;
        if row.is_none() {
            return Err(not_found());
        }
        sqlx::query("UPDATE project SET name = $2 WHERE id = $1")
            .bind(project_id)
            .bind(name)
            .execute(&mut *tx)
            .await
            .map_err(db::map_sqlx)?;
        tx.commit().await.map_err(db::map_sqlx)?;
        Ok(())
    }

    async fn delete_project(
        &self,
        project_id: Uuid,
        deleted_at_ms: i64,
        now_ms: i64,
        queue: &str,
    ) -> Result<(), Cause> {
        let mut tx = self.database.begin().await?;
        let row = sqlx::query(
            "UPDATE project \
                SET deleted_at = to_timestamp($2::bigint::double precision / 1000.0) \
              WHERE id = $1 \
          RETURNING is_default",
        )
        .bind(project_id)
        .bind(deleted_at_ms)
        .fetch_optional(&mut *tx)
        .await
        .map_err(db::map_sqlx)?;
        let Some(row) = row else {
            return Err(not_found());
        };
        let is_default: bool = row.try_get("is_default").map_err(db::map_sqlx)?;
        if is_default {
            // Dropping `tx` rolls the deleted_at write back, like the
            // exception inside Clojure's transaction.
            return Err(non_deletable_project());
        }

        let props = Value::map([
            (Value::kw("object"), Value::kw("project")),
            (Value::kw("deleted-at"), Value::Instant(deleted_at_ms)),
            (Value::kw("id"), Value::Uuid(project_id)),
        ]);
        sqlx::query(SQL_INSERT_TASK)
            .bind(Uuid::new_v4())
            .bind("delete-object")
            .bind(transit::encode_verbose(&props))
            .bind(queue)
            .bind("")
            .bind(100_i16)
            .bind(3_i16)
            .bind(now_ms)
            .bind(now_ms)
            .bind(now_ms)
            .execute(&mut *tx)
            .await
            .map_err(db::map_sqlx)?;

        tx.commit().await.map_err(db::map_sqlx)?;
        Ok(())
    }
}

/// `not-found/object-not-found` as `app.rpc.permissions/make-check-fn` raises
/// it: the row vanished between the permission check and the write.
fn not_found() -> Cause {
    let map = Value::map([
        (Value::kw("type"), Value::kw("not-found")),
        (Value::kw("code"), Value::kw("object-not-found")),
        (Value::kw("hint"), Value::str("not found")),
    ]);
    Cause::error(map)
}
