//! Axum router and WebSocket transport for `/ws/notifications`.

use std::sync::Arc;

use axum::body::Body;
use axum::extract::{RawQuery, State};
use axum::http::header::{self, HeaderMap, HeaderValue};
use axum::http::{Request, Response, StatusCode};
use axum::routing::get;
use axum::Router;
use base64::Engine as _;
use futures_util::{SinkExt as _, StreamExt as _};
use hyper_util::rt::TokioIo;
use sha1::{Digest, Sha1};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::mpsc;
use tokio::time::{interval_at, Instant, MissedTickBehavior};
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::frame::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::{Message, Role, WebSocketConfig};
use tokio_tungstenite::WebSocketStream;
use transit::Value;
use uuid::Uuid;

use crate::heartbeat::HEARTBEAT_TIMEOUT_CLOSE_CODE;
use crate::{
    AccessControl, Heartbeat, Protocol, ProtocolOptions, RedisBus, Result, ServerFrame, WsError,
};

const WEBSOCKET_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_SIZE: usize = 1024 * 1024;
const MAX_FRAME_SIZE: usize = 256 * 1024;

/// Compute the RFC 6455 `Sec-WebSocket-Accept` response value.
#[must_use]
pub fn websocket_accept_key(key: &str) -> String {
    let mut hasher = Sha1::new();
    hasher.update(key.as_bytes());
    hasher.update(WEBSOCKET_GUID.as_bytes());
    base64::engine::general_purpose::STANDARD.encode(hasher.finalize())
}

/// Authentication boundary used when a socket connects.
pub trait WebSocketAuth: Send + Sync {
    /// Resolve the authenticated profile for a browser session.
    ///
    /// `Ok(None)` means the session is valid but has no profile, which the
    /// endpoint reports as `401`. An `Err` is treated as a server failure.
    ///
    /// # Errors
    ///
    /// Returns an error when the session store cannot answer.
    fn profile(&self, headers: &HeaderMap, session_id: Uuid) -> Result<Option<Uuid>>;
}

/// Authentication stub used by offline tests and local runs.
#[derive(Debug, Clone, Copy)]
pub struct FixedIdentity {
    profile_id: Option<Uuid>,
}

impl FixedIdentity {
    /// Always resolve to the supplied profile, or to no profile.
    #[must_use]
    pub const fn new(profile_id: Option<Uuid>) -> Self {
        Self { profile_id }
    }
}

impl WebSocketAuth for FixedIdentity {
    fn profile(&self, _headers: &HeaderMap, _session_id: Uuid) -> Result<Option<Uuid>> {
        Ok(self.profile_id)
    }
}

/// Shared dependencies of the notification endpoint.
#[derive(Clone)]
pub struct WsState {
    bus: Arc<dyn RedisBus>,
    access: Arc<dyn AccessControl>,
    auth: Arc<dyn WebSocketAuth>,
    options: ProtocolOptions,
}

impl WsState {
    /// Build endpoint state with the production protocol defaults.
    #[must_use]
    pub fn new(
        bus: Arc<dyn RedisBus>,
        access: Arc<dyn AccessControl>,
        auth: Arc<dyn WebSocketAuth>,
    ) -> Self {
        Self {
            bus,
            access,
            auth,
            options: ProtocolOptions::default(),
        }
    }

    /// Replace the protocol options, mostly for tests and tuning.
    #[must_use]
    pub fn with_options(mut self, options: ProtocolOptions) -> Self {
        self.options = options;
        self
    }
}

/// Build the axum router that exposes `/ws/notifications`.
pub fn build_router(state: WsState) -> Router {
    Router::new()
        .route("/ws/notifications", get(notifications))
        .with_state(state)
}

async fn notifications(
    State(state): State<WsState>,
    RawQuery(query): RawQuery,
    headers: HeaderMap,
    request: Request<Body>,
) -> Response<Body> {
    let Some(raw_session_id) = query.as_deref().and_then(|query| {
        url::form_urlencoded::parse(query.as_bytes())
            .find(|(key, _)| key == "session-id")
            .map(|(_, value)| value.into_owned())
    }) else {
        return plain_error(StatusCode::BAD_REQUEST, "missing session-id");
    };
    let Ok(session_id) = Uuid::parse_str(&raw_session_id) else {
        return plain_error(StatusCode::BAD_REQUEST, "invalid session-id");
    };

    let profile_id = match state.auth.profile(&headers, session_id) {
        Ok(Some(profile_id)) => profile_id,
        Ok(None) => return plain_error(StatusCode::UNAUTHORIZED, "authentication required"),
        Err(error) => {
            tracing::warn!(%error, "websocket authentication failed");
            return plain_error(StatusCode::INTERNAL_SERVER_ERROR, "authentication failed");
        }
    };

    let Some(accept) = handshake_accept_key(&headers) else {
        return plain_error(
            StatusCode::BAD_REQUEST,
            "this endpoint only accepts websocket connections",
        );
    };

    let mut response = Response::new(Body::empty());
    *response.status_mut() = StatusCode::SWITCHING_PROTOCOLS;
    let response_headers = response.headers_mut();
    response_headers.insert(header::CONNECTION, HeaderValue::from_static("upgrade"));
    response_headers.insert(header::UPGRADE, HeaderValue::from_static("websocket"));
    let accept = HeaderValue::from_str(&accept).expect("base64 accept key is a header value");
    response_headers.insert(header::SEC_WEBSOCKET_ACCEPT, accept);

    if request
        .extensions()
        .get::<hyper::upgrade::OnUpgrade>()
        .is_some()
    {
        let upgraded = hyper::upgrade::on(request);
        tokio::spawn(async move {
            match upgraded.await {
                Ok(upgraded) => {
                    let io = TokioIo::new(upgraded);
                    if let Err(error) = serve_socket(io, state, profile_id, session_id).await {
                        tracing::warn!(%error, "websocket connection ended with an error");
                    }
                }
                Err(error) => tracing::warn!(%error, "websocket upgrade failed"),
            }
        });
    }

    response
}

fn plain_error(status: StatusCode, message: &'static str) -> Response<Body> {
    let mut response = Response::new(Body::from(message));
    *response.status_mut() = status;
    response
}

fn handshake_accept_key(headers: &HeaderMap) -> Option<String> {
    if !header_has_token(headers, header::CONNECTION, "upgrade") {
        return None;
    }
    if !header_has_token(headers, header::UPGRADE, "websocket") {
        return None;
    }
    if header_str(headers, header::SEC_WEBSOCKET_VERSION)? != "13" {
        return None;
    }
    let key = header_str(headers, header::SEC_WEBSOCKET_KEY)?;
    let decoded = base64::engine::general_purpose::STANDARD.decode(key).ok()?;
    if decoded.len() != 16 {
        return None;
    }
    Some(websocket_accept_key(key))
}

fn header_str(headers: &HeaderMap, name: header::HeaderName) -> Option<&str> {
    headers.get(name).and_then(|value| value.to_str().ok())
}

fn header_has_token(headers: &HeaderMap, name: header::HeaderName, token: &str) -> bool {
    headers
        .get_all(name)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(','))
        .any(|value| value.trim().eq_ignore_ascii_case(token))
}

async fn serve_socket<S>(io: S, state: WsState, profile_id: Uuid, session_id: Uuid) -> Result<()>
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let config = WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_SIZE))
        .max_frame_size(Some(MAX_FRAME_SIZE));
    let socket = WebSocketStream::from_raw_socket(io, Role::Server, Some(config)).await;
    let (mut sink, mut stream) = socket.split();

    let (input_tx, input_rx) = mpsc::channel(state.options.input_capacity);
    let (output_tx, mut output_rx) = mpsc::channel(state.options.output_capacity);
    let protocol = Protocol::new(
        Arc::clone(&state.bus),
        Arc::clone(&state.access),
        profile_id,
        session_id,
        state.options.clone(),
    );
    let protocol_task = tokio::spawn(protocol.run(input_rx, output_tx));

    let mut heartbeat = Heartbeat::new(state.options.max_missed_heartbeats);
    let mut ticker = interval_at(
        Instant::now() + state.options.heartbeat_interval,
        state.options.heartbeat_interval,
    );
    ticker.set_missed_tick_behavior(MissedTickBehavior::Delay);

    let result = loop {
        tokio::select! {
            frame = output_rx.recv() => {
                let Some(frame) = frame else { break Ok(()) };
                if let Err(error) = write_frame(&mut sink, frame).await {
                    break Err(error);
                }
            }
            message = stream.next() => {
                match message {
                    Some(Ok(Message::Text(text))) => {
                        if input_tx.send(text.to_string()).await.is_err() {
                            break Err(WsError::Closed);
                        }
                    }
                    Some(Ok(Message::Ping(payload))) => {
                        if let Err(error) = sink.send(Message::Pong(payload)).await {
                            break Err(WsError::Transport(error.to_string()));
                        }
                    }
                    Some(Ok(Message::Pong(payload))) => {
                        if !heartbeat.on_pong(&payload) {
                            tracing::debug!("ignoring a pong that matches no outstanding ping");
                        }
                    }
                    Some(Ok(Message::Close(_))) => {
                        let _ = sink.send(Message::Close(None)).await;
                        break Ok(());
                    }
                    Some(Ok(Message::Binary(_))) => {
                        tracing::warn!("ignoring binary websocket message");
                    }
                    Some(Ok(Message::Frame(_))) => {}
                    Some(Err(error)) => break Err(WsError::Transport(error.to_string())),
                    None => break Ok(()),
                }
            }
            _ = ticker.tick() => {
                match heartbeat.next_ping() {
                    Ok(payload) => {
                        if let Err(error) = sink.send(Message::Ping(payload.to_vec().into())).await {
                            break Err(WsError::Transport(error.to_string()));
                        }
                        if heartbeat.outstanding() >= state.options.max_missed_heartbeats {
                            let close = CloseFrame {
                                code: CloseCode::from(HEARTBEAT_TIMEOUT_CLOSE_CODE),
                                reason: "missing to many pings".into(),
                            };
                            let _ = sink.send(Message::Close(Some(close))).await;
                            break Err(WsError::HeartbeatTimeout);
                        }
                    }
                    Err(WsError::HeartbeatTimeout) => {
                        let close = CloseFrame {
                            code: CloseCode::from(HEARTBEAT_TIMEOUT_CLOSE_CODE),
                            reason: "missing to many pings".into(),
                        };
                        let _ = sink.send(Message::Close(Some(close))).await;
                        break Err(WsError::HeartbeatTimeout);
                    }
                    Err(error) => break Err(error),
                }
            }
        }
    };

    drop(input_tx);
    drop(output_rx);
    match protocol_task.await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => tracing::warn!(%error, "notification protocol stopped with an error"),
        Err(error) => tracing::warn!(%error, "notification protocol task failed"),
    }
    result
}

async fn write_frame<S>(sink: &mut S, frame: ServerFrame) -> Result<()>
where
    S: futures_util::Sink<Message> + Unpin,
    S::Error: std::fmt::Display,
{
    let message = match frame {
        ServerFrame::Message(map) => Message::text(transit::encode(&Value::Map(map))),
        ServerFrame::Ping(payload) => Message::Ping(payload.into()),
        ServerFrame::Close { code, reason } => Message::Close(Some(CloseFrame {
            code: CloseCode::from(code),
            reason: reason.into(),
        })),
    };
    sink.send(message)
        .await
        .map_err(|error| WsError::Transport(error.to_string()))
}
