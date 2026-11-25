//! axum router and the RPC dispatch pipeline.

use std::collections::BTreeMap;
use std::net::{IpAddr, SocketAddr};
use std::sync::Arc;
use std::time::Instant;

use axum::extract::connect_info::ConnectInfo;
use axum::extract::{Path, Request, State};
use axum::http::{header, HeaderMap, Method, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{any, get};
use axum::Router;
use errors::Cause;
use tracing::Instrument as _;
use transit::Value;
use uuid::Uuid;

use crate::context::{CommandContext, Identity, Module};
use crate::params::{merge_params, parse_query, ValidationError};
use crate::registry::{authorize, HandlerFuture, Registry};
use crate::response::{encode, CommandResult};

/// `x-shared-key: <key-id> <key>` entries (`::setup/shared-keys`).
pub type SharedKeys = BTreeMap<String, String>;

/// Resolves the caller identity from request headers.
///
/// The lookup is async because the live implementation reads
/// `http_session_v2` / `access_token` through sqlx.
#[async_trait::async_trait]
pub trait SessionResolver: Send + Sync {
    /// # Errors
    ///
    /// A controlled error when the presented credential is malformed.
    async fn resolve(
        &self,
        headers: &HeaderMap,
        session_id: Option<Uuid>,
    ) -> Result<Identity, Cause>;
}

/// The default resolver: no sessions, no tokens.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoSessions;

#[async_trait::async_trait]
impl SessionResolver for NoSessions {
    async fn resolve(
        &self,
        _headers: &HeaderMap,
        _session_id: Option<Uuid>,
    ) -> Result<Identity, Cause> {
        Ok(Identity::default())
    }
}

/// Wraps commands marked `::db/transaction`.
pub trait TransactionHook: Send + Sync {
    fn wrap(&self, ctx: CommandContext, next: HandlerFuture) -> HandlerFuture;
}

/// The M3 placeholder: runs the command without a database transaction.
#[derive(Debug, Clone, Copy, Default)]
pub struct NoTransactions;

impl TransactionHook for NoTransactions {
    fn wrap(&self, _ctx: CommandContext, next: HandlerFuture) -> HandlerFuture {
        next
    }
}

/// Behaviour switches that come from config flags.
#[derive(Debug, Clone)]
pub struct Options {
    /// `client-header-check-middleware`: require `x-client`.
    pub client_header_check: bool,
    /// `transit-readable-response`: always use verbose transit.
    pub transit_readable: bool,
    /// Request body limit; over it the router answers
    /// `:validation/:request-body-too-large` (413).
    pub max_body_bytes: usize,
    /// `allowed-origins`. An empty list disables CORS, matching `mw/cors`'
    /// fail-closed branch when the flag is on but no origin is configured.
    pub cors_allowed_origins: Vec<String>,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            client_header_check: false,
            transit_readable: false,
            max_body_bytes: 16 * 1024 * 1024,
            cors_allowed_origins: Vec::new(),
        }
    }
}

/// Shared state of the router.
#[derive(Clone)]
pub struct AppState {
    pub registry: Arc<Registry>,
    pub resolver: Arc<dyn SessionResolver>,
    pub transactions: Arc<dyn TransactionHook>,
    pub shared_keys: SharedKeys,
    pub public_uri: String,
    pub options: Options,
}

impl AppState {
    #[must_use]
    pub fn new(registry: Registry) -> Self {
        Self {
            registry: Arc::new(registry),
            resolver: Arc::new(NoSessions),
            transactions: Arc::new(NoTransactions),
            shared_keys: SharedKeys::new(),
            public_uri: "http://localhost:3449".to_owned(),
            options: Options::default(),
        }
    }

    #[must_use]
    pub fn with_resolver(mut self, resolver: Arc<dyn SessionResolver>) -> Self {
        self.resolver = resolver;
        self
    }

    #[must_use]
    pub fn with_transactions(mut self, transactions: Arc<dyn TransactionHook>) -> Self {
        self.transactions = transactions;
        self
    }

    #[must_use]
    pub fn with_shared_key(mut self, id: impl Into<String>, key: impl Into<String>) -> Self {
        self.shared_keys.insert(id.into(), key.into());
        self
    }

    #[must_use]
    pub fn with_public_uri(mut self, uri: impl Into<String>) -> Self {
        self.public_uri = uri.into();
        self
    }

    #[must_use]
    pub fn with_options(mut self, options: Options) -> Self {
        self.options = options;
        self
    }
}

/// Build the three RPC routes plus the doc redirects.
pub fn build_router(state: AppState) -> Router {
    Router::new()
        .route("/api/main/methods/{name}", any(dispatch_main))
        .route("/api/rpc/command/{name}", any(dispatch_main))
        .route("/api/management/methods/{name}", any(dispatch_management))
        .route("/api/_doc", get(redirect_doc))
        .route("/api/doc", get(redirect_doc))
        .route("/api/openapi", get(redirect_openapi))
        .route("/api/openapi.join", get(redirect_openapi_json))
        .with_state(state)
}

async fn dispatch_main(
    State(state): State<AppState>,
    Path(name): Path<String>,
    request: Request,
) -> Response {
    dispatch(state, Module::Main, name, request).await
}

async fn dispatch_management(
    State(state): State<AppState>,
    Path(name): Path<String>,
    request: Request,
) -> Response {
    dispatch(state, Module::Management, name, request).await
}

async fn dispatch(state: AppState, module: Module, name: String, request: Request) -> Response {
    let origin = request
        .headers()
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let allowed_origins = state.options.cors_allowed_origins.clone();
    let cors = module == Module::Main && !allowed_origins.is_empty();

    let response = if cors && request.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        dispatch_inner(state, module, name, request).await
    };

    if cors {
        apply_cors(response, origin, &allowed_origins)
    } else {
        response
    }
}

async fn dispatch_inner(
    state: AppState,
    module: Module,
    name: String,
    request: Request,
) -> Response {
    let (parts, body) = request.into_parts();
    let method = parts.method.clone();
    let is_read = method == Method::GET || method == Method::HEAD;

    // Route middleware: CSRF header check (main) and shared key (management).
    if module == Module::Main
        && state.options.client_header_check
        && parts.headers.get("x-client").is_none()
    {
        return StatusCode::FORBIDDEN.into_response();
    }
    let auth_key_id = if module == Module::Management {
        match check_shared_key(&parts.headers, &state.shared_keys) {
            Some(id) => Some(id),
            None => return StatusCode::FORBIDDEN.into_response(),
        }
    } else {
        None
    };

    // `rpc.clj` raises this before it resolves the handler, so GET of an
    // unknown non-`get-` name is a 405, not a 404.
    if is_read && !name.starts_with("get-") {
        return error_response(method_not_allowed());
    }

    let Some(command) = state.registry.get(&name) else {
        return error_response(not_found());
    };

    // Stage: authentication.
    let session_id = header_uuid(&parts.headers, "x-session-id");
    let identity = match state.resolver.resolve(&parts.headers, session_id).await {
        Ok(mut identity) => {
            identity.auth_key_id = auth_key_id;
            identity
        }
        Err(cause) => return error_response(cause),
    };
    if let Err(cause) = authorize(&command.auth, &identity) {
        return error_response(cause);
    }

    // Stage: params-validation.
    let query = parse_query(parts.uri.query().unwrap_or_default());
    let raw = if is_read {
        query.clone()
    } else {
        let content_type = parts
            .headers
            .get(header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok());
        match read_params(body, content_type, state.options.max_body_bytes).await {
            Ok(body) => merge_params(&query, &body),
            Err(BodyError::TooLarge) => return error_response(request_body_too_large()),
            Err(BodyError::Invalid(error)) => return error_response(validation(error)),
        }
    };
    let params = match &command.params {
        Some(schema) => match schema.validate(&raw) {
            Ok(params) => params,
            Err(error) => return error_response(validation(error)),
        },
        None => raw,
    };

    // Stages nitrate-sso / audit / rlimit have no M3 behaviour; metrics is the
    // span below; climit / retry / cond are no-ops until their modules exist.

    let request_id = Uuid::new_v4();
    let verbose = state.options.transit_readable || query_has_transit_verbose(parts.uri.query());
    let ctx = CommandContext {
        name: name.clone(),
        module,
        method: method.clone(),
        path: parts.uri.path().to_owned(),
        request_id,
        session_id,
        client_ip: client_ip(&parts.headers, peer_ip(&parts)),
        params,
        identity,
        headers: parts.headers,
    };

    // Stage: db-transaction (placeholder).
    let future = (command.handler)(ctx.clone());
    let future = if command.transaction {
        state.transactions.wrap(ctx, future)
    } else {
        future
    };

    // Stage: metrics (a tracing span plus a completion event).
    let span = tracing::info_span!(
        "rpc",
        command = %name,
        module = module.as_str(),
        request_id = %request_id
    );
    let started = Instant::now();
    let result = future.instrument(span).await;
    tracing::debug!(
        command = %name,
        elapsed_ms = u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        ok = result.is_ok(),
        "rpc finished"
    );

    let response = match result {
        Ok(result) => encode(&result, verbose),
        Err(cause) => error_response(cause),
    };
    if method == Method::HEAD {
        let (parts, _) = response.into_parts();
        return Response::from_parts(parts, axum::body::Body::empty());
    }
    response
}

/// `mw/wrap-cors`: every response varies by `Origin`; the permissive headers
/// appear only for an origin on the allowlist.
fn apply_cors(mut response: Response, origin: Option<String>, allowed: &[String]) -> Response {
    let headers = response.headers_mut();
    headers.insert(header::VARY, axum::http::HeaderValue::from_static("Origin"));

    let Some(origin) = origin.filter(|origin| allowed.iter().any(|item| item == origin)) else {
        return response;
    };
    let Ok(origin) = axum::http::HeaderValue::from_str(&origin) else {
        return response;
    };
    headers.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, origin);
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_CREDENTIALS,
        axum::http::HeaderValue::from_static("true"),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_METHODS,
        axum::http::HeaderValue::from_static("GET,POST,DELETE,OPTIONS,PUT,HEAD,PATCH"),
    );
    headers.insert(
        header::ACCESS_CONTROL_EXPOSE_HEADERS,
        axum::http::HeaderValue::from_static(
            "content-type, retry-after, x-rate-limit-remaining, x-rate-limit-reset",
        ),
    );
    headers.insert(
        header::ACCESS_CONTROL_ALLOW_HEADERS,
        axum::http::HeaderValue::from_static("x-frontend-version, x-client, content-type, accept"),
    );
    response
}

enum BodyError {
    TooLarge,
    Invalid(ValidationError),
}

async fn read_params(
    body: axum::body::Body,
    content_type: Option<&str>,
    limit: usize,
) -> Result<Value, BodyError> {
    let Ok(bytes) = axum::body::to_bytes(body, limit).await else {
        return Err(BodyError::TooLarge);
    };
    if bytes.is_empty() {
        return Ok(Value::map([]));
    }
    let is_transit = content_type.is_some_and(|value| {
        value
            .trim()
            .to_ascii_lowercase()
            .starts_with("application/transit+json")
    });
    if !is_transit {
        return Err(BodyError::Invalid(ValidationError::new(
            "request body must be application/transit+json",
        )));
    }
    let Ok(text) = std::str::from_utf8(&bytes) else {
        return Err(BodyError::Invalid(ValidationError::new(
            "request body is not UTF-8",
        )));
    };
    match transit::decode(text) {
        Ok(value) if value.is_map() => Ok(value),
        Ok(_) => Err(BodyError::Invalid(ValidationError::new(
            "request body must be a transit map",
        ))),
        Err(error) => Err(BodyError::Invalid(ValidationError::new(format!(
            "malformed transit request body: {error}"
        )))),
    }
}

fn check_shared_key(headers: &HeaderMap, keys: &SharedKeys) -> Option<String> {
    let value = headers.get("x-shared-key")?.to_str().ok()?.trim();
    let (id, key) = value.split_once(char::is_whitespace)?;
    let id = id.to_ascii_lowercase();
    let expected = keys.get(&id)?;
    constant_time_eq(key.trim().as_bytes(), expected.as_bytes()).then_some(id)
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.iter()
        .zip(right)
        .fold(0u8, |acc, (a, b)| acc | (a ^ b))
        == 0
}

fn header_uuid(headers: &HeaderMap, name: &str) -> Option<Uuid> {
    headers
        .get(name)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| Uuid::parse_str(value.trim()).ok())
}

/// `inet/parse-request`: `x-real-ip`, then the first `x-forwarded-for` hop,
/// then the socket peer. Values that are not IP literals are skipped.
fn client_ip(headers: &HeaderMap, peer: Option<IpAddr>) -> Option<String> {
    header_str(headers, "x-real-ip")
        .and_then(normalize_ip)
        .or_else(|| {
            header_str(headers, "x-forwarded-for")
                .and_then(|value| value.split(',').next())
                .and_then(normalize_ip)
        })
        .or_else(|| peer.map(|ip| ip.to_string()))
}

fn peer_ip(parts: &axum::http::request::Parts) -> Option<IpAddr> {
    parts
        .extensions
        .get::<ConnectInfo<SocketAddr>>()
        .map(|info| info.0.ip())
}

fn header_str<'a>(headers: &'a HeaderMap, name: &str) -> Option<&'a str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn normalize_ip(text: &str) -> Option<String> {
    let text = text.trim();
    let text = text
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(text);
    text.parse::<IpAddr>().ok().map(|ip| ip.to_string())
}

fn query_has_transit_verbose(query: Option<&str>) -> bool {
    query.is_some_and(|query| {
        url::form_urlencoded::parse(query.as_bytes()).any(|(key, _)| key == "transit_verbose")
    })
}

fn error_response(cause: Cause) -> Response {
    errors::handle(&cause).into_response()
}

fn not_found() -> Cause {
    Cause::error(Value::map([(Value::kw("type"), Value::kw("not-found"))]))
}

fn method_not_allowed() -> Cause {
    Cause::error(Value::map([
        (Value::kw("type"), Value::kw("restriction")),
        (Value::kw("code"), Value::kw("method-not-allowed")),
        (
            Value::kw("hint"),
            Value::str("method not allowed for this request"),
        ),
    ]))
}

fn validation(error: ValidationError) -> Cause {
    tracing::debug!(%error, "request validation failed");
    Cause::error(Value::map([
        (Value::kw("type"), Value::kw("validation")),
        (Value::kw("code"), Value::kw("params-validation")),
    ]))
}

fn request_body_too_large() -> Cause {
    Cause::error(Value::map([
        (Value::kw("type"), Value::kw("validation")),
        (Value::kw("code"), Value::kw("request-body-too-large")),
    ]))
}

async fn redirect_doc(State(state): State<AppState>) -> Response {
    redirect(&state, "/api/main/doc")
}

async fn redirect_openapi(State(state): State<AppState>) -> Response {
    redirect(&state, "/api/main/doc/openapi")
}

async fn redirect_openapi_json(State(state): State<AppState>) -> Response {
    redirect(&state, "/api/main/doc/openapi.json")
}

fn redirect(state: &AppState, path: &str) -> Response {
    let base = state.public_uri.trim_end_matches('/');
    let location = format!("{base}{path}");
    let mut response = StatusCode::PERMANENT_REDIRECT.into_response();
    if let Ok(value) = axum::http::HeaderValue::from_str(&location) {
        response.headers_mut().insert(header::LOCATION, value);
    }
    response
}

/// Echo the useful request context. Used by the local binary and the tests.
#[must_use]
pub fn context_snapshot(ctx: &CommandContext) -> CommandResult {
    let mut body = transit::Map::new();
    body.insert(Value::kw("name"), Value::str(ctx.name.clone()));
    body.insert(Value::kw("module"), Value::kw(ctx.module.as_str()));
    body.insert(Value::kw("method"), Value::str(ctx.method.as_str()));
    body.insert(Value::kw("path"), Value::str(ctx.path.clone()));
    body.insert(
        Value::kw("request-id"),
        Value::str(ctx.request_id.to_string()),
    );
    if let Some(session_id) = ctx.session_id {
        body.insert(Value::kw("session-id"), Value::str(session_id.to_string()));
    }
    if let Some(ip) = &ctx.client_ip {
        body.insert(Value::kw("client-ip"), Value::str(ip.clone()));
    }
    if let Some(profile_id) = ctx.profile_id() {
        body.insert(Value::kw("profile-id"), Value::str(profile_id.to_string()));
    }
    body.insert(Value::kw("params"), ctx.params.clone());
    CommandResult::ok(Value::Map(body))
}
