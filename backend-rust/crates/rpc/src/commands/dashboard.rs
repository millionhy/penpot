//! `get-teams` and `get-projects` (M18).
//!
//! The dashboard shell cannot render until these two reads answer, so the
//! login slice ports them from `app.rpc.commands.teams` and
//! `app.rpc.commands.projects`. Organization-owner visibility (Nitrate) and
//! the subscription projection are not ported.

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

fn authentication_required() -> Cause {
    cause("authentication", "authentication-required", None)
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
