//! Penpot RPC dispatcher on axum.
//!
//! This crate mirrors the HTTP shell of `backend/src/app/rpc.clj`:
//!
//! * three routes: `/api/main/methods/{name}`, `/api/rpc/command/{name}`, and
//!   `/api/management/methods/{name}` (shared-key authorised);
//! * GET/HEAD only reach commands whose name starts with `get-`, otherwise the
//!   handler raises `:restriction/:method-not-allowed` (405) before it looks
//!   the command up;
//! * an unknown command raises `:not-found` (404);
//! * when `allowed-origins` is non-empty, CORS mirrors `mw/wrap-cors`:
//!   OPTIONS is 204, every response carries `Vary: Origin`, and only listed
//!   origins get the permissive headers;
//! * the request runs through the same stage order as the Clojure wrapper:
//!   authentication → params validation → nitrate-sso → audit → rlimit →
//!   metrics → climit → retry → cond → db-transaction → handler. M3
//!   implements authentication, params validation, a tracing span, and a
//!   transaction hook; the other stages are explicit no-ops until their
//!   milestones land (see `router.rs`).
//! * a `nil` result is a 204, a map/vector result is compact transit unless
//!   `transit-readable-response` is on or `transit_verbose` is in the query
//!   (then verbose transit), and errors reuse the `errors` crate.
//!
//! # Authentication
//!
//! [`auth::TokenResolver`] implements [`SessionResolver`] with the `session`
//! crate: it reads the `auth-token` cookie (or `Authorization: Bearer`),
//! checks the `{:kid 1 :ver 1}` header, verifies the JWE, and looks the
//! `:sid` up through [`auth::SessionStore`]. `Authorization: Token` resolves
//! access tokens through [`auth::AccessTokenStore`] when configured. Both
//! stores are traits so the router stays free of sqlx; the default
//! [`NoSessions`] still resolves nothing, so only public commands work.
//!
//! # Not yet
//!
//! * sqlx-backed stores and transactions. [`TransactionHook`] is the seam.
//! * `multipart/form-data` (axum's multipart feature needs the `multer` crate,
//!   which is not in the offline cache). The route rejects non-transit bodies
//!   with a `:params-validation` error instead of guessing.
//! * Wiring [`Options::cors_allowed_origins`] from `PENPOT_ALLOWED_ORIGINS`.
//!   `config` still lists `allowed-origins` in `PENDING_KEYS`, so the sample
//!   binary runs with CORS off.
//! * Live SSE streams (M7). `CommandResult::sse` renders the same frame format
//!   (`event:` / `data:` with verbose transit) for a fixed list of events.
//! * `Accept: application/json` responses. The skeleton always answers transit.

pub mod auth;
pub mod commands;
mod context;
pub mod params;
mod registry;
pub mod response;
mod router;

pub use auth::{
    AccessTokenRecord, AccessTokenStore, AuthOptions, SessionRecord, SessionStore, TokenResolver,
};
pub use context::{AuthType, CommandContext, Identity, Module};
pub use params::{ParamKind, ParamSchema, ParamSpec, ValidationError};
pub use registry::{AuthPolicy, Command, Handler, HandlerFuture, Registry};
pub use response::{CommandBody, CommandResult, SseEvent};
pub use router::{
    build_router, context_snapshot, AppState, NoSessions, NoTransactions, Options, SessionResolver,
    SharedKeys, TransactionHook,
};

/// Re-exported so command implementations can raise Penpot errors.
pub use errors;
/// Re-exported so command implementations can build transit values.
pub use transit;
