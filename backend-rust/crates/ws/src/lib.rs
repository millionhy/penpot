//! Penpot notification WebSocket boundary, milestone M7 of `backend-rust/PLAN.md`.

mod bus;
mod error;
mod heartbeat;
mod protocol;
mod redis;
mod server;

pub use bus::{prefix_topic, InMemoryBus, RedisBus, Subscription};
pub use error::{Result, WsError};
pub use heartbeat::{Heartbeat, HEARTBEAT_TIMEOUT_CLOSE_CODE};
pub use protocol::{
    decode_client_message, AccessControl, AllowAllAccess, ClientMessage, Protocol, ProtocolOptions,
    Scope, ServerFrame, ZERO_TOPIC,
};
pub use redis::RedisBusClient;
pub use server::{build_router, websocket_accept_key, FixedIdentity, WebSocketAuth, WsState};
