//! `run-webhook` adapter: encode the event, POST it, record the attempt.
//!
//! The flow mirrors `app.loggers.webhooks/run-webhook-handler`:
//!
//! 1. the body follows `webhook.mtype` (`application/json` camel-cases keys
//!    and indents, `application/transit+json` is compact Transit, the legacy
//!    form type is a query string);
//! 2. a 200 or 204 counts as success, anything else as
//!    `unexpected-status:<code>`;
//! 3. every attempt inserts one `webhook_delivery` row whose `req_data` and
//!    `rsp_data` are verbose Transit JSONB;
//! 4. a delivery failure increments `webhook.error_count` and disables the
//!    webhook once it reaches `max_errors`; a success clears both fields.
//!
//! A transport failure is *recorded*, not returned: the Clojure handler
//! catches it, so the task completes and does not consume a retry. Only a
//! database failure returns an error, which lets the worker retry the task.

use std::sync::Arc;
use std::time::Duration;

use async_trait::async_trait;
use base64::Engine as _;
use chrono::Utc;
use httpclient::{HttpRequest, HttpResponse, Transport};
use sqlx::Row;
use transit::{Map, Value};
use uuid::Uuid;
use worker::{ServiceError, WebhookRunner};

/// Default request timeout, matching `(ct/duration "4s")`.
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(4);

/// Default number of failures before a webhook is disabled.
pub const DEFAULT_MAX_ERRORS: i32 = 3;

const JSON_MTYPE: &str = "application/json";
const TRANSIT_MTYPE: &str = "application/transit+json";
const FORM_MTYPE: &str = "application/x-www-form-urlencoded";

const SQL_WEBHOOK_ERROR: &str = "update webhook \
        set error_code=$1, \
            error_count=error_count+1 \
      where id=$2 \
  returning error_count";

const SQL_WEBHOOK_SUCCESS: &str = "update webhook \
        set updated_at=to_timestamp($1::bigint::double precision / 1000.0), \
            error_code=NULL, \
            error_count=0 \
      where id=$2";

const SQL_WEBHOOK_DELIVERY: &str = "insert into webhook_delivery \
        (webhook_id, created_at, error_code, req_data, rsp_data) \
 values ($1, \
         to_timestamp($2::bigint::double precision / 1000.0), \
         $3, \
         $4::text::jsonb, \
         $5::text::jsonb)";

const SQL_DEACTIVATE_WEBHOOK: &str = "update webhook set is_active=false where id=$1";

/// `run-webhook` service backed by PostgreSQL and an injected transport.
#[derive(Clone)]
pub struct PgWebhookRunner {
    database: db::Database,
    transport: Arc<dyn Transport>,
    max_errors: i32,
    user_agent: String,
}

impl std::fmt::Debug for PgWebhookRunner {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("PgWebhookRunner")
            .field("max_errors", &self.max_errors)
            .field("user_agent", &self.user_agent)
            .finish_non_exhaustive()
    }
}

impl PgWebhookRunner {
    /// Build the runner with the default three-error budget.
    #[must_use]
    pub fn new(database: db::Database, transport: Arc<dyn Transport>) -> Self {
        Self {
            database,
            transport,
            max_errors: DEFAULT_MAX_ERRORS,
            user_agent: concat!("penpot/", env!("CARGO_PKG_VERSION")).to_owned(),
        }
    }

    /// Override the failure budget before the webhook is disabled.
    #[must_use]
    pub fn with_max_errors(mut self, max_errors: i32) -> Self {
        self.max_errors = max_errors;
        self
    }

    /// Override the `user-agent` header.
    ///
    /// The Clojure handler sends `penpot/<version>` from the release metadata.
    /// Deployment has not been wired yet, so the default uses the crate
    /// version; the release build should set the real one here.
    #[must_use]
    pub fn with_user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
        self
    }

    /// The wrapped database handle.
    #[must_use]
    pub fn database(&self) -> &db::Database {
        &self.database
    }

    async fn report_delivery(
        &self,
        webhook_id: Uuid,
        request: &HttpRequest,
        response: Option<&HttpResponse>,
        error: Option<&str>,
    ) -> Result<(), ServiceError> {
        let req_data = transit::encode_verbose(&Value::Map(request_map(request)));
        let rsp_data =
            response.map(|response| transit::encode_verbose(&Value::Map(response_map(response))));
        sqlx::query(SQL_WEBHOOK_DELIVERY)
            .bind(webhook_id)
            .bind(Utc::now().timestamp_millis())
            .bind(error)
            .bind(req_data)
            .bind(rsp_data)
            .execute(self.database.pool())
            .await
            .map_err(|cause| ServiceError::new(cause.to_string()))?;
        Ok(())
    }

    async fn update_webhook(
        &self,
        webhook_id: Uuid,
        error: Option<&str>,
    ) -> Result<(), ServiceError> {
        let Some(error) = error else {
            sqlx::query(SQL_WEBHOOK_SUCCESS)
                .bind(Utc::now().timestamp_millis())
                .bind(webhook_id)
                .execute(self.database.pool())
                .await
                .map_err(|cause| ServiceError::new(cause.to_string()))?;
            return Ok(());
        };

        let row = sqlx::query(SQL_WEBHOOK_ERROR)
            .bind(error)
            .bind(webhook_id)
            .fetch_optional(self.database.pool())
            .await
            .map_err(|cause| ServiceError::new(cause.to_string()))?;
        let Some(row) = row else {
            return Ok(());
        };
        let count: i16 = row
            .try_get("error_count")
            .map_err(|cause| ServiceError::new(cause.to_string()))?;
        if i32::from(count) >= self.max_errors {
            sqlx::query(SQL_DEACTIVATE_WEBHOOK)
                .bind(webhook_id)
                .execute(self.database.pool())
                .await
                .map_err(|cause| ServiceError::new(cause.to_string()))?;
        }
        Ok(())
    }
}

#[async_trait]
impl WebhookRunner for PgWebhookRunner {
    async fn run(&self, event: &Map, config: &Map) -> Result<(), ServiceError> {
        let delivery = prepare(event, config, &self.user_agent)?;
        let webhook_id = delivery.webhook_id;
        let request = delivery.request;

        match self.transport.send(request.clone()).await {
            Ok(response) => {
                let error = interpret_response(response.status);
                self.report_delivery(webhook_id, &request, Some(&response), error.as_deref())
                    .await?;
                self.update_webhook(webhook_id, error.as_deref()).await?;
            }
            Err(cause) => {
                let error = cause.code();
                self.report_delivery(webhook_id, &request, None, Some(&error))
                    .await?;
                self.update_webhook(webhook_id, Some(&error)).await?;
            }
        }
        Ok(())
    }
}

/// A request plus the row id it belongs to.
#[derive(Debug, Clone)]
struct Delivery {
    webhook_id: Uuid,
    request: HttpRequest,
}

fn prepare(event: &Map, config: &Map, user_agent: &str) -> Result<Delivery, ServiceError> {
    let webhook_id = config
        .get_kw("id")
        .and_then(Value::as_uuid)
        .ok_or_else(|| ServiceError::new("webhook config `id` must be a UUID"))?;
    let uri = config
        .get_kw("uri")
        .and_then(string_value)
        .ok_or_else(|| ServiceError::new("webhook config `uri` must be a string"))?;
    let mtype = config
        .get_kw("mtype")
        .and_then(Value::as_str)
        .ok_or_else(|| ServiceError::new("webhook config `mtype` must be a string"))?;

    let body = encode_body(event, mtype)?;
    Ok(Delivery {
        webhook_id,
        request: HttpRequest {
            method: "POST".to_owned(),
            uri: uri.to_owned(),
            headers: vec![
                ("content-type".to_owned(), mtype.to_owned()),
                ("user-agent".to_owned(), user_agent.to_owned()),
            ],
            body,
            timeout: REQUEST_TIMEOUT,
        },
    })
}

fn string_value(value: &Value) -> Option<&str> {
    match value {
        Value::Str(text) | Value::Uri(text) => Some(text),
        _ => None,
    }
}

/// 200 and 204 are success; every other status becomes an error code.
#[must_use]
pub fn interpret_response(status: u16) -> Option<String> {
    if status == 200 || status == 204 {
        None
    } else {
        Some(format!("unexpected-status:{status}"))
    }
}

fn encode_body(event: &Map, mtype: &str) -> Result<String, ServiceError> {
    match mtype {
        JSON_MTYPE => Ok(json_encode(&Value::Map(event.clone()))),
        TRANSIT_MTYPE => Ok(transit::encode(&Value::Map(event.clone()))),
        FORM_MTYPE => Ok(form_encode(event)),
        other => Err(ServiceError::new(format!(
            "unsupported webhook mtype `{other}`"
        ))),
    }
}

fn request_map(request: &HttpRequest) -> Map {
    let mut map = Map::new();
    map.insert(
        Value::Keyword("uri".to_owned()),
        Value::Str(request.uri.clone()),
    );
    map.insert(
        Value::Keyword("headers".to_owned()),
        Value::Map(headers_map(&request.headers)),
    );
    map.insert(
        Value::Keyword("timeout".to_owned()),
        Value::Duration(duration_millis(request.timeout)),
    );
    map.insert(
        Value::Keyword("method".to_owned()),
        Value::Keyword(request.method.to_ascii_lowercase()),
    );
    map.insert(
        Value::Keyword("body".to_owned()),
        Value::Str(request.body.clone()),
    );
    map
}

fn response_map(response: &HttpResponse) -> Map {
    let mut map = Map::new();
    map.insert(
        Value::Keyword("status".to_owned()),
        Value::Integer(i64::from(response.status)),
    );
    map.insert(
        Value::Keyword("headers".to_owned()),
        Value::Map(headers_map(&response.headers)),
    );
    map.insert(
        Value::Keyword("body".to_owned()),
        Value::Str(response.body.clone()),
    );
    map
}

fn headers_map(headers: &[(String, String)]) -> Map {
    headers
        .iter()
        .map(|(name, value)| (Value::Str(name.clone()), Value::Str(value.clone())))
        .collect()
}

fn duration_millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// `clojure.data.json/write-str` with `:key-fn str/camel` and `:indent true`.
fn json_encode(value: &Value) -> String {
    let mut out = String::new();
    write_json(value, 0, &mut out);
    out
}

fn write_json(value: &Value, depth: usize, out: &mut String) {
    match value {
        Value::Nil => out.push_str("null"),
        Value::Bool(true) => out.push_str("true"),
        Value::Bool(false) => out.push_str("false"),
        Value::Integer(integer) => out.push_str(&integer.to_string()),
        Value::Double(double) => out.push_str(&transit::json::fmt_f64(*double)),
        Value::Special(special) => {
            out.push_str("~z");
            out.push_str(special.rep());
        }
        Value::Char(character) => out.push_str(&transit::json::json_string(&character.to_string())),
        Value::BigInteger(rep) | Value::BigDecimal(rep) => out.push_str(rep),
        Value::Keyword(name) | Value::Symbol(name) => {
            out.push_str(&transit::json::json_string(name));
        }
        Value::Str(text) | Value::VerboseInstant(text) | Value::Uri(text) => {
            out.push_str(&transit::json::json_string(text));
        }
        Value::Binary(bytes) => out.push_str(&transit::json::json_string(
            &base64::engine::general_purpose::STANDARD.encode(bytes),
        )),
        Value::Uuid(uuid) => out.push_str(&transit::json::json_string(&uuid.to_string())),
        Value::Instant(millis) => out.push_str(&transit::json::json_string(&instant(*millis))),
        Value::Duration(millis) => out.push_str(&millis.to_string()),
        Value::List(items) | Value::Array(items) => write_array(items, depth, out),
        Value::Set(set) | Value::OrderedSet(set) => {
            let items: Vec<Value> = set.iter().cloned().collect();
            write_array(&items, depth, out);
        }
        Value::Map(map) | Value::OrderedMap(map) | Value::ObjectsMap(map) => {
            write_object(map, depth, out);
        }
        Value::Cmap(entries) => {
            let mut map = Map::new();
            for (key, value) in entries {
                map.insert(key.clone(), value.clone());
            }
            write_object(&map, depth, out);
        }
        Value::Quoted(inner) => write_json(inner, depth, out),
        Value::WithMeta { value, .. } => write_json(value, depth, out),
        Value::Pointer { id, .. } => write_json(id, depth, out),
        Value::PathData(path) => {
            out.push_str(&transit::json::json_string(&path.to_svg()));
        }
        Value::Tagged { rep, .. } => write_json(rep, depth, out),
    }
}

fn write_array(items: &[Value], depth: usize, out: &mut String) {
    if items.is_empty() {
        out.push_str("[]");
        return;
    }
    out.push('[');
    for (index, item) in items.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('\n');
        indent(depth + 1, out);
        write_json(item, depth + 1, out);
    }
    out.push('\n');
    indent(depth, out);
    out.push(']');
}

fn write_object(map: &Map, depth: usize, out: &mut String) {
    if map.is_empty() {
        out.push_str("{}");
        return;
    }
    out.push('{');
    for (index, (key, value)) in map.iter().enumerate() {
        if index > 0 {
            out.push(',');
        }
        out.push('\n');
        indent(depth + 1, out);
        out.push_str(&transit::json::json_string(&json_key(key)));
        out.push_str(": ");
        write_json(value, depth + 1, out);
    }
    out.push('\n');
    indent(depth, out);
    out.push('}');
}

fn indent(depth: usize, out: &mut String) {
    for _ in 0..depth {
        out.push_str("  ");
    }
}

fn json_key(key: &Value) -> String {
    match key {
        Value::Keyword(name) => camel_case(name),
        Value::Str(text) => text.clone(),
        other => scalar_text(other),
    }
}

fn camel_case(name: &str) -> String {
    let mut out = String::with_capacity(name.len());
    let mut uppercase = false;
    for character in name.chars() {
        if character == '-' || character == '_' {
            uppercase = true;
            continue;
        }
        if uppercase {
            out.extend(character.to_uppercase());
            uppercase = false;
        } else {
            out.push(character);
        }
    }
    out
}

fn scalar_text(value: &Value) -> String {
    match value {
        Value::Nil => String::new(),
        Value::Bool(value) => value.to_string(),
        Value::Integer(value) => value.to_string(),
        Value::Double(value) => transit::json::fmt_f64(*value),
        Value::Keyword(name) | Value::Symbol(name) => name.clone(),
        Value::Str(text) => text.clone(),
        Value::Uuid(uuid) => uuid.to_string(),
        other => json_encode(other),
    }
}

/// Legacy form body; the RPC schema no longer creates this type.
fn form_encode(map: &Map) -> String {
    let mut serializer = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in map.iter() {
        if matches!(value, Value::Nil) {
            continue;
        }
        serializer.append_pair(&form_key(key), &scalar_text(value));
    }
    serializer.finish()
}

fn form_key(key: &Value) -> String {
    match key {
        Value::Keyword(name) | Value::Symbol(name) | Value::Str(name) => name.clone(),
        other => scalar_text(other),
    }
}

fn instant(millis: i64) -> String {
    chrono::DateTime::<chrono::Utc>::from_timestamp_millis(millis).map_or_else(
        || millis.to_string(),
        |instant| instant.to_rfc3339_opts(chrono::SecondsFormat::Millis, true),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(mtype: &str) -> Map {
        let mut map = Map::new();
        map.insert(
            Value::Keyword("id".to_owned()),
            Value::Uuid(Uuid::from_u128(7)),
        );
        map.insert(
            Value::Keyword("uri".to_owned()),
            Value::Str("https://hooks.example.com/penpot".to_owned()),
        );
        map.insert(
            Value::Keyword("mtype".to_owned()),
            Value::Str(mtype.to_owned()),
        );
        map
    }

    fn event() -> Map {
        let mut props = Map::new();
        props.insert(
            Value::Keyword("team-id".to_owned()),
            Value::Uuid(Uuid::from_u128(9)),
        );
        let mut event = Map::new();
        event.insert(
            Value::Keyword("type".to_owned()),
            Value::Str("command".to_owned()),
        );
        event.insert(
            Value::Keyword("name".to_owned()),
            Value::Str("create-project".to_owned()),
        );
        event.insert(Value::Keyword("props".to_owned()), Value::Map(props));
        event
    }

    #[test]
    fn json_bodies_use_camel_case_keys_and_indentation() {
        let delivery = prepare(&event(), &config(JSON_MTYPE), "penpot/2.17.0").expect("prepare");
        assert_eq!(
            delivery.request.body,
            "{\n  \"type\": \"command\",\n  \"name\": \"create-project\",\n  \"props\": {\n    \"teamId\": \"00000000-0000-0000-0000-000000000009\"\n  }\n}"
        );
        assert_eq!(delivery.webhook_id, Uuid::from_u128(7));
        assert_eq!(
            delivery.request.headers,
            vec![
                ("content-type".to_owned(), JSON_MTYPE.to_owned()),
                ("user-agent".to_owned(), "penpot/2.17.0".to_owned()),
            ]
        );
        assert_eq!(delivery.request.timeout, REQUEST_TIMEOUT);
    }

    #[test]
    fn transit_bodies_stay_compact() {
        let delivery = prepare(&event(), &config(TRANSIT_MTYPE), "penpot/2.17.0").expect("prepare");
        assert_eq!(
            delivery.request.body,
            "[\"^ \",\"~:type\",\"command\",\"~:name\",\"create-project\",\"~:props\",[\"^ \",\"~:team-id\",\"~u00000000-0000-0000-0000-000000000009\"]]"
        );
    }

    #[test]
    fn form_bodies_skip_nil_values() {
        let mut payload = event();
        payload.insert(Value::Keyword("empty".to_owned()), Value::Nil);
        let delivery = prepare(&payload, &config(FORM_MTYPE), "penpot/2.17.0").expect("prepare");
        assert!(delivery
            .request
            .body
            .starts_with("type=command&name=create-project&"));
        assert!(!delivery.request.body.contains("empty="));
    }

    #[test]
    fn unknown_mtypes_are_rejected() {
        let error = prepare(&event(), &config("text/xml"), "penpot/2.17.0").expect_err("mtype");
        assert!(error.message().contains("unsupported webhook mtype"));
    }

    #[test]
    fn a_missing_id_is_rejected() {
        let mut config = config(JSON_MTYPE);
        config.remove(&Value::Keyword("id".to_owned()));
        let error = prepare(&event(), &config, "penpot/2.17.0").expect_err("id");
        assert!(error.message().contains("`id`"));
    }

    #[test]
    fn responses_other_than_200_and_204_fail() {
        assert!(interpret_response(200).is_none());
        assert!(interpret_response(204).is_none());
        assert_eq!(
            interpret_response(400).as_deref(),
            Some("unexpected-status:400")
        );
    }

    #[test]
    fn camel_case_handles_kebab_and_underscore_names() {
        assert_eq!(camel_case("team-id"), "teamId");
        assert_eq!(camel_case("created_at"), "createdAt");
        assert_eq!(camel_case("id"), "id");
        assert_eq!(camel_case("rollback?"), "rollback?");
    }
}
