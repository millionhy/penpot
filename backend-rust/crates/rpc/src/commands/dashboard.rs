//! Dashboard reads (M18, M19).
//!
//! M18 ported `get-teams` and `get-projects`, the two reads the shell needs
//! before it can render at all. M19 adds the content reads behind the
//! dashboard pages: recent files, team fonts, team members and unread comment
//! threads. They come from `app.rpc.commands.files`, `fonts`, `teams` and
//! `comments`. Organization-owner visibility (Nitrate), the subscription
//! projection, and share-link access to a file from another team are not
//! ported.

use std::sync::Arc;

use async_trait::async_trait;
use errors::Cause;
use transit::Value;
use uuid::Uuid;

use crate::context::CommandContext;
use crate::params::{ParamKind, ParamSchema, ParamSpec};
use crate::registry::{Command, HandlerFuture, Registry};
use crate::response::CommandResult;

/// One `team_profile_rel` row joined with its team, as `get-teams` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the membership row carries independent permission flags"
)]
pub struct TeamRow {
    pub id: Uuid,
    pub name: String,
    pub photo_id: Option<Uuid>,
    pub is_default: bool,
    pub is_owner: bool,
    pub is_admin: bool,
    pub can_edit: bool,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// One `project` row with the caller's pin flag and file counts.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectRow {
    pub id: Uuid,
    pub name: String,
    pub team_id: Uuid,
    pub is_default: bool,
    pub is_pinned: bool,
    pub count: i64,
    pub total_count: i64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

/// One `sql:team-recent-files` row: the ten most recently modified files per
/// project of a team.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecentFileRow {
    pub id: Uuid,
    pub revn: i64,
    pub vern: i32,
    pub project_id: Uuid,
    pub team_id: Uuid,
    pub name: String,
    pub is_shared: bool,
    pub thumbnail_id: Option<Uuid>,
    pub row_num: i64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// One `team_font_variant` row as `get-font-variants` returns it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FontVariantRow {
    pub id: Uuid,
    pub team_id: Uuid,
    pub profile_id: Option<Uuid>,
    pub font_id: Uuid,
    pub font_family: String,
    pub font_weight: i16,
    pub font_style: String,
    pub variant_name: Option<String>,
    pub otf_file_id: Option<Uuid>,
    pub ttf_file_id: Option<Uuid>,
    pub woff1_file_id: Option<Uuid>,
    pub woff2_file_id: Option<Uuid>,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// One `sql:team-members` row: the relation flags plus the profile identity.
#[derive(Debug, Clone, PartialEq, Eq)]
#[allow(
    clippy::struct_excessive_bools,
    reason = "the relation row carries independent permission flags"
)]
pub struct TeamMemberRow {
    /// The profile id; `tp.*` has its own id but the profile one wins, like the
    /// duplicate column label in `sql:team-members`.
    pub id: Uuid,
    pub team_id: Uuid,
    pub profile_id: Uuid,
    pub email: String,
    pub fullname: String,
    pub photo_id: Option<Uuid>,
    pub is_active: bool,
    pub is_owner: bool,
    pub is_admin: bool,
    pub can_edit: bool,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// One unread `comment_thread` row, with the joined owner, file and counts.
#[derive(Debug, Clone, PartialEq)]
pub struct CommentThreadRow {
    pub id: Uuid,
    pub file_id: Uuid,
    pub owner_id: Uuid,
    pub page_id: Uuid,
    pub seqn: i32,
    pub position_x: f64,
    pub position_y: f64,
    pub is_resolved: bool,
    pub participants: Value,
    pub mentions: Vec<Uuid>,
    pub owner_fullname: Option<String>,
    pub owner_email: Option<String>,
    pub owner_photo_id: Option<Uuid>,
    pub team_id: Uuid,
    pub file_name: String,
    pub project_id: Uuid,
    pub content: String,
    pub count_comments: i64,
    pub count_unread_comments: i64,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// Which team a font query resolves to. `get-font-variants` accepts one of
/// team, project or file, in that order of precedence.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FontScope {
    Team(Uuid),
    Project(Uuid),
    File(Uuid),
}

/// Team and project reads for the dashboard.
#[async_trait]
pub trait DashboardStore: Send + Sync {
    async fn teams_for_profile(&self, profile_id: Uuid) -> Result<Vec<TeamRow>, Cause>;

    /// `None` when `profile_id` cannot read the team.
    async fn projects_for_team(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<ProjectRow>>, Cause>;

    /// `None` when `profile_id` cannot read the team.
    async fn recent_files(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<RecentFileRow>>, Cause>;

    /// `None` when the scope names something `profile_id` cannot read.
    async fn font_variants(
        &self,
        profile_id: Uuid,
        scope: FontScope,
    ) -> Result<Option<Vec<FontVariantRow>>, Cause>;

    /// `None` when `profile_id` cannot read the team.
    async fn team_members(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<TeamMemberRow>>, Cause>;

    /// `None` when `profile_id` cannot read the team.
    async fn unread_comment_threads(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<Vec<CommentThreadRow>>, Cause>;
}

/// Registers both dashboard reads behind the default authenticated policy.
pub struct DashboardCommands {
    pub store: Arc<dyn DashboardStore>,
}

impl DashboardCommands {
    pub fn register(&self, registry: &mut Registry) {
        let teams = Arc::clone(&self.store);
        registry.register(
            Command::new("get-teams", move |ctx| get_teams(Arc::clone(&teams), ctx))
                .params(ParamSchema::new([])),
        );

        let projects = Arc::clone(&self.store);
        registry.register(
            Command::new("get-projects", move |ctx| {
                get_projects(Arc::clone(&projects), ctx)
            })
            .params(ParamSchema::new([ParamSpec::required(
                "team-id",
                ParamKind::Uuid,
            )])),
        );

        let recent = Arc::clone(&self.store);
        registry.register(
            Command::new("get-team-recent-files", move |ctx| {
                get_team_recent_files(Arc::clone(&recent), ctx)
            })
            .params(ParamSchema::new([ParamSpec::required(
                "team-id",
                ParamKind::Uuid,
            )])),
        );

        let fonts = Arc::clone(&self.store);
        registry.register(
            Command::new("get-font-variants", move |ctx| {
                get_font_variants(Arc::clone(&fonts), ctx)
            })
            .params(ParamSchema::new([
                ParamSpec::optional("team-id", ParamKind::Uuid),
                ParamSpec::optional("file-id", ParamKind::Uuid),
                ParamSpec::optional("project-id", ParamKind::Uuid),
                ParamSpec::optional("share-id", ParamKind::Uuid),
            ])),
        );

        let members = Arc::clone(&self.store);
        registry.register(
            Command::new("get-team-members", move |ctx| {
                get_team_members(Arc::clone(&members), ctx)
            })
            .params(ParamSchema::new([ParamSpec::required(
                "team-id",
                ParamKind::Uuid,
            )])),
        );

        let threads = Arc::clone(&self.store);
        registry.register(
            Command::new("get-unread-comment-threads", move |ctx| {
                get_unread_comment_threads(Arc::clone(&threads), ctx)
            })
            .params(ParamSchema::new([ParamSpec::required(
                "team-id",
                ParamKind::Uuid,
            )])),
        );
    }
}

fn get_teams(store: Arc<dyn DashboardStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let rows = store.teams_for_profile(profile_id).await?;
        Ok(CommandResult::ok(Value::vector(rows.iter().map(team_map))))
    })
}

fn get_projects(store: Arc<dyn DashboardStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team_id = ctx
            .param("team-id")
            .and_then(Value::as_uuid)
            .ok_or_else(|| cause("validation", "params-validation", None))?;
        let Some(rows) = store.projects_for_team(profile_id, team_id).await? else {
            return Err(cause("not-found", "object-not-found", Some("not found")));
        };
        Ok(CommandResult::ok(Value::vector(
            rows.iter().map(project_map),
        )))
    })
}

fn get_team_recent_files(store: Arc<dyn DashboardStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team_id = required_uuid(&ctx, "team-id")?;
        let Some(rows) = store.recent_files(profile_id, team_id).await? else {
            return Err(not_found());
        };
        Ok(CommandResult::ok(Value::vector(
            rows.iter().map(recent_file_map),
        )))
    })
}

fn get_font_variants(store: Arc<dyn DashboardStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team = ctx.param("team-id").and_then(Value::as_uuid);
        let project = ctx.param("project-id").and_then(Value::as_uuid);
        let file = ctx.param("file-id").and_then(Value::as_uuid);
        let scope = if let Some(id) = team {
            FontScope::Team(id)
        } else if let Some(id) = project {
            FontScope::Project(id)
        } else if let Some(id) = file {
            FontScope::File(id)
        } else {
            return Err(cause("validation", "params-validation", None));
        };
        let Some(rows) = store.font_variants(profile_id, scope).await? else {
            return Err(not_found());
        };
        Ok(CommandResult::ok(Value::vector(
            rows.iter().map(font_variant_map),
        )))
    })
}

fn get_team_members(store: Arc<dyn DashboardStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team_id = required_uuid(&ctx, "team-id")?;
        let Some(rows) = store.team_members(profile_id, team_id).await? else {
            return Err(not_found());
        };
        Ok(CommandResult::ok(Value::vector(
            rows.iter().map(team_member_map),
        )))
    })
}

fn get_unread_comment_threads(
    store: Arc<dyn DashboardStore>,
    ctx: CommandContext,
) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team_id = required_uuid(&ctx, "team-id")?;
        let Some(rows) = store.unread_comment_threads(profile_id, team_id).await? else {
            return Err(not_found());
        };
        Ok(CommandResult::ok(Value::vector(
            rows.iter().map(comment_thread_map),
        )))
    })
}

fn required_uuid(ctx: &CommandContext, name: &str) -> Result<Uuid, Cause> {
    ctx.param(name)
        .and_then(Value::as_uuid)
        .ok_or_else(|| cause("validation", "params-validation", None))
}

/// `process-permissions` in `app.rpc.commands.teams`: the three relation flags
/// collapse into the membership permissions map the frontend reads.
fn team_map(row: &TeamRow) -> Value {
    let is_admin = row.is_owner || row.is_admin;
    let can_edit = is_admin || row.can_edit;
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("name"), Value::str(row.name.clone())),
        (Value::kw("is-default"), Value::Bool(row.is_default)),
        (
            Value::kw("photo-id"),
            row.photo_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
        (
            Value::kw("permissions"),
            Value::map([
                (Value::kw("type"), Value::kw("membership")),
                (Value::kw("is-owner"), Value::Bool(row.is_owner)),
                (Value::kw("is-admin"), Value::Bool(is_admin)),
                (Value::kw("can-edit"), Value::Bool(can_edit)),
            ]),
        ),
    ])
}

fn project_map(row: &ProjectRow) -> Value {
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("name"), Value::str(row.name.clone())),
        (Value::kw("team-id"), Value::Uuid(row.team_id)),
        (Value::kw("is-default"), Value::Bool(row.is_default)),
        (Value::kw("is-pinned"), Value::Bool(row.is_pinned)),
        (Value::kw("count"), Value::Integer(row.count)),
        (Value::kw("total-count"), Value::Integer(row.total_count)),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
        (
            Value::kw("deleted-at"),
            row.deleted_at_ms.map_or(Value::Nil, Value::Instant),
        ),
    ])
}

fn recent_file_map(row: &RecentFileRow) -> Value {
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("revn"), Value::Integer(row.revn)),
        (Value::kw("vern"), Value::Integer(i64::from(row.vern))),
        (Value::kw("project-id"), Value::Uuid(row.project_id)),
        (Value::kw("team-id"), Value::Uuid(row.team_id)),
        (Value::kw("name"), Value::str(row.name.clone())),
        (Value::kw("is-shared"), Value::Bool(row.is_shared)),
        (
            Value::kw("thumbnail-id"),
            row.thumbnail_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("row-num"), Value::Integer(row.row_num)),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
    ])
}

fn font_variant_map(row: &FontVariantRow) -> Value {
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("team-id"), Value::Uuid(row.team_id)),
        (
            Value::kw("profile-id"),
            row.profile_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("font-id"), Value::Uuid(row.font_id)),
        (
            Value::kw("font-family"),
            Value::str(row.font_family.clone()),
        ),
        (
            Value::kw("font-weight"),
            Value::Integer(i64::from(row.font_weight)),
        ),
        (Value::kw("font-style"), Value::str(row.font_style.clone())),
        (
            Value::kw("variant-name"),
            row.variant_name.clone().map_or(Value::Nil, Value::str),
        ),
        (
            Value::kw("otf-file-id"),
            row.otf_file_id.map_or(Value::Nil, Value::Uuid),
        ),
        (
            Value::kw("ttf-file-id"),
            row.ttf_file_id.map_or(Value::Nil, Value::Uuid),
        ),
        (
            Value::kw("woff1-file-id"),
            row.woff1_file_id.map_or(Value::Nil, Value::Uuid),
        ),
        (
            Value::kw("woff2-file-id"),
            row.woff2_file_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
        (Value::kw("deleted-at"), Value::Nil),
    ])
}

fn team_member_map(row: &TeamMemberRow) -> Value {
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("team-id"), Value::Uuid(row.team_id)),
        (Value::kw("profile-id"), Value::Uuid(row.profile_id)),
        (Value::kw("email"), Value::str(row.email.clone())),
        (Value::kw("name"), Value::str(row.fullname.clone())),
        (Value::kw("fullname"), Value::str(row.fullname.clone())),
        (
            Value::kw("photo-id"),
            row.photo_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("is-active"), Value::Bool(row.is_active)),
        (Value::kw("is-owner"), Value::Bool(row.is_owner)),
        (Value::kw("is-admin"), Value::Bool(row.is_admin)),
        (Value::kw("can-edit"), Value::Bool(row.can_edit)),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
    ])
}

fn comment_thread_map(row: &CommentThreadRow) -> Value {
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("file-id"), Value::Uuid(row.file_id)),
        (Value::kw("owner-id"), Value::Uuid(row.owner_id)),
        (Value::kw("page-id"), Value::Uuid(row.page_id)),
        (Value::kw("seqn"), Value::Integer(i64::from(row.seqn))),
        (
            Value::kw("position"),
            Value::tagged(
                "point",
                Value::map([
                    (Value::kw("x"), Value::Double(row.position_x)),
                    (Value::kw("y"), Value::Double(row.position_y)),
                ]),
            ),
        ),
        (Value::kw("is-resolved"), Value::Bool(row.is_resolved)),
        (Value::kw("participants"), row.participants.clone()),
        (
            Value::kw("mentions"),
            Value::Set(row.mentions.iter().copied().map(Value::Uuid).collect()),
        ),
        (
            Value::kw("owner-fullname"),
            row.owner_fullname.clone().map_or(Value::Nil, Value::str),
        ),
        (
            Value::kw("owner-email"),
            row.owner_email.clone().map_or(Value::Nil, Value::str),
        ),
        (
            Value::kw("owner-photo-id"),
            row.owner_photo_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("team-id"), Value::Uuid(row.team_id)),
        (Value::kw("file-name"), Value::str(row.file_name.clone())),
        (Value::kw("project-id"), Value::Uuid(row.project_id)),
        (Value::kw("content"), Value::str(row.content.clone())),
        (
            Value::kw("count-comments"),
            Value::Integer(row.count_comments),
        ),
        (
            Value::kw("count-unread-comments"),
            Value::Integer(row.count_unread_comments),
        ),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
    ])
}

fn authentication_required() -> Cause {
    cause("authentication", "authentication-required", None)
}

fn not_found() -> Cause {
    cause("not-found", "object-not-found", Some("not found"))
}

fn cause(kind: &str, code: &str, hint: Option<&str>) -> Cause {
    let mut entries = vec![
        (Value::kw("type"), Value::kw(kind)),
        (Value::kw("code"), Value::kw(code)),
    ];
    if let Some(hint) = hint {
        entries.push((Value::kw("hint"), Value::str(hint)));
    }
    Cause::error(Value::map(entries))
}
