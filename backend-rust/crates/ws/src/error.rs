//! Errors raised by the notification bus and protocol.

/// Result type used by the `ws` crate.
pub type Result<T> = std::result::Result<T, WsError>;

/// Failure while decoding a client message, using the bus, or running a socket.
#[derive(Debug, thiserror::Error)]
pub enum WsError {
    /// A Transit message does not match the notification protocol.
    #[error("invalid websocket message: {0}")]
    InvalidMessage(String),

    /// The `session-id` query parameter is missing or malformed.
    #[error("invalid websocket session id: {0}")]
    InvalidSessionId(String),

    /// No authenticated profile is attached to the connection.
    #[error("authentication required")]
    AuthenticationRequired,

    /// The profile cannot read the requested file or team.
    #[error("access denied: {0}")]
    AccessDenied(String),

    /// Redis or the in-memory substitute failed.
    #[error("message bus: {0}")]
    Bus(String),

    /// The connection output or protocol task has stopped.
    #[error("websocket connection closed")]
    Closed,

    /// The WebSocket transport failed.
    #[error("websocket transport: {0}")]
    Transport(String),

    /// Too many pings finished without a matching pong.
    #[error("heartbeat timed out")]
    HeartbeatTimeout,
}
