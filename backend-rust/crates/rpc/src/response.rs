//! Command results and their wire encoding.

use axum::http::{header, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use transit::Value;

/// One SSE frame: `event: <name>` plus a verbose-transit `data:` line.
#[derive(Debug, Clone)]
pub struct SseEvent {
    pub event: String,
    pub data: Value,
}

impl SseEvent {
    #[must_use]
    pub fn new(event: impl Into<String>, data: Value) -> Self {
        Self {
            event: event.into(),
            data,
        }
    }
}

/// What a command returns.
#[derive(Debug, Clone)]
pub enum CommandBody {
    /// No body; `handle-response` maps this to 204.
    None,
    Transit(Value),
    /// A fixed batch of frames. Live streaming arrives with the msgbus (M7).
    Sse(Vec<SseEvent>),
}

/// A command's HTTP result before transit encoding.
#[derive(Debug, Clone)]
pub struct CommandResult {
    status: Option<StatusCode>,
    headers: Vec<(String, String)>,
    body: CommandBody,
}

impl CommandResult {
    #[must_use]
    pub fn ok(value: Value) -> Self {
        Self {
            status: None,
            headers: Vec::new(),
            body: CommandBody::Transit(value),
        }
    }

    /// A `nil` result: the router answers 204.
    #[must_use]
    pub fn empty() -> Self {
        Self {
            status: None,
            headers: Vec::new(),
            body: CommandBody::None,
        }
    }

    #[must_use]
    pub fn sse(events: impl IntoIterator<Item = SseEvent>) -> Self {
        Self {
            status: None,
            headers: Vec::new(),
            body: CommandBody::Sse(events.into_iter().collect()),
        }
    }

    /// `::http/status` metadata.
    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = StatusCode::from_u16(status).ok();
        self
    }

    /// `::http/headers` metadata. Invalid names/values are skipped.
    #[must_use]
    pub fn with_header(mut self, name: impl Into<String>, value: impl Into<String>) -> Self {
        self.headers.push((name.into(), value.into()));
        self
    }

    #[must_use]
    pub fn body(&self) -> &CommandBody {
        &self.body
    }
}

/// Encode a command result with the same content types as
/// `app.http.middleware/wrap-format-response`.
#[must_use]
pub fn encode(result: &CommandResult, verbose: bool) -> Response {
    let status = result.status.unwrap_or(match result.body {
        CommandBody::None => StatusCode::NO_CONTENT,
        _ => StatusCode::OK,
    });

    let response = match &result.body {
        CommandBody::None => Response::builder()
            .status(status)
            .body(axum::body::Body::empty()),
        CommandBody::Transit(value) => {
            let body = if verbose {
                transit::encode_verbose(value)
            } else {
                transit::encode(value)
            };
            Response::builder()
                .status(status)
                .header(header::CONTENT_TYPE, "application/transit+json")
                .body(axum::body::Body::from(body))
        }
        CommandBody::Sse(events) => Response::builder()
            .status(status)
            .header(header::CONTENT_TYPE, "text/event-stream;charset=UTF-8")
            .header(
                header::CACHE_CONTROL,
                "no-cache, no-store, max-age=0, must-revalidate",
            )
            .header(header::PRAGMA, "no-cache")
            .header("x-accel-buffering", "no")
            .body(axum::body::Body::from(render_sse(events))),
    };

    let Ok(mut response) = response else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };

    for (name, value) in &result.headers {
        let (Ok(name), Ok(value)) = (
            name.parse::<axum::http::HeaderName>(),
            HeaderValue::from_str(value),
        ) else {
            continue;
        };
        response.headers_mut().insert(name, value);
    }

    response
}

/// `event: <name>\ndata: <verbose transit>\n\n` (see `app.http.sse`).
fn render_sse(events: &[SseEvent]) -> String {
    let mut out = String::new();
    for event in events {
        out.push_str("event: ");
        out.push_str(&event.event);
        out.push('\n');
        out.push_str("data: ");
        out.push_str(&transit::encode_verbose(&event.data));
        out.push_str("\n\n");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    async fn body_text(response: Response) -> String {
        let bytes = response
            .into_body()
            .collect()
            .await
            .expect("body")
            .to_bytes();
        String::from_utf8(bytes.to_vec()).expect("utf-8")
    }

    #[tokio::test]
    async fn empty_results_are_204() {
        let response = encode(&CommandResult::empty(), false);
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
        assert!(body_text(response).await.is_empty());
    }

    #[tokio::test]
    async fn transit_bodies_are_compact_by_default_and_verbose_on_demand() {
        let result = CommandResult::ok(Value::map([(Value::kw("a"), Value::Integer(1))]));

        let response = encode(&result, false);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "application/transit+json"
        );
        assert_eq!(body_text(response).await, r#"["^ ","~:a",1]"#);

        let response = encode(&result, true);
        assert_eq!(body_text(response).await, r#"{"~:a":1}"#);
    }

    #[tokio::test]
    async fn status_and_headers_override_the_defaults() {
        let result = CommandResult::ok(Value::Integer(1))
            .with_status(201)
            .with_header("x-test", "yes");
        let response = encode(&result, false);
        assert_eq!(response.status(), StatusCode::CREATED);
        assert_eq!(response.headers().get("x-test").unwrap(), "yes");
    }

    #[tokio::test]
    async fn sse_frames_use_verbose_transit() {
        let result = CommandResult::sse([SseEvent::new(
            "update",
            Value::map([(Value::kw("a"), Value::Integer(1))]),
        )]);
        let response = encode(&result, false);
        assert_eq!(
            response.headers().get(header::CONTENT_TYPE).unwrap(),
            "text/event-stream;charset=UTF-8"
        );
        assert_eq!(
            body_text(response).await,
            "event: update\ndata: {\"~:a\":1}\n\n"
        );
    }
}
