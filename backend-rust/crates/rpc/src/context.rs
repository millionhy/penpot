//! Per-request data handed to a command.

use std::collections::BTreeSet;

use axum::http::{HeaderMap, Method};
use transit::Value;
use uuid::Uuid;

/// Which route group served the request (`::rpc/module` in the Clojure code).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Module {
    Main,
    Management,
}

impl Module {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Main => "main",
            Self::Management => "management",
        }
    }
}

/// How the caller authenticated (`::rpc/auth-type`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AuthType {
    Session,
    Token,
}

impl AuthType {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Token => "token",
        }
    }
}

/// The identity resolved for a request.
///
/// The real header/cookie decoding lands with the `session` crate (M4). Until
/// then [`crate::SessionResolver`] implementations fill this in.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Identity {
    /// `:uid` of the session claims, or the access-token profile.
    pub profile_id: Option<Uuid>,
    pub auth_type: Option<AuthType>,
    /// `::actoken/perms` of an access token.
    pub token_perms: BTreeSet<String>,
    /// `::http/auth-key-id` of a management request.
    pub auth_key_id: Option<String>,
}

impl Identity {
    #[must_use]
    pub fn is_authenticated(&self) -> bool {
        self.profile_id.is_some()
    }

    #[must_use]
    pub fn with_profile(mut self, profile_id: Uuid, auth_type: AuthType) -> Self {
        self.profile_id = Some(profile_id);
        self.auth_type = Some(auth_type);
        self
    }
}

/// Everything a command handler sees for one request.
#[derive(Debug, Clone)]
pub struct CommandContext {
    /// Command name without the route prefix.
    pub name: String,
    pub module: Module,
    pub method: Method,
    /// Request path, kept for audit and error reports.
    pub path: String,
    /// A fresh UUID per request (`::rpc/request-id`).
    pub request_id: Uuid,
    /// `x-session-id`, when the client sent a parseable UUID.
    pub session_id: Option<Uuid>,
    /// `x-real-ip`, the first `x-forwarded-for` hop, or the peer address.
    pub client_ip: Option<String>,
    /// Validated parameters, keyword-keyed.
    pub params: Value,
    pub identity: Identity,
    pub headers: HeaderMap,
}

impl CommandContext {
    /// Look up a validated parameter.
    #[must_use]
    pub fn param(&self, name: &str) -> Option<&Value> {
        self.params.get_kw(name)
    }

    #[must_use]
    pub fn profile_id(&self) -> Option<Uuid> {
        self.identity.profile_id
    }
}
