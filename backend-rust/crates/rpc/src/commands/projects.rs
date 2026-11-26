//! Project mutations and the per-project file list (M21).
//!
//! Ports `create-project`, `update-project-pin`, `rename-project`,
//! `delete-project` from `app.rpc.commands.projects` and `get-project-files`
//! from `app.rpc.commands.files`. The permission model is the one in those
//! namespaces: a call succeeds when the profile is a team member of the
//! project's team with the needed flag, or when `project_profile_rel` grants
//! it directly. A denied call answers `not-found/object-not-found`, never 403.
//!
//! Not ported: the organization-owner (Nitrate) fallback, the
//! `projects-per-team` quote, the `delete-object` webhook/audit events, and
//! the subscription-based deletion tiers. `delete-project` therefore uses the
//! configured `deletion-delay` (7 days by default), which is what
//! `app.features.logical-deletion/get-deletion-delay` falls back to when the
//! `subscriptions` flag is off.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use errors::Cause;
use transit::Value;
use uuid::Uuid;

use crate::auth::Clock;
use crate::commands::dashboard::{project_map, ProjectRow};
use crate::context::CommandContext;
use crate::params::{ParamKind, ParamSchema, ParamSpec};
use crate::registry::{Command, HandlerFuture, Registry};
use crate::response::CommandResult;

use super::{authentication_required, cause, not_found, params_validation};

/// `[:string {:min 1 :max 250}]` of the create/rename schemas.
pub const PROJECT_NAME_MAX: usize = 250;

/// The `is-owner` / `is-admin` / `can-edit` triple of one relation row, after
/// `get-permissions` in `app.rpc.commands.teams` and `.projects` folds them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct RoleFlags {
    pub is_owner: bool,
    pub is_admin: bool,
    pub can_edit: bool,
}

impl RoleFlags {
    /// `:can-edit` after the fold: owner and admin imply edition.
    #[must_use]
    pub const fn edits(self) -> bool {
        self.is_owner || self.is_admin || self.can_edit
    }
}

/// One row of `sql:project-files` in `app.rpc.commands.files`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectFileRow {
    pub id: Uuid,
    pub project_id: Uuid,
    pub team_id: Uuid,
    pub name: String,
    pub revn: i64,
    pub vern: i32,
    pub is_shared: bool,
    pub thumbnail_id: Option<Uuid>,
    pub created_at_ms: i64,
    pub modified_at_ms: i64,
}

/// Team and project permission reads plus the four project mutations.
///
/// Every method that writes owns its transaction: the router's
/// `TransactionHook` is still the M3 placeholder, and the create/delete paths
/// must commit several rows together.
#[async_trait]
pub trait ProjectStore: Send + Sync {
    /// `None` when the profile is not a member of a live team.
    async fn team_permissions(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause>;

    /// `None` when neither the team relation nor the project relation exists.
    async fn project_permissions(
        &self,
        profile_id: Uuid,
        project_id: Uuid,
    ) -> Result<Option<RoleFlags>, Cause>;

    async fn project_files(&self, project_id: Uuid) -> Result<Vec<ProjectFileRow>, Cause>;

    /// Insert the project, its owner relation and the caller's pin row.
    async fn create_project(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
        name: &str,
        now_ms: i64,
    ) -> Result<ProjectRow, Cause>;

    /// `sql:update-project-pin`; `false` when `team_id` does not own the
    /// project (the Clojure code would write a stray relation row instead).
    async fn set_project_pin(
        &self,
        profile_id: Uuid,
        team_id: Uuid,
        project_id: Uuid,
        is_pinned: bool,
    ) -> Result<bool, Cause>;

    /// Lock the row, then rename it. A soft-deleted project is not found.
    async fn rename_project(&self, project_id: Uuid, name: &str) -> Result<(), Cause>;

    /// Soft delete the project and enqueue `delete-object` in the same
    /// transaction.
    async fn delete_project(
        &self,
        project_id: Uuid,
        deleted_at_ms: i64,
        now_ms: i64,
        queue: &str,
    ) -> Result<(), Cause>;
}

/// Registers the M21 commands behind the default authenticated policy.
pub struct ProjectCommands {
    pub store: Arc<dyn ProjectStore>,
    /// Task queue of `delete-object`, already carrying the tenant prefix.
    pub queue: String,
    /// `deletion-delay` in milliseconds.
    pub deletion_delay_ms: i64,
    clock: Clock,
}

impl ProjectCommands {
    #[must_use]
    pub fn new(store: Arc<dyn ProjectStore>, tenant: &str, deletion_delay: Duration) -> Self {
        Self {
            store,
            queue: format!("{tenant}:default"),
            deletion_delay_ms: i64::try_from(deletion_delay.as_millis()).unwrap_or(i64::MAX),
            clock: Arc::new(system_now_ms),
        }
    }

    /// Freeze the handler clock. Tests use it; production keeps the wall
    /// clock.
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    pub fn register(&self, registry: &mut Registry) {
        let store = Arc::clone(&self.store);
        let clock = Arc::clone(&self.clock);
        registry.register(
            Command::new("create-project", move |ctx| {
                create_project(Arc::clone(&store), Arc::clone(&clock), ctx)
            })
            .params(ParamSchema::new([
                ParamSpec::required("team-id", ParamKind::Uuid),
                ParamSpec::required("name", ParamKind::Str),
            ])),
        );

        let store = Arc::clone(&self.store);
        registry.register(
            Command::new("update-project-pin", move |ctx| {
                update_project_pin(Arc::clone(&store), ctx)
            })
            .params(ParamSchema::new([
                ParamSpec::required("team-id", ParamKind::Uuid),
                ParamSpec::required("is-pinned", ParamKind::Bool),
                ParamSpec::required("id", ParamKind::Uuid),
            ])),
        );

        let store = Arc::clone(&self.store);
        registry.register(
            Command::new("rename-project", move |ctx| {
                rename_project(Arc::clone(&store), ctx)
            })
            .params(ParamSchema::new([
                ParamSpec::required("name", ParamKind::Str),
                ParamSpec::required("id", ParamKind::Uuid),
            ])),
        );

        let store = Arc::clone(&self.store);
        let clock = Arc::clone(&self.clock);
        let queue = self.queue.clone();
        let deletion_delay_ms = self.deletion_delay_ms;
        registry.register(
            Command::new("delete-project", move |ctx| {
                delete_project(
                    Arc::clone(&store),
                    Arc::clone(&clock),
                    queue.clone(),
                    deletion_delay_ms,
                    ctx,
                )
            })
            .params(ParamSchema::new([ParamSpec::required(
                "id",
                ParamKind::Uuid,
            )])),
        );

        let store = Arc::clone(&self.store);
        registry.register(
            Command::new("get-project-files", move |ctx| {
                get_project_files(Arc::clone(&store), ctx)
            })
            .params(ParamSchema::new([ParamSpec::required(
                "project-id",
                ParamKind::Uuid,
            )])),
        );
    }
}

fn system_now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

fn create_project(
    store: Arc<dyn ProjectStore>,
    clock: Clock,
    ctx: CommandContext,
) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team_id = required_uuid(&ctx, "team-id")?;
        let name = project_name(&ctx)?;
        match store.team_permissions(profile_id, team_id).await? {
            Some(flags) if flags.edits() => {}
            Some(_) | None => return Err(not_found()),
        }
        let row = store
            .create_project(profile_id, team_id, &name, clock())
            .await?;
        Ok(CommandResult::ok(project_map(&row)))
    })
}

fn update_project_pin(store: Arc<dyn ProjectStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let team_id = required_uuid(&ctx, "team-id")?;
        let project_id = required_uuid(&ctx, "id")?;
        let Some(Value::Bool(is_pinned)) = ctx.param("is-pinned").cloned() else {
            return Err(params_validation());
        };
        if store
            .project_permissions(profile_id, project_id)
            .await?
            .is_none()
        {
            return Err(not_found());
        }
        if !store
            .set_project_pin(profile_id, team_id, project_id, is_pinned)
            .await?
        {
            return Err(not_found());
        }
        Ok(CommandResult::empty())
    })
}

fn rename_project(store: Arc<dyn ProjectStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let project_id = required_uuid(&ctx, "id")?;
        let name = project_name(&ctx)?;
        match store.project_permissions(profile_id, project_id).await? {
            Some(flags) if flags.edits() => {}
            Some(_) | None => return Err(not_found()),
        }
        store.rename_project(project_id, &name).await?;
        Ok(CommandResult::empty())
    })
}

fn delete_project(
    store: Arc<dyn ProjectStore>,
    clock: Clock,
    queue: String,
    deletion_delay_ms: i64,
    ctx: CommandContext,
) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let project_id = required_uuid(&ctx, "id")?;
        match store.project_permissions(profile_id, project_id).await? {
            Some(flags) if flags.edits() => {}
            Some(_) | None => return Err(not_found()),
        }
        let now_ms = clock();
        let deleted_at_ms = now_ms.saturating_add(deletion_delay_ms);
        store
            .delete_project(project_id, deleted_at_ms, now_ms, &queue)
            .await?;
        Ok(CommandResult::empty())
    })
}

fn get_project_files(store: Arc<dyn ProjectStore>, ctx: CommandContext) -> HandlerFuture {
    Box::pin(async move {
        let profile_id = ctx.profile_id().ok_or_else(authentication_required)?;
        let project_id = required_uuid(&ctx, "project-id")?;
        if store
            .project_permissions(profile_id, project_id)
            .await?
            .is_none()
        {
            return Err(not_found());
        }
        let rows = store.project_files(project_id).await?;
        Ok(CommandResult::ok(Value::vector(
            rows.iter().map(project_file_map),
        )))
    })
}

fn required_uuid(ctx: &CommandContext, name: &str) -> Result<Uuid, Cause> {
    ctx.param(name)
        .and_then(Value::as_uuid)
        .ok_or_else(params_validation)
}

/// `[:string {:min 1 :max 250}]` then `d/normalize-string` (trim). malli counts
/// UTF-16 code units, so an astral character counts twice, like Java.
fn project_name(ctx: &CommandContext) -> Result<String, Cause> {
    let Some(raw) = ctx.param("name").and_then(Value::as_str) else {
        return Err(params_validation());
    };
    let length = raw.encode_utf16().count();
    if !(1..=PROJECT_NAME_MAX).contains(&length) {
        return Err(params_validation());
    }
    Ok(raw.trim().to_owned())
}

fn project_file_map(row: &ProjectFileRow) -> Value {
    Value::map([
        (Value::kw("id"), Value::Uuid(row.id)),
        (Value::kw("project-id"), Value::Uuid(row.project_id)),
        (Value::kw("team-id"), Value::Uuid(row.team_id)),
        (Value::kw("name"), Value::str(row.name.clone())),
        (Value::kw("revn"), Value::Integer(row.revn)),
        (Value::kw("vern"), Value::Integer(i64::from(row.vern))),
        (Value::kw("is-shared"), Value::Bool(row.is_shared)),
        (
            Value::kw("thumbnail-id"),
            row.thumbnail_id.map_or(Value::Nil, Value::Uuid),
        ),
        (Value::kw("created-at"), Value::Instant(row.created_at_ms)),
        (Value::kw("modified-at"), Value::Instant(row.modified_at_ms)),
    ])
}

/// `validation/non-deletable-project` of `delete-project`.
#[must_use]
pub fn non_deletable_project() -> Cause {
    cause(
        "validation",
        "non-deletable-project",
        Some("impossible to delete default project"),
    )
}
