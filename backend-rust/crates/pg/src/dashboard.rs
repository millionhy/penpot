//! `get-teams` and `get-projects` queries for the dashboard shell.
//!
//! Both statements mirror `app.rpc.commands.teams` and
//! `app.rpc.commands.projects`; the organization-owner fallback and the
//! subscription projection are not ported yet.

use async_trait::async_trait;
use db::Database;
use errors::Cause;
use rpc::commands::dashboard::{DashboardStore, ProjectRow, TeamRow};
use sqlx::Row;
use uuid::Uuid;

const SQL_TEAMS: &str = "SELECT t.id, t.name, t.photo_id, \
        COALESCE(t.id = p.default_team_id, false) AS is_default, \
        COALESCE(tp.is_owner, false) AS is_owner, \
        COALESCE(tp.is_admin, false) AS is_admin, \
        COALESCE(tp.can_edit, false) AS can_edit, \
        (extract(epoch FROM t.created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM t.modified_at) * 1000)::bigint AS modified_at_ms \
   FROM team_profile_rel AS tp \
   JOIN team AS t ON t.id = tp.team_id \
   JOIN profile AS p ON p.id = tp.profile_id \
  WHERE t.deleted_at IS NULL \
    AND tp.profile_id = $1 \
  ORDER BY tp.created_at ASC";

const SQL_TEAM_READ: &str = "SELECT EXISTS (\
        SELECT 1 \
          FROM team_profile_rel AS tpr \
          JOIN team AS t ON t.id = tpr.team_id \
         WHERE tpr.team_id = $1 \
           AND tpr.profile_id = $2 \
           AND t.deleted_at IS NULL\
    )";

const SQL_PROJECTS: &str = "SELECT p.id, p.name, p.team_id, p.is_default, \
        COALESCE(tpp.is_pinned, false) AS is_pinned, \
        (SELECT count(*) FROM file AS f \
          WHERE f.project_id = p.id AND f.deleted_at IS NULL) AS count, \
        (SELECT count(*) FROM file AS f \
          WHERE f.project_id = p.id) AS total_count, \
        (extract(epoch FROM p.created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM p.modified_at) * 1000)::bigint AS modified_at_ms, \
        CASE WHEN p.deleted_at IS NULL THEN NULL \
             ELSE (extract(epoch FROM p.deleted_at) * 1000)::bigint END \
            AS deleted_at_ms \
   FROM project AS p \
   JOIN team AS t ON t.id = p.team_id \
   LEFT JOIN team_project_profile_rel AS tpp \
          ON tpp.project_id = p.id \
         AND tpp.team_id = p.team_id \
         AND tpp.profile_id = $2 \
  WHERE p.team_id = $1 \
    AND t.deleted_at IS NULL \
  ORDER BY p.modified_at DESC";

/// PostgreSQL reads behind `DashboardCommands`.
#[derive(Debug, Clone)]
pub struct PgDashboardStore {
    database: Database,
}

impl PgDashboardStore {
    #[must_use]
    pub fn new(database: Database) -> Self {
        Self { database }
    }

    #[must_use]
    pub fn database(&self) -> &Database {
        &self.database
    }
}

#[async_trait]
impl DashboardStore for PgDashboardStore {
    async fn teams_for_profile(&self, profile_id: Uuid) -> Result<Vec<TeamRow>, Cause> {
        let rows = sqlx::query(SQL_TEAMS)
            .bind(profile_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;

        Ok(rows
            .into_iter()
            .map(|row| TeamRow {
                id: row.get("id"),
                name: row.get("name"),
                photo_id: row.get("photo_id"),
                is_default: row.get("is_default"),
                is_owner: row.get("is_owner"),
                is_admin: row.get("is_admin"),
                can_edit: row.get("can_edit"),
                created_at_ms: row.get("created_at_ms"),
                modified_at_ms: row.get("modified_at_ms"),
            })
            .collect())
    }

    async fn projects_for_team(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<ProjectRow>>, Cause> {
        let can_read: bool = sqlx::query_scalar(SQL_TEAM_READ)
            .bind(team_id)
            .bind(profile_id)
            .fetch_one(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        if !can_read {
            return Ok(None);
        }

        let rows = sqlx::query(SQL_PROJECTS)
            .bind(team_id)
            .bind(profile_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;

        Ok(Some(
            rows.into_iter()
                .map(|row| ProjectRow {
                    id: row.get("id"),
                    name: row.get("name"),
                    team_id: row.get("team_id"),
                    is_default: row.get("is_default"),
                    is_pinned: row.get("is_pinned"),
                    count: row.get("count"),
                    total_count: row.get("total_count"),
                    created_at_ms: row.get("created_at_ms"),
                    modified_at_ms: row.get("modified_at_ms"),
                    deleted_at_ms: row.get("deleted_at_ms"),
                })
                .collect(),
        ))
    }
}
