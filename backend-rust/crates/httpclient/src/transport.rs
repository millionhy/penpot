//! One-shot outbound POST transport.
//!
//! The trait exists so the webhook adapter can be tested without a socket.
//! [`ReqwestTransport`] is the production implementation: no redirects, no
//! system proxy, a per-request timeout, and the validated addresses pinned on
//! the client. A client is built per request so one host's pinned addresses
//! never leak into another host's connection pool.

use std::time::Duration;

use async_trait::async_trait;
use url::{Host, Url};

use crate::ssrf::SsrfPolicy;

/// Upper bound on a recorded response body.
pub const MAX_RESPONSE_BODY: usize = 64 * 1024;

/// One outbound request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpRequest {
    /// HTTP method, upper case.
    pub method: String,
    /// Absolute `http` or `https` URI.
    pub uri: String,
    /// Header name/value pairs, in send order.
    pub headers: Vec<(String, String)>,
    /// UTF-8 body.
    pub body: String,
    /// Total request timeout.
    pub timeout: Duration,
}

/// One response, already decoded as text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HttpResponse {
    /// Status code.
    pub status: u16,
    /// Response headers with lower-case names.
    pub headers: Vec<(String, String)>,
    /// Body, truncated at [`MAX_RESPONSE_BODY`].
    pub body: String,
}

/// Failure classes that `interpret-exception` maps to a delivery error code.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TransportError {
    /// The URI could not be parsed or the method is invalid.
    InvalidUri,
    /// The SSRF policy refused the target; the payload is the hint.
    Blocked(String),
    /// The request exceeded its timeout.
    Timeout,
    /// The connection could not be established.
    Connect,
    /// TLS validation failed.
    Tls,
    /// Anything else.
    Other(String),
}

impl TransportError {
    /// The `webhook.error_code` value.
    ///
    /// `Other` maps to `unknown` instead of Clojure's `nil`: the delivery must
    /// show up as a failure, otherwise an unclassified cause silently resets
    /// the error counter.
    #[must_use]
    pub fn code(&self) -> String {
        match self {
            Self::InvalidUri => "invalid-uri".to_owned(),
            Self::Blocked(hint) => format!("blocked-request:{hint}"),
            Self::Timeout => "timeout".to_owned(),
            Self::Connect => "connection-error".to_owned(),
            Self::Tls => "ssl-validation-error".to_owned(),
            Self::Other(_) => "unknown".to_owned(),
        }
    }
}

impl std::fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Other(reason) => formatter.write_str(reason),
            other => formatter.write_str(&other.code()),
        }
    }
}

impl std::error::Error for TransportError {}

/// Send one request.
#[async_trait]
pub trait Transport: Send + Sync {
    /// Perform the request.
    ///
    /// # Errors
    ///
    /// Returns the classified failure; the caller records it and does not
    /// retry the task.
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError>;
}

/// `reqwest`-backed transport.
pub struct ReqwestTransport {
    policy: SsrfPolicy,
    max_body: usize,
}

impl std::fmt::Debug for ReqwestTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ReqwestTransport")
            .field("max_body", &self.max_body)
            .finish_non_exhaustive()
    }
}

impl ReqwestTransport {
    /// Build the transport around an SSRF policy.
    #[must_use]
    pub fn new(policy: SsrfPolicy) -> Self {
        Self {
            policy,
            max_body: MAX_RESPONSE_BODY,
        }
    }

    /// The policy used for every request.
    #[must_use]
    pub fn policy(&self) -> &SsrfPolicy {
        &self.policy
    }

    /// Override the response body cap.
    #[must_use]
    pub fn with_max_body(mut self, max_body: usize) -> Self {
        self.max_body = max_body;
        self
    }
}

#[async_trait]
impl Transport for ReqwestTransport {
    async fn send(&self, request: HttpRequest) -> Result<HttpResponse, TransportError> {
        let url = Url::parse(&request.uri).map_err(|_| TransportError::InvalidUri)?;
        let addresses = self
            .policy
            .resolve(&url)
            .await
            .map_err(|blocked| TransportError::Blocked(blocked.hint().to_owned()))?;

        let mut builder = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(request.timeout);
        if let Some(Host::Domain(domain)) = url.host() {
            if !addresses.is_empty() {
                builder = builder.resolve_to_addrs(domain, &addresses);
            }
        }
        let client = builder
            .build()
            .map_err(|error| TransportError::Other(error.to_string()))?;

        let method = reqwest::Method::from_bytes(request.method.to_ascii_uppercase().as_bytes())
            .map_err(|_| TransportError::InvalidUri)?;
        let mut builder = client.request(method, url).timeout(request.timeout);
        for (name, value) in &request.headers {
            builder = builder.header(name, value);
        }

        let response = builder.body(request.body).send().await.map_err(classify)?;
        let status = response.status().as_u16();
        let headers = response
            .headers()
            .iter()
            .map(|(name, value)| {
                (
                    name.as_str().to_ascii_lowercase(),
                    value.to_str().unwrap_or_default().to_owned(),
                )
            })
            .collect();
        let bytes = response.bytes().await.map_err(classify)?;
        Ok(HttpResponse {
            status,
            headers,
            body: decode_body(&bytes, self.max_body),
        })
    }
}

fn decode_body(bytes: &[u8], limit: usize) -> String {
    let end = bytes.len().min(limit);
    String::from_utf8_lossy(&bytes[..end]).into_owned()
}

fn classify(error: reqwest::Error) -> TransportError {
    if error.is_timeout() {
        return TransportError::Timeout;
    }
    if error.is_connect() {
        if chain_mentions(&error, &["certificate", "tls", "handshake"]) {
            return TransportError::Tls;
        }
        return TransportError::Connect;
    }
    if error.is_builder() {
        return TransportError::InvalidUri;
    }
    TransportError::Other(error.to_string())
}

fn chain_mentions(error: &reqwest::Error, needles: &[&str]) -> bool {
    let mut current: Option<&(dyn std::error::Error + 'static)> = Some(error);
    while let Some(error) = current {
        let text = error.to_string().to_ascii_lowercase();
        if needles.iter().any(|needle| text.contains(needle)) {
            return true;
        }
        current = error.source();
    }
    false
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    use super::*;

    #[test]
    fn error_codes_match_the_clojure_strings() {
        assert_eq!(TransportError::InvalidUri.code(), "invalid-uri");
        assert_eq!(
            TransportError::Blocked("uri target is not allowed".to_owned()).code(),
            "blocked-request:uri target is not allowed"
        );
        assert_eq!(TransportError::Timeout.code(), "timeout");
        assert_eq!(TransportError::Connect.code(), "connection-error");
        assert_eq!(TransportError::Tls.code(), "ssl-validation-error");
        assert_eq!(TransportError::Other("boom".to_owned()).code(), "unknown");
    }

    #[test]
    fn bodies_are_truncated_at_the_limit() {
        assert_eq!(decode_body(b"abcdef", 3), "abc");
        assert_eq!(decode_body(b"abc", 10), "abc");
        assert_eq!(decode_body(&[0xff, 0x41], 10), "\u{fffd}A");
    }

    #[tokio::test]
    async fn an_allowlisted_host_receives_the_request() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("listener");
        let address = listener.local_addr().expect("address");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept");
            let mut buffer = vec![0_u8; 4096];
            let read = socket.read(&mut buffer).await.expect("read");
            let request = String::from_utf8_lossy(&buffer[..read]).into_owned();
            socket
                .write_all(b"HTTP/1.1 200 OK\r\ncontent-length: 2\r\nconnection: close\r\n\r\nok")
                .await
                .expect("write");
            request
        });

        let policy = SsrfPolicy::new(BTreeSet::from(["127.0.0.1".to_owned()]), &BTreeSet::new());
        let transport = ReqwestTransport::new(policy);
        let response = transport
            .send(HttpRequest {
                method: "POST".to_owned(),
                uri: format!("http://{address}/hook"),
                headers: vec![("content-type".to_owned(), "application/json".to_owned())],
                body: "{\"ok\":true}".to_owned(),
                timeout: Duration::from_secs(5),
            })
            .await
            .expect("response");
        assert_eq!(response.status, 200);
        assert_eq!(response.body, "ok");

        let request = server.await.expect("server");
        assert!(request.starts_with("POST /hook HTTP/1.1\r\n"));
        assert!(request.contains("content-type: application/json"));
        assert!(request.ends_with("{\"ok\":true}"));
    }

    #[tokio::test]
    async fn a_blocked_target_never_opens_a_socket() {
        let transport = ReqwestTransport::new(SsrfPolicy::default());
        let error = transport
            .send(HttpRequest {
                method: "POST".to_owned(),
                uri: "http://127.0.0.1:9/hook".to_owned(),
                headers: Vec::new(),
                body: String::new(),
                timeout: Duration::from_millis(50),
            })
            .await
            .expect_err("blocked");
        assert_eq!(
            error,
            TransportError::Blocked("uri target is not allowed".to_owned())
        );
    }
}
