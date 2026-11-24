//! Command registry and authorisation policy.

use std::collections::{BTreeMap, BTreeSet};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use errors::Cause;
use transit::{Set, Value};

use crate::context::{AuthType, CommandContext, Identity};
use crate::params::ParamSchema;
use crate::response::CommandResult;

/// The future a command handler returns.
pub type HandlerFuture =
    Pin<Box<dyn Future<Output = Result<CommandResult, Cause>> + Send + 'static>>;

/// A command handler: owned context in, owned result out.
pub type Handler = Arc<dyn Fn(CommandContext) -> HandlerFuture + Send + Sync + 'static>;

/// `::auth` / `::auth-type` / `::perms` metadata of a command.
#[derive(Debug, Clone)]
pub struct AuthPolicy {
    /// `::auth` defaults to true in `errors.clj`'s sibling wrappers.
    pub required: bool,
    pub auth_type: Option<AuthType>,
    pub perms: BTreeSet<String>,
}

impl Default for AuthPolicy {
    /// `(::auth mdata true)`: a command without explicit metadata requires a
    /// session.
    fn default() -> Self {
        Self::authenticated()
    }
}

impl AuthPolicy {
    /// `::auth false`.
    #[must_use]
    pub fn public() -> Self {
        Self {
            required: false,
            auth_type: None,
            perms: BTreeSet::new(),
        }
    }

    /// `::auth true` with no extra constraints (the default).
    #[must_use]
    pub fn authenticated() -> Self {
        Self {
            required: true,
            auth_type: None,
            perms: BTreeSet::new(),
        }
    }

    /// `::auth-type :token` plus required permissions.
    #[must_use]
    pub fn token(perms: impl IntoIterator<Item = impl Into<String>>) -> Self {
        Self {
            required: true,
            auth_type: Some(AuthType::Token),
            perms: perms.into_iter().map(Into::into).collect(),
        }
    }

    /// Require `::auth-type :token` without naming permissions.
    #[must_use]
    pub fn token_only() -> Self {
        Self::token(Vec::<String>::new())
    }
}

/// One registered command.
pub struct Command {
    pub name: String,
    pub auth: AuthPolicy,
    pub params: Option<ParamSchema>,
    /// `::db/transaction` metadata: the transaction hook wraps the call.
    pub transaction: bool,
    pub handler: Handler,
}

impl Command {
    #[must_use]
    pub fn new<F>(name: impl Into<String>, handler: F) -> Self
    where
        F: Fn(CommandContext) -> HandlerFuture + Send + Sync + 'static,
    {
        Self {
            name: name.into(),
            auth: AuthPolicy::authenticated(),
            params: None,
            transaction: false,
            handler: Arc::new(handler),
        }
    }

    #[must_use]
    pub fn public(mut self) -> Self {
        self.auth = AuthPolicy::public();
        self
    }

    #[must_use]
    pub fn auth(mut self, auth: AuthPolicy) -> Self {
        self.auth = auth;
        self
    }

    #[must_use]
    pub fn params(mut self, params: ParamSchema) -> Self {
        self.params = Some(params);
        self
    }

    #[must_use]
    pub fn transaction(mut self) -> Self {
        self.transaction = true;
        self
    }
}

/// `name → command`. Registration order does not matter; lookup is by name.
#[derive(Clone, Default)]
pub struct Registry {
    commands: BTreeMap<String, Arc<Command>>,
}

impl Registry {
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert a command, replacing any previous one with the same name.
    pub fn register(&mut self, command: Command) {
        self.commands
            .insert(command.name.clone(), Arc::new(command));
    }

    #[must_use]
    pub fn get(&self, name: &str) -> Option<Arc<Command>> {
        self.commands.get(name).cloned()
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.commands.keys().map(String::as_str)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.commands.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.commands.is_empty()
    }
}

/// `wrap-authentication`: the five failure branches of `rpc.clj`.
///
/// # Errors
///
/// A `:authentication/:authentication-required` or `:authorization/...`
/// [`Cause`] when the identity does not satisfy `policy`.
pub fn authorize(policy: &AuthPolicy, identity: &Identity) -> Result<(), Cause> {
    if policy.required && !identity.is_authenticated() {
        return Err(error(
            "authentication",
            "authentication-required",
            "authentication required for this endpoint",
        ));
    }

    if policy.auth_type == Some(AuthType::Token) && identity.auth_type != Some(AuthType::Token) {
        return Err(token_required());
    }

    if !policy.perms.is_empty() && identity.auth_type != Some(AuthType::Token) {
        return Err(token_required());
    }

    if !policy.perms.is_empty() && !policy.perms.is_subset(&identity.token_perms) {
        let required: Set = policy
            .perms
            .iter()
            .map(|perm| Value::kw(perm.clone()))
            .collect();
        return Err(Cause::error(Value::map([
            (Value::kw("type"), Value::kw("authorization")),
            (Value::kw("code"), Value::kw("missing-perms")),
            (
                Value::kw("hint"),
                Value::str("missing required permissions"),
            ),
            (Value::kw("required"), Value::Set(required)),
        ])));
    }

    Ok(())
}

fn token_required() -> Cause {
    error(
        "authorization",
        "token-auth-required",
        "access token authentication required for this endpoint",
    )
}

fn error(kind: &str, code: &str, hint: &str) -> Cause {
    Cause::error(Value::map([
        (Value::kw("type"), Value::kw(kind)),
        (Value::kw("code"), Value::kw(code)),
        (Value::kw("hint"), Value::str(hint)),
    ]))
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn session(profile: Uuid) -> Identity {
        Identity::default().with_profile(profile, AuthType::Session)
    }

    fn token(profile: Uuid, perms: &[&str]) -> Identity {
        Identity {
            token_perms: perms.iter().map(|perm| (*perm).to_owned()).collect(),
            ..Identity::default().with_profile(profile, AuthType::Token)
        }
    }

    #[test]
    fn public_commands_need_no_identity() {
        assert!(authorize(&AuthPolicy::public(), &Identity::default()).is_ok());
    }

    #[test]
    fn required_auth_rejects_an_anonymous_caller() {
        let cause = authorize(&AuthPolicy::authenticated(), &Identity::default()).unwrap_err();
        let data = cause.data().and_then(Value::as_map).unwrap();
        assert_eq!(
            data.get_kw("code").and_then(Value::as_keyword),
            Some("authentication-required")
        );
    }

    #[test]
    fn the_default_policy_requires_a_session() {
        let policy = AuthPolicy::default();
        assert!(policy.required);
        assert!(policy.auth_type.is_none());
        assert!(policy.perms.is_empty());
        assert!(authorize(&policy, &Identity::default()).is_err());
        assert!(authorize(&policy, &session(Uuid::new_v4())).is_ok());
    }

    #[test]
    fn token_policies_reject_session_identities() {
        let policy = AuthPolicy::token(["read"]);
        let cause = authorize(&policy, &session(Uuid::new_v4())).unwrap_err();
        let data = cause.data().and_then(Value::as_map).unwrap();
        assert_eq!(
            data.get_kw("code").and_then(Value::as_keyword),
            Some("token-auth-required")
        );
    }

    #[test]
    fn token_policies_check_permissions() {
        let policy = AuthPolicy::token(["read", "write"]);
        assert!(authorize(&policy, &token(Uuid::new_v4(), &["read", "write"])).is_ok());

        let cause = authorize(&policy, &token(Uuid::new_v4(), &["read"])).unwrap_err();
        let data = cause.data().and_then(Value::as_map).unwrap();
        assert_eq!(
            data.get_kw("code").and_then(Value::as_keyword),
            Some("missing-perms")
        );
    }

    #[test]
    fn registry_replaces_by_name() {
        let mut registry = Registry::new();
        registry.register(Command::new("get-x", |_| {
            Box::pin(async { Ok(CommandResult::empty()) })
        }));
        registry.register(Command::new("get-x", |_| {
            Box::pin(async { Ok(CommandResult::empty()) })
        }));
        assert_eq!(registry.len(), 1);
        assert!(registry.get("get-x").is_some());
        assert!(registry.get("get-y").is_none());
    }
}
