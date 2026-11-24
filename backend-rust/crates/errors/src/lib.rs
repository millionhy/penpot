//! Penpot HTTP error mapping.
//!
//! This crate mirrors `backend/src/app/http/errors.clj`. A caught cause is
//! mapped to a status, optional headers, and a body that is a Clojure map. The
//! body keeps the original `ex-data` keys, so unknown data survives; only the
//! keys that `errors.clj` removes are removed here.
//!
//! Two shapes are deliberately kept apart:
//!
//! * [`ExError`] is the Rust analogue of `ex-info`: it always has `ex-data`
//!   and is dispatched on `:type`.
//! * [`Cause`] is the analogue of a `Throwable`: it also covers PostgreSQL and
//!   IO failures, which have no `ex-data`, and wrapped
//!   `CompletionException`/`ExecutionException` causes.
//!
//! [`HttpError`] implements [`IntoResponse`] and encodes a map body with
//! verbose transit (`t/encode-str body {:type :json-verbose}` in
//! `app.http/router-handler`), labelled `application/transit+json`.

use axum::http::{header, HeaderMap, HeaderName, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use transit::{Map, Value};

/// `:type` of an `ex-data` map.
pub const KEY_TYPE: &str = "type";
/// `:code` of an `ex-data` map.
pub const KEY_CODE: &str = "code";
/// `:hint` of an `ex-data` map.
pub const KEY_HINT: &str = "hint";
/// `:ttl` of a rate-limit error.
pub const KEY_TTL: &str = "ttl";
/// Human readable explanation added by the error handler.
pub const KEY_EXPLAIN: &str = "explain";
/// `:state`, stripped from server-error bodies.
pub const KEY_STATE: &str = "state";
/// `:path`, stripped from server-error bodies.
pub const KEY_PATH: &str = "path";
/// `:context`, stripped from server-error bodies.
pub const KEY_CONTEXT: &str = "context";
/// `:reason` of an integrant build failure.
pub const KEY_REASON: &str = "reason";

/// `::sm/explain` (`app.common.schema`).
pub const SCHEMA_EXPLAIN_KEY: &str = "app.common.schema/explain";
/// `::s/problems` (`clojure.spec.alpha`).
pub const SPEC_PROBLEMS_KEY: &str = "clojure.spec.alpha/problems";
/// `::s/value` (`clojure.spec.alpha`).
pub const SPEC_VALUE_KEY: &str = "clojure.spec.alpha/value";
/// `::s/spec` (`clojure.spec.alpha`).
pub const SPEC_SPEC_KEY: &str = "clojure.spec.alpha/spec";
/// `::http/headers` (`app.http`).
pub const HTTP_HEADERS_KEY: &str = "app.http/headers";

/// Fields removed by `strip-internal-fields`.
pub const INTERNAL_FIELDS: &[&str] = &[KEY_STATE, KEY_PATH, KEY_CONTEXT];

/// SQLSTATE to client hint table from `pgsql-state->message`.
pub const POSTGRES_HINTS: &[(&str, &str)] = &[
    ("23505", "A conflicting entry already exists"),
    ("23503", "The referenced item does not exist"),
    ("23502", "A required field is missing"),
    ("23514", "The value violates a data integrity constraint"),
    ("57014", "The operation took too long and was cancelled"),
    (
        "25P03",
        "The transaction was idle too long and was cancelled",
    ),
];

/// Hint used for SQLSTATE codes outside [`POSTGRES_HINTS`].
pub const POSTGRES_DEFAULT_HINT: &str = "A database error occurred";

/// `:type` values understood by `handle-error`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorType {
    Authentication,
    Authorization,
    Restriction,
    RateLimit,
    ConcurrencyLimit,
    Validation,
    Assertion,
    NotFound,
    NitrateUnavailable,
    NitrateNotConfigured,
    Internal,
    /// Not an input type: the `:type` written into server-error bodies.
    ServerError,
}

impl ErrorType {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Authentication => "authentication",
            Self::Authorization => "authorization",
            Self::Restriction => "restriction",
            Self::RateLimit => "rate-limit",
            Self::ConcurrencyLimit => "concurrency-limit",
            Self::Validation => "validation",
            Self::Assertion => "assertion",
            Self::NotFound => "not-found",
            Self::NitrateUnavailable => "nitrate-unavailable",
            Self::NitrateNotConfigured => "nitrate-not-configured",
            Self::Internal => "internal",
            Self::ServerError => "server-error",
        }
    }

    #[must_use]
    pub fn from_kw(name: &str) -> Option<Self> {
        Some(match name {
            "authentication" => Self::Authentication,
            "authorization" => Self::Authorization,
            "restriction" => Self::Restriction,
            "rate-limit" => Self::RateLimit,
            "concurrency-limit" => Self::ConcurrencyLimit,
            "validation" => Self::Validation,
            "assertion" => Self::Assertion,
            "not-found" => Self::NotFound,
            "nitrate-unavailable" => Self::NitrateUnavailable,
            "nitrate-not-configured" => Self::NitrateNotConfigured,
            "internal" => Self::Internal,
            "server-error" => Self::ServerError,
            _ => return None,
        })
    }
}

/// `:code` values this handler reads or writes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorCode {
    MethodNotAllowed,
    SpecValidation,
    ParamsValidation,
    SchemaValidation,
    DataValidation,
    VernConflict,
    RequestBodyTooLarge,
    InvalidImage,
    Assertion,
    Unhandled,
    Unexpected,
    StatementTimeout,
    IdleInTransactionTimeout,
    DatabaseError,
    IoException,
}

impl ErrorCode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::MethodNotAllowed => "method-not-allowed",
            Self::SpecValidation => "spec-validation",
            Self::ParamsValidation => "params-validation",
            Self::SchemaValidation => "schema-validation",
            Self::DataValidation => "data-validation",
            Self::VernConflict => "vern-conflict",
            Self::RequestBodyTooLarge => "request-body-too-large",
            Self::InvalidImage => "invalid-image",
            Self::Assertion => "assertion",
            Self::Unhandled => "unhandled",
            Self::Unexpected => "unexpected",
            Self::StatementTimeout => "statement-timeout",
            Self::IdleInTransactionTimeout => "idle-in-transaction-timeout",
            Self::DatabaseError => "database-error",
            Self::IoException => "io-exception",
        }
    }

    #[must_use]
    pub fn from_kw(name: &str) -> Option<Self> {
        Some(match name {
            "method-not-allowed" => Self::MethodNotAllowed,
            "spec-validation" => Self::SpecValidation,
            "params-validation" => Self::ParamsValidation,
            "schema-validation" => Self::SchemaValidation,
            "data-validation" => Self::DataValidation,
            "vern-conflict" => Self::VernConflict,
            "request-body-too-large" => Self::RequestBodyTooLarge,
            "invalid-image" => Self::InvalidImage,
            "assertion" => Self::Assertion,
            "unhandled" => Self::Unhandled,
            "unexpected" => Self::Unexpected,
            "statement-timeout" => Self::StatementTimeout,
            "idle-in-transaction-timeout" => Self::IdleInTransactionTimeout,
            "database-error" => Self::DatabaseError,
            "io-exception" => Self::IoException,
            _ => return None,
        })
    }
}

/// A controlled Penpot error, the Rust analogue of `clojure.lang.ExceptionInfo`.
#[derive(Debug, Clone)]
pub struct ExError {
    /// The `ex-data` map.
    pub data: Value,
    /// `(ex-data err) :handling`, present on the next.jdbc rollback pair.
    pub handling: Option<Box<Cause>>,
    /// `(ex-data err) :rollback`, present on the next.jdbc rollback pair.
    pub rollback: Option<Box<Cause>>,
}

impl ExError {
    #[must_use]
    pub fn new(data: Value) -> Self {
        Self {
            data,
            handling: None,
            rollback: None,
        }
    }

    /// Attach the `:handling`/`:rollback` pair that next.jdbc adds when a
    /// transaction fails and the connection closes.
    #[must_use]
    pub fn with_transaction(mut self, handling: Cause, rollback: Cause) -> Self {
        self.handling = Some(Box::new(handling));
        self.rollback = Some(Box::new(rollback));
        self
    }
}

/// A caught cause: a controlled error or an exception without `ex-data`.
#[derive(Debug, Clone)]
pub enum Cause {
    Error(ExError),
    Postgres {
        sqlstate: String,
    },
    Io {
        message: Option<String>,
    },
    /// `CompletionException` / `ExecutionException`; dispatch the cause.
    Wrapped(Box<Cause>),
    /// An exception with no `ex-data` and no dedicated branch.
    Other {
        message: Option<String>,
    },
}

impl Cause {
    #[must_use]
    pub fn error(data: Value) -> Self {
        Self::Error(ExError::new(data))
    }

    #[must_use]
    pub fn postgres(sqlstate: impl Into<String>) -> Self {
        Self::Postgres {
            sqlstate: sqlstate.into(),
        }
    }

    #[must_use]
    pub fn io(message: impl Into<String>) -> Self {
        Self::Io {
            message: Some(message.into()),
        }
    }

    #[must_use]
    pub fn wrapped(inner: Cause) -> Self {
        Self::Wrapped(Box::new(inner))
    }

    #[must_use]
    pub fn other(message: impl Into<String>) -> Self {
        Self::Other {
            message: Some(message.into()),
        }
    }

    #[must_use]
    pub fn data(&self) -> Option<&Value> {
        match self {
            Self::Error(error) => Some(&error.data),
            _ => None,
        }
    }
}

/// The mapped HTTP response: status, extra headers, optional transit body.
#[derive(Debug, Clone)]
pub struct HttpError {
    pub status: StatusCode,
    pub headers: HeaderMap,
    /// Missing for `:concurrency-limit`, which has no body in `errors.clj`.
    pub body: Option<Value>,
}

impl HttpError {
    #[must_use]
    pub fn new(status: StatusCode) -> Self {
        Self {
            status,
            headers: HeaderMap::new(),
            body: None,
        }
    }

    #[must_use]
    pub fn with_body(mut self, body: Value) -> Self {
        self.body = Some(body);
        self
    }

    #[must_use]
    pub fn with_headers(mut self, headers: HeaderMap) -> Self {
        self.headers = headers;
        self
    }
}

impl IntoResponse for HttpError {
    fn into_response(self) -> Response {
        let Self {
            status,
            headers,
            body,
        } = self;

        let has_body = body.is_some();
        let mut response = match body {
            Some(body) => transit::encode_verbose(&body).into_response(),
            None => StatusCode::OK.into_response(),
        };
        *response.status_mut() = status;
        for (name, value) in &headers {
            response.headers_mut().insert(name.clone(), value.clone());
        }
        if has_body {
            response.headers_mut().insert(
                header::CONTENT_TYPE,
                HeaderValue::from_static("application/transit+json"),
            );
        }
        response
    }
}

/// `errors/handle`: controlled errors dispatch on `:type`, everything else
/// dispatches as an exception.
#[must_use]
pub fn handle(cause: &Cause) -> HttpError {
    match cause {
        Cause::Error(error) => handle_error(error),
        other => handle_exception(other),
    }
}

/// `handle-error`, for a cause known to be a controlled error.
#[must_use]
pub fn handle_error(error: &ExError) -> HttpError {
    let data = data_map(&error.data);
    match data.get_kw(KEY_TYPE).and_then(Value::as_keyword) {
        Some("authentication") => {
            HttpError::new(StatusCode::UNAUTHORIZED).with_body(error.data.clone())
        }
        Some("authorization") => {
            HttpError::new(StatusCode::FORBIDDEN).with_body(error.data.clone())
        }
        Some("restriction") => restriction(&data),
        Some("rate-limit") => rate_limit(&data),
        Some("concurrency-limit") => concurrency_limit(&data),
        Some("validation") => validation(&data),
        Some("assertion") => assertion(&data),
        Some("not-found") => HttpError::new(StatusCode::NOT_FOUND).with_body(error.data.clone()),
        Some("nitrate-unavailable") => HttpError::new(StatusCode::SERVICE_UNAVAILABLE)
            .with_body(type_only_body(ErrorType::NitrateUnavailable)),
        Some("nitrate-not-configured") => HttpError::new(StatusCode::SERVICE_UNAVAILABLE)
            .with_body(type_only_body(ErrorType::NitrateNotConfigured)),
        Some("internal") => internal(&data),
        _ => {
            // `handle-error :default`: prefer the `:handling` cause of a
            // failed transaction, otherwise treat the error as an exception.
            if let (Some(handling), Some(_rollback)) = (&error.handling, &error.rollback) {
                return handle(handling);
            }
            handle_exception(&Cause::Error(error.clone()))
        }
    }
}

/// `handle-exception`, for a cause without a recognised `:type`.
#[must_use]
pub fn handle_exception(cause: &Cause) -> HttpError {
    match cause {
        Cause::Postgres { sqlstate } => postgres_error(sqlstate),
        Cause::Io { .. } => HttpError::new(StatusCode::INTERNAL_SERVER_ERROR)
            .with_body(code_only_body(ErrorCode::IoException)),
        Cause::Wrapped(inner) => handle(inner),
        Cause::Other { .. } => unexpected(),
        Cause::Error(error) => {
            if error.data.is_nil() {
                unexpected()
            } else {
                unhandled(&data_map(&error.data))
            }
        }
    }
}

/// `handle-exception org.postgresql.util.PSQLException`.
#[must_use]
pub fn postgres_error(sqlstate: &str) -> HttpError {
    let (status, code) = match sqlstate {
        "57014" => (StatusCode::GATEWAY_TIMEOUT, ErrorCode::StatementTimeout),
        "25P03" => (
            StatusCode::GATEWAY_TIMEOUT,
            ErrorCode::IdleInTransactionTimeout,
        ),
        _ => (StatusCode::INTERNAL_SERVER_ERROR, ErrorCode::DatabaseError),
    };
    let body = Value::map([
        (
            Value::kw(KEY_TYPE),
            Value::kw(ErrorType::ServerError.as_str()),
        ),
        (Value::kw(KEY_CODE), Value::kw(code.as_str())),
        (Value::kw(KEY_HINT), Value::str(postgres_hint(sqlstate))),
    ]);
    HttpError::new(status).with_body(body)
}

/// Client-facing hint for a PostgreSQL SQLSTATE code.
#[must_use]
pub fn postgres_hint(sqlstate: &str) -> &'static str {
    POSTGRES_HINTS
        .iter()
        .find(|(state, _)| *state == sqlstate)
        .map_or(POSTGRES_DEFAULT_HINT, |(_, hint)| *hint)
}

fn restriction(data: &Map) -> HttpError {
    let explain = explain_of(data);
    let mut body = data.clone();
    body.remove(&Value::kw(SCHEMA_EXPLAIN_KEY));
    if let Some(explain) = explain {
        body.insert(Value::kw(KEY_EXPLAIN), Value::str(explain));
    }
    let status = if has_code(data, ErrorCode::MethodNotAllowed) {
        StatusCode::METHOD_NOT_ALLOWED
    } else {
        StatusCode::BAD_REQUEST
    };
    HttpError::new(status).with_body(Value::Map(body))
}

fn rate_limit(data: &Map) -> HttpError {
    let mut headers = header_map(data.get_kw(HTTP_HEADERS_KEY));
    if let Some(ttl) = data.get_kw(KEY_TTL) {
        if !ttl.is_nil() {
            if let Ok(value) = HeaderValue::from_str(&display_value(ttl)) {
                headers.insert(header::RETRY_AFTER, value);
            }
        }
    }

    // `errors.clj` builds this body key by key, so absent values stay as nil
    // instead of being dropped.
    let or_nil = |key: &str| data.get_kw(key).cloned().unwrap_or(Value::Nil);
    let body = Value::map([
        (
            Value::kw(KEY_TYPE),
            Value::kw(ErrorType::RateLimit.as_str()),
        ),
        (Value::kw(KEY_CODE), or_nil(KEY_CODE)),
        (Value::kw(KEY_HINT), or_nil(KEY_HINT)),
        (Value::kw(KEY_TTL), or_nil(KEY_TTL)),
    ]);
    HttpError::new(StatusCode::TOO_MANY_REQUESTS)
        .with_headers(headers)
        .with_body(body)
}

fn concurrency_limit(data: &Map) -> HttpError {
    HttpError::new(StatusCode::TOO_MANY_REQUESTS)
        .with_headers(header_map(data.get_kw(HTTP_HEADERS_KEY)))
}

fn validation(data: &Map) -> HttpError {
    if [
        ErrorCode::SpecValidation,
        ErrorCode::ParamsValidation,
        ErrorCode::SchemaValidation,
        ErrorCode::DataValidation,
    ]
    .iter()
    .any(|code| has_code(data, *code))
    {
        let explain = explain_of(data);
        let mut body = data.clone();
        for key in [
            SPEC_PROBLEMS_KEY,
            SPEC_VALUE_KEY,
            SPEC_SPEC_KEY,
            SCHEMA_EXPLAIN_KEY,
        ] {
            body.remove(&Value::kw(key));
        }
        if let Some(explain) = explain {
            body.insert(Value::kw(KEY_EXPLAIN), Value::str(explain));
        }
        return HttpError::new(StatusCode::BAD_REQUEST).with_body(Value::Map(body));
    }

    let status = match code_of(data) {
        Some(ErrorCode::VernConflict) => StatusCode::CONFLICT,
        Some(ErrorCode::RequestBodyTooLarge) => StatusCode::PAYLOAD_TOO_LARGE,
        _ => StatusCode::BAD_REQUEST,
    };
    HttpError::new(status).with_body(Value::Map(data.clone()))
}

fn assertion(data: &Map) -> HttpError {
    let explain = explain_of(data);
    let code = code_of(data);
    let mut body = data.clone();

    match code {
        Some(ErrorCode::DataValidation) => {
            body.remove(&Value::kw(SCHEMA_EXPLAIN_KEY));
        }
        Some(ErrorCode::SpecValidation) => {
            // `errors.clj` removes the spec internals on this branch but not
            // `::sm/explain`; a spec error normally carries only the former.
            for key in [SPEC_PROBLEMS_KEY, SPEC_VALUE_KEY, SPEC_SPEC_KEY] {
                body.remove(&Value::kw(key));
            }
        }
        _ => {
            strip_internal_fields(&mut body);
        }
    }

    if let Some(explain) = explain {
        body.insert(Value::kw(KEY_EXPLAIN), Value::str(explain));
    }
    body.insert(
        Value::kw(KEY_TYPE),
        Value::kw(ErrorType::ServerError.as_str()),
    );
    body.insert(
        Value::kw(KEY_CODE),
        Value::kw(ErrorCode::Assertion.as_str()),
    );
    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR).with_body(Value::Map(body))
}

fn internal(data: &Map) -> HttpError {
    let mut body = data.clone();
    strip_internal_fields(&mut body);
    body.insert(
        Value::kw(KEY_TYPE),
        Value::kw(ErrorType::ServerError.as_str()),
    );
    set_code_if_missing(&mut body, ErrorCode::Unhandled);
    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR).with_body(Value::Map(body))
}

fn unhandled(data: &Map) -> HttpError {
    let mut body = data.clone();
    strip_internal_fields(&mut body);
    body.insert(
        Value::kw(KEY_TYPE),
        Value::kw(ErrorType::ServerError.as_str()),
    );
    set_code_if_missing(&mut body, ErrorCode::Unhandled);
    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR).with_body(Value::Map(body))
}

fn unexpected() -> HttpError {
    HttpError::new(StatusCode::INTERNAL_SERVER_ERROR).with_body(Value::map([
        (
            Value::kw(KEY_TYPE),
            Value::kw(ErrorType::ServerError.as_str()),
        ),
        (
            Value::kw(KEY_CODE),
            Value::kw(ErrorCode::Unexpected.as_str()),
        ),
    ]))
}

fn type_only_body(kind: ErrorType) -> Value {
    Value::map([(Value::kw(KEY_TYPE), Value::kw(kind.as_str()))])
}

fn code_only_body(code: ErrorCode) -> Value {
    Value::map([
        (
            Value::kw(KEY_TYPE),
            Value::kw(ErrorType::ServerError.as_str()),
        ),
        (Value::kw(KEY_CODE), Value::kw(code.as_str())),
    ])
}

fn data_map(data: &Value) -> Map {
    data.as_map().cloned().unwrap_or_default()
}

fn code_of(data: &Map) -> Option<ErrorCode> {
    data.get_kw(KEY_CODE)
        .and_then(Value::as_keyword)
        .and_then(ErrorCode::from_kw)
}

fn has_code(data: &Map, expected: ErrorCode) -> bool {
    code_of(data) == Some(expected)
}

fn strip_internal_fields(body: &mut Map) {
    for key in INTERNAL_FIELDS {
        body.remove(&Value::kw(*key));
    }
}

fn set_code_if_missing(body: &mut Map, code: ErrorCode) {
    let missing = body.get_kw(KEY_CODE).is_none_or(Value::is_nil);
    if missing {
        body.insert(Value::kw(KEY_CODE), Value::kw(code.as_str()));
    }
}

fn header_map(value: Option<&Value>) -> HeaderMap {
    let mut headers = HeaderMap::new();
    let Some(map) = value.and_then(Value::as_map) else {
        return headers;
    };
    for (key, value) in map.iter() {
        let Some(name) = key.as_str().or_else(|| key.as_keyword()) else {
            continue;
        };
        let Ok(name) = HeaderName::from_bytes(name.as_bytes()) else {
            continue;
        };
        let text = match value {
            Value::Str(text) => text.clone(),
            Value::Integer(number) => number.to_string(),
            Value::Bool(flag) => flag.to_string(),
            _ => continue,
        };
        let Ok(value) = HeaderValue::from_str(&text) else {
            continue;
        };
        headers.insert(name, value);
    }
    headers
}

// ---------------------------------------------------------------------------
// explain rendering
// ---------------------------------------------------------------------------

/// `app.common.exceptions/explain`, reduced to the part the error handler
/// needs: pull `::sm/explain` (or an integrant `:explain` wrapper) out of the
/// data and render a readable string.
///
/// The Clojure implementation pretty-prints malli schema forms; the Rust port
/// prints the same data with a compact reader-like layout. Only the presence
/// and the string type of `:explain` are part of the wire contract.
fn explain_of(data: &Map) -> Option<String> {
    let reason = data.get_kw(KEY_REASON).and_then(Value::as_keyword);
    if reason == Some("integrant.core/build-failed-spec") {
        if let Some(inner) = data.get_kw(KEY_EXPLAIN).and_then(Value::as_map) {
            if let Some(explain) = explain_of(inner) {
                return Some(explain);
            }
        }
    }

    data.get_kw(SCHEMA_EXPLAIN_KEY).map(|explain| {
        let Some(fields) = explain.as_map() else {
            return display_value(explain);
        };
        let mut out = String::new();
        if let Some(errors) = fields.get_kw("errors") {
            out.push_str("Errors:\n");
            out.push_str(&display_value(errors));
            out.push('\n');
        }
        if let Some(value) = fields.get_kw("value") {
            out.push_str("Value:\n");
            out.push_str(&display_value(value));
            out.push('\n');
        }
        if out.is_empty() {
            display_value(explain)
        } else {
            out
        }
    })
}

/// A Clojure-reader-like rendering of a transit value.
fn display_value(value: &Value) -> String {
    let mut out = String::new();
    write_value(value, &mut out);
    out
}

fn write_value(value: &Value, out: &mut String) {
    use std::fmt::Write as _;

    match value {
        Value::Nil => out.push_str("nil"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Integer(number) => {
            let _ = write!(out, "{number}");
        }
        Value::Double(number) => {
            let _ = write!(out, "{number}");
        }
        Value::BigInteger(rep) | Value::BigDecimal(rep) => out.push_str(rep),
        Value::Special(special) => out.push_str(special.rep()),
        Value::Char(ch) => {
            let _ = write!(out, "\\{ch}");
        }
        Value::Keyword(name) => {
            out.push(':');
            out.push_str(name);
        }
        Value::Symbol(name) => out.push_str(name),
        Value::Str(text) | Value::VerboseInstant(text) | Value::Uri(text) => {
            let _ = write!(out, "{text:?}");
        }
        Value::Binary(bytes) => {
            let _ = write!(out, "#binary[{} bytes]", bytes.len());
        }
        Value::Uuid(uuid) => {
            let _ = write!(out, "#uuid \"{uuid}\"");
        }
        Value::Instant(ms) => {
            let _ = write!(out, "#inst {ms}");
        }
        Value::Duration(ms) => {
            let _ = write!(out, "#duration {ms}");
        }
        Value::List(items) | Value::Array(items) => write_items(items, out),
        Value::Set(items) | Value::OrderedSet(items) => {
            out.push_str("#{");
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(' ');
                }
                write_value(item, out);
            }
            out.push('}');
        }
        Value::Map(map) | Value::OrderedMap(map) | Value::ObjectsMap(map) => {
            write_map(map, out);
        }
        Value::Cmap(entries) => {
            out.push_str("#cmap {");
            for (index, (key, item)) in entries.iter().enumerate() {
                if index > 0 {
                    out.push_str(", ");
                }
                write_value(key, out);
                out.push(' ');
                write_value(item, out);
            }
            out.push('}');
        }
        Value::Quoted(inner) => {
            out.push('\'');
            write_value(inner, out);
        }
        Value::WithMeta { value, meta } => {
            out.push_str("#with-meta ");
            write_value(value, out);
            out.push(' ');
            write_value(meta, out);
        }
        Value::Pointer { id, meta } => {
            out.push_str("#penpot/pointer ");
            write_value(id, out);
            if let Some(meta) = meta {
                out.push(' ');
                write_value(meta, out);
            }
        }
        Value::PathData(path) => out.push_str(&path.to_svg()),
        Value::Tagged { tag, rep } => {
            let _ = write!(out, "#{tag} ");
            write_value(rep, out);
        }
    }
}

fn write_items(items: &[Value], out: &mut String) {
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(' ');
        }
        write_value(item, out);
    }
    out.push(']');
}

fn write_map(map: &Map, out: &mut String) {
    out.push('{');
    for (index, (key, value)) in map.iter().enumerate() {
        if index > 0 {
            out.push_str(", ");
        }
        write_value(key, out);
        out.push(' ');
        write_value(value, out);
    }
    out.push('}');
}
