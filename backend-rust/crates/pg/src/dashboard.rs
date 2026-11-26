//! Dashboard queries for the shell (M18, M19).
//!
//! Both statements mirror `app.rpc.commands.teams` and
//! `app.rpc.commands.projects`; M19 adds `sql:team-recent-files`, the
//! `team_font_variant` read, `sql:team-members` and the unread comment-thread
//! queries. The organization-owner fallback, the subscription projection and
//! share-link access are not ported yet.

use async_trait::async_trait;
use db::Database;
use errors::Cause;
use rpc::commands::dashboard::{
    CommentThreadRow, DashboardStore, FontScope, FontVariantRow, ProjectRow, RecentFileRow,
    TeamMemberRow, TeamRow,
};
use sqlx::Row;
use transit::Value;
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

const SQL_TEAM_RECENT_FILES: &str = "WITH recent_files AS ( \
        SELECT f.id, f.revn, f.vern, f.project_id, f.created_at, f.modified_at, \
               f.name, f.is_shared, ft.media_id AS thumbnail_id, \
               row_number() OVER w AS row_num, p.team_id \
          FROM file AS f \
          JOIN project AS p ON (p.id = f.project_id) \
          LEFT JOIN file_thumbnail AS ft ON (ft.file_id = f.id \
                                             AND ft.revn = f.revn \
                                             AND ft.deleted_at IS NULL) \
         WHERE p.team_id = $1 \
           AND p.deleted_at IS NULL \
           AND f.deleted_at IS NULL \
        WINDOW w AS (PARTITION BY f.project_id ORDER BY f.modified_at DESC) \
         ORDER BY f.modified_at DESC \
    ) \
    SELECT id, revn, vern, project_id, team_id, name, is_shared, thumbnail_id, row_num, \
           (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
           (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms \
      FROM recent_files \
     WHERE row_num <= 10";

const SQL_FONT_VARIANTS: &str = "SELECT id, team_id, profile_id, font_id, font_family, \
        font_weight, font_style, variant_name, \
        otf_file_id, ttf_file_id, woff1_file_id, woff2_file_id, \
        (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms \
   FROM team_font_variant \
  WHERE team_id = $1 \
    AND deleted_at IS NULL \
  ORDER BY font_family, font_weight, font_style";

const SQL_TEAM_MEMBERS: &str = "SELECT tp.team_id, tp.profile_id, \
        COALESCE(tp.is_owner, false) AS is_owner, \
        COALESCE(tp.is_admin, false) AS is_admin, \
        COALESCE(tp.can_edit, false) AS can_edit, \
        (extract(epoch FROM tp.created_at) * 1000)::bigint AS created_at_ms, \
        (extract(epoch FROM tp.modified_at) * 1000)::bigint AS modified_at_ms, \
        p.id, p.email, p.fullname, p.photo_id, p.is_active \
   FROM team_profile_rel AS tp \
   JOIN profile AS p ON (p.id = tp.profile_id) \
  WHERE tp.team_id = $1 \
  ORDER BY tp.created_at ASC";

/// The unread-thread scan shared by the `:all` and `:partial` notification
/// preferences of `sql:unread-all-comment-threads-by-team` and its partial
/// twin. `PREFIX` is empty for `:all` and adds the owner-or-mention filter for
/// `:partial`.
const SQL_UNREAD_THREADS: &str = "WITH threads AS ( \
        SELECT DISTINCT ON (ct.id) \
               ct.id, ct.file_id, ct.owner_id, ct.page_id, ct.seqn, ct.is_resolved, \
               ct.participants::text AS participants, \
               COALESCE(ct.mentions, '{}') AS mentions, \
               (ct.position)[0] AS position_x, \
               (ct.position)[1] AS position_y, \
               pf.fullname AS owner_fullname, \
               pf.email AS owner_email, \
               pf.photo_id AS owner_photo_id, \
               p.team_id AS team_id, \
               f.name AS file_name, \
               f.project_id AS project_id, \
               first_value(c.content) OVER w AS content, \
               (SELECT count(1) FROM comment AS c2 \
                 WHERE c2.thread_id = ct.id) AS count_comments, \
               (SELECT count(1) FROM comment AS c2 \
                 WHERE c2.thread_id = ct.id \
                   AND c2.created_at >= coalesce(cts.modified_at, ct.created_at)) \
                   AS count_unread_comments, \
               ct.created_at, ct.modified_at \
          FROM comment_thread AS ct \
          JOIN comment AS c ON (c.thread_id = ct.id) \
          JOIN file AS f ON (f.id = ct.file_id) \
          JOIN project AS p ON (p.id = f.project_id) \
          LEFT JOIN comment_thread_status AS cts \
                 ON (cts.thread_id = ct.id AND cts.profile_id = $1) \
          LEFT JOIN profile AS pf ON (pf.id = ct.owner_id) \
         WHERE f.deleted_at IS NULL \
           AND p.deleted_at IS NULL \
           AND p.team_id = $2 \
           PREFIX \
        WINDOW w AS (PARTITION BY c.thread_id ORDER BY c.created_at ASC) \
    ) \
    SELECT id, file_id, owner_id, page_id, seqn, is_resolved, participants, mentions, \
           position_x, position_y, owner_fullname, owner_email, owner_photo_id, \
           team_id, file_name, project_id, content, count_comments, \
           count_unread_comments, \
           (extract(epoch FROM created_at) * 1000)::bigint AS created_at_ms, \
           (extract(epoch FROM modified_at) * 1000)::bigint AS modified_at_ms \
      FROM threads \
     WHERE count_unread_comments > 0";

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

    async fn can_read_team(&self, profile_id: Uuid, team_id: Uuid) -> Result<bool, Cause> {
        sqlx::query_scalar(SQL_TEAM_READ)
            .bind(team_id)
            .bind(profile_id)
            .fetch_one(self.database.pool())
            .await
            .map_err(db::map_sqlx)
    }

    /// Resolve a font scope to its team and check membership. `None` means
    /// the scope names a row the caller cannot read.
    async fn font_team(&self, profile_id: Uuid, scope: FontScope) -> Result<Option<Uuid>, Cause> {
        let team_id = match scope {
            FontScope::Team(id) => id,
            FontScope::Project(id) => {
                let row =
                    sqlx::query("SELECT team_id FROM project WHERE id = $1 AND deleted_at IS NULL")
                        .bind(id)
                        .fetch_optional(self.database.pool())
                        .await
                        .map_err(db::map_sqlx)?;
                let Some(row) = row else {
                    return Ok(None);
                };
                row.try_get("team_id").map_err(db::map_sqlx)?
            }
            FontScope::File(id) => {
                let row = sqlx::query(
                    "SELECT p.team_id \
                       FROM file AS f \
                       JOIN project AS p ON p.id = f.project_id \
                      WHERE f.id = $1 \
                        AND f.deleted_at IS NULL \
                        AND p.deleted_at IS NULL",
                )
                .bind(id)
                .fetch_optional(self.database.pool())
                .await
                .map_err(db::map_sqlx)?;
                let Some(row) = row else {
                    return Ok(None);
                };
                row.try_get("team_id").map_err(db::map_sqlx)?
            }
        };
        if !self.can_read_team(profile_id, team_id).await? {
            return Ok(None);
        }
        Ok(Some(team_id))
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
        if !self.can_read_team(profile_id, team_id).await? {
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

    async fn recent_files(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<RecentFileRow>>, Cause> {
        if !self.can_read_team(profile_id, team_id).await? {
            return Ok(None);
        }

        let rows = sqlx::query(SQL_TEAM_RECENT_FILES)
            .bind(team_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;

        Ok(Some(
            rows.into_iter()
                .map(|row| RecentFileRow {
                    id: row.get("id"),
                    revn: row.get("revn"),
                    vern: row.get("vern"),
                    project_id: row.get("project_id"),
                    team_id: row.get("team_id"),
                    name: row.get("name"),
                    is_shared: row.get("is_shared"),
                    thumbnail_id: row.get("thumbnail_id"),
                    row_num: row.get("row_num"),
                    created_at_ms: row.get("created_at_ms"),
                    modified_at_ms: row.get("modified_at_ms"),
                })
                .collect(),
        ))
    }

    async fn font_variants(
        &self,
        profile_id: Uuid,
        scope: FontScope,
    ) -> Result<Option<Vec<FontVariantRow>>, Cause> {
        let Some(team_id) = self.font_team(profile_id, scope).await? else {
            return Ok(None);
        };

        let rows = sqlx::query(SQL_FONT_VARIANTS)
            .bind(team_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;

        Ok(Some(
            rows.into_iter()
                .map(|row| FontVariantRow {
                    id: row.get("id"),
                    team_id: row.get("team_id"),
                    profile_id: row.get("profile_id"),
                    font_id: row.get("font_id"),
                    font_family: row.get("font_family"),
                    font_weight: row.get("font_weight"),
                    font_style: row.get("font_style"),
                    variant_name: row.get("variant_name"),
                    otf_file_id: row.get("otf_file_id"),
                    ttf_file_id: row.get("ttf_file_id"),
                    woff1_file_id: row.get("woff1_file_id"),
                    woff2_file_id: row.get("woff2_file_id"),
                    created_at_ms: row.get("created_at_ms"),
                    modified_at_ms: row.get("modified_at_ms"),
                })
                .collect(),
        ))
    }

    async fn team_members(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<TeamMemberRow>>, Cause> {
        if !self.can_read_team(profile_id, team_id).await? {
            return Ok(None);
        }

        let rows = sqlx::query(SQL_TEAM_MEMBERS)
            .bind(team_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;

        Ok(Some(
            rows.into_iter()
                .map(|row| TeamMemberRow {
                    id: row.get("id"),
                    team_id: row.get("team_id"),
                    profile_id: row.get("profile_id"),
                    email: row.get("email"),
                    fullname: row.get("fullname"),
                    photo_id: row.get("photo_id"),
                    is_active: row.get("is_active"),
                    is_owner: row.get("is_owner"),
                    is_admin: row.get("is_admin"),
                    can_edit: row.get("can_edit"),
                    created_at_ms: row.get("created_at_ms"),
                    modified_at_ms: row.get("modified_at_ms"),
                })
                .collect(),
        ))
    }

    async fn unread_comment_threads(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<CommentThreadRow>>, Cause> {
        if !self.can_read_team(profile_id, team_id).await? {
            return Ok(None);
        }

        let Some(mode) = self.notification_mode(profile_id).await? else {
            return Ok(None);
        };
        if mode == NotificationMode::Off {
            return Ok(Some(Vec::new()));
        }

        let sql = if mode == NotificationMode::Partial {
            SQL_UNREAD_THREADS.replace("PREFIX", "AND (ct.owner_id = $1 OR $1 = ANY(ct.mentions))")
        } else {
            SQL_UNREAD_THREADS.replace("PREFIX", "")
        };

        let rows = sqlx::query(sqlx::AssertSqlSafe(sql))
            .bind(profile_id)
            .bind(team_id)
            .fetch_all(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;

        Ok(Some(
            rows.into_iter()
                .map(|row| CommentThreadRow {
                    id: row.get("id"),
                    file_id: row.get("file_id"),
                    owner_id: row.get("owner_id"),
                    page_id: row.get("page_id"),
                    seqn: row.get("seqn"),
                    position_x: row.get("position_x"),
                    position_y: row.get("position_y"),
                    is_resolved: row.get("is_resolved"),
                    participants: decode_participants(row.get("participants")),
                    mentions: row.get("mentions"),
                    owner_fullname: row.get("owner_fullname"),
                    owner_email: row.get("owner_email"),
                    owner_photo_id: row.get("owner_photo_id"),
                    team_id: row.get("team_id"),
                    file_name: row.get("file_name"),
                    project_id: row.get("project_id"),
                    content: row.get("content"),
                    count_comments: row.get("count_comments"),
                    count_unread_comments: row.get("count_unread_comments"),
                    created_at_ms: row.get("created_at_ms"),
                    modified_at_ms: row.get("modified_at_ms"),
                })
                .collect(),
        ))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationMode {
    All,
    Partial,
    Off,
}

impl PgDashboardStore {
    /// `(or (-> profile :props :notifications :dashboard-comments) :all)`.
    /// `None` when the profile row is gone.
    async fn notification_mode(&self, profile_id: Uuid) -> Result<Option<NotificationMode>, Cause> {
        let row = sqlx::query("SELECT props::text AS props FROM profile WHERE id = $1")
            .bind(profile_id)
            .fetch_optional(self.database.pool())
            .await
            .map_err(db::map_sqlx)?;
        let Some(row) = row else {
            return Ok(None);
        };
        let text: Option<String> = row.try_get("props").map_err(db::map_sqlx)?;
        Ok(Some(notification_mode_from_props(text.as_deref())))
    }
}

fn notification_mode_from_props(text: Option<&str>) -> NotificationMode {
    let Some(text) = text else {
        return NotificationMode::All;
    };
    let Ok(props) = transit::decode(text) else {
        return NotificationMode::All;
    };
    let preference = props
        .get_kw("notifications")
        .and_then(Value::as_map)
        .and_then(|map| map.get_kw("dashboard-comments"))
        .and_then(Value::as_keyword);
    match preference {
        Some("partial") => NotificationMode::Partial,
        Some("all") | None => NotificationMode::All,
        Some(_) => NotificationMode::Off,
    }
}

/// `participants` is Transit in JSONB. A malformed value becomes an empty set
/// so one bad row cannot take down the dashboard feed.
fn decode_participants(text: String) -> Value {
    match transit::decode(&text) {
        Ok(value @ (Value::Set(_) | Value::List(_) | Value::Array(_))) => value,
        Ok(_) => Value::Set(transit::Set::new()),
        Err(error) => {
            tracing::warn!(error = %error, "comment participants are not readable transit");
            Value::Set(transit::Set::new())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_preference_wants_every_thread() {
        assert_eq!(notification_mode_from_props(None), NotificationMode::All);
    }

    #[test]
    fn the_preference_reads_all_partial_and_off() {
        let all = r#"["^ ","~:notifications",["^ ","~:dashboard-comments","~:all"]]"#;
        let partial = r#"["^ ","~:notifications",["^ ","~:dashboard-comments","~:partial"]]"#;
        let off = r#"["^ ","~:notifications",["^ ","~:dashboard-comments","~:none"]]"#;
        assert_eq!(
            notification_mode_from_props(Some(all)),
            NotificationMode::All
        );
        assert_eq!(
            notification_mode_from_props(Some(partial)),
            NotificationMode::Partial
        );
        assert_eq!(
            notification_mode_from_props(Some(off)),
            NotificationMode::Off
        );
    }

    #[test]
    fn unreadable_props_fall_back_to_all() {
        assert_eq!(
            notification_mode_from_props(Some("{not transit")),
            NotificationMode::All
        );
    }

    #[test]
    fn participants_decode_as_a_transit_set() {
        let text = r#"["~#set",["~u7d1c3f16-8f1e-4b1a-9e2d-3a4b5c6d7e8f"]]"#;
        let value = decode_participants(text.to_owned());
        assert!(matches!(value, Value::Set(_)));
        assert_eq!(
            value.items().map(|items| items.len()),
            Some(1),
            "the set keeps its one uuid"
        );
    }

    #[test]
    fn unreadable_participants_become_an_empty_set() {
        let value = decode_participants("not transit".to_owned());
        assert_eq!(value.items().map(|items| items.len()), Some(0));
    }
}
