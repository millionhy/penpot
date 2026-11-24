//! State machine for `/ws/notifications`.

use std::sync::Arc;

use async_trait::async_trait;
use tokio::sync::mpsc;
use transit::{Map, Value};
use uuid::Uuid;

use crate::{RedisBus, Result, Subscription, WsError};

/// The system topic shared by every notification connection.
pub const ZERO_TOPIC: &str = "00000000-0000-0000-0000-000000000000";

/// One decoded message sent by a browser.
#[derive(Debug, Clone, PartialEq)]
pub enum ClientMessage {
    /// Open a file subscription and announce `join-file`.
    SubscribeFile {
        /// File identifier.
        file_id: Uuid,
        /// Client version; currently informational, as in Clojure.
        version: Option<Value>,
    },
    /// Open a team and organization subscription.
    SubscribeTeam {
        /// Team identifier.
        team_id: Uuid,
    },
    /// Close the active file subscription and announce `leave-file`.
    UnsubscribeFile {
        /// File identifier.
        file_id: Uuid,
    },
    /// Broadcast a cursor update on the active file topic.
    PointerUpdate {
        /// File identifier from the client message.
        file_id: Uuid,
        /// Original map, including record-tagged geometry.
        message: Map,
    },
    /// Broadcast a message on the caller's profile topic.
    Broadcast {
        /// Original message map.
        message: Map,
    },
    /// Application-level no-op.
    Keepalive,
    /// A type this build does not handle.
    Unknown {
        /// Original `:type` keyword.
        message_type: String,
    },
}

/// Permission and existence checks that need PostgreSQL.
#[async_trait]
pub trait AccessControl: Send + Sync {
    /// Check team access and return the organization resolved by Nitrate.
    async fn can_subscribe_team(&self, profile_id: Uuid, team_id: Uuid) -> Result<Option<Uuid>>;

    /// Check file access, including file existence.
    async fn can_subscribe_file(&self, profile_id: Uuid, file_id: Uuid) -> Result<()>;
}

/// Offline access policy used by unit tests and DB-free local runs.
#[derive(Debug, Clone, Copy, Default)]
pub struct AllowAllAccess;

#[async_trait]
impl AccessControl for AllowAllAccess {
    async fn can_subscribe_team(&self, _profile_id: Uuid, _team_id: Uuid) -> Result<Option<Uuid>> {
        Ok(None)
    }

    async fn can_subscribe_file(&self, _profile_id: Uuid, _file_id: Uuid) -> Result<()> {
        Ok(())
    }
}

/// Frame emitted by the protocol for the WebSocket writer.
#[derive(Debug, Clone, PartialEq)]
pub enum ServerFrame {
    /// Transit map sent as a text frame.
    Message(Map),
    /// Binary heartbeat payload.
    Ping(Vec<u8>),
    /// Close the socket with a protocol code.
    Close {
        /// WebSocket close code.
        code: u16,
        /// Short close reason.
        reason: String,
    },
}

/// Protocol buffer sizes and heartbeat timing.
#[derive(Debug, Clone)]
pub struct ProtocolOptions {
    /// Profile/system subscription buffer.
    pub profile_capacity: usize,
    /// Team or file subscription buffer.
    pub scope_capacity: usize,
    /// Socket writer buffer.
    pub output_capacity: usize,
    /// Client input buffer.
    pub input_capacity: usize,
    /// Ping interval.
    pub heartbeat_interval: std::time::Duration,
    /// Missed pongs before the server closes the socket.
    pub max_missed_heartbeats: usize,
}

impl Default for ProtocolOptions {
    fn default() -> Self {
        Self {
            profile_capacity: 16,
            scope_capacity: 64,
            output_capacity: 64,
            input_capacity: 64,
            heartbeat_interval: std::time::Duration::from_secs(5),
            max_missed_heartbeats: 3,
        }
    }
}

/// Which logical channel a bus delivery came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    /// Profile plus system topic.
    Profile,
    /// Team plus optional organization topic.
    Team,
    /// File topic.
    File,
}

struct BusReceiver {
    subscription: Subscription,
    receiver: mpsc::Receiver<Map>,
}

struct ScopedReceiver {
    topic: Uuid,
    subscription: BusReceiver,
}

/// One notification connection.
pub struct Protocol {
    bus: Arc<dyn RedisBus>,
    access: Arc<dyn AccessControl>,
    profile_id: Uuid,
    session_id: Uuid,
    options: ProtocolOptions,
    profile: Option<BusReceiver>,
    team: Option<ScopedReceiver>,
    file: Option<ScopedReceiver>,
}

impl Protocol {
    /// Build a connection state machine.
    #[must_use]
    pub fn new(
        bus: Arc<dyn RedisBus>,
        access: Arc<dyn AccessControl>,
        profile_id: Uuid,
        session_id: Uuid,
        options: ProtocolOptions,
    ) -> Self {
        Self {
            bus,
            access,
            profile_id,
            session_id,
            options,
            profile: None,
            team: None,
            file: None,
        }
    }

    /// Subscribe the profile and the zero system topic.
    ///
    /// # Errors
    ///
    /// Returns a bus error if either subscription cannot be opened.
    pub async fn open(&mut self) -> Result<()> {
        if self.profile.is_some() {
            return Ok(());
        }
        self.profile = Some(
            self.subscribe(
                vec![self.profile_id.to_string(), ZERO_TOPIC.into()],
                self.options.profile_capacity,
            )
            .await?,
        );
        Ok(())
    }

    /// Decode and execute one text frame.
    ///
    /// # Errors
    ///
    /// Returns a validation, access-control, or bus error. The transport
    /// caller turns those into an error map and keeps the socket open.
    pub async fn handle_client_text(
        &mut self,
        raw: &str,
        _outbound: &mpsc::Sender<ServerFrame>,
    ) -> Result<()> {
        match decode_client_message(raw)? {
            ClientMessage::SubscribeFile { file_id, .. } => {
                self.access
                    .can_subscribe_file(self.profile_id, file_id)
                    .await?;
                let subscription = self
                    .subscribe(vec![file_id.to_string()], self.options.scope_capacity)
                    .await?;
                let previous = self.file.replace(ScopedReceiver {
                    topic: file_id,
                    subscription,
                });
                if let Some(previous) = previous {
                    self.bus
                        .unsubscribe(previous.subscription.subscription)
                        .await?;
                }
                self.bus
                    .publish(&file_id.to_string(), self.file_event("join-file", file_id))
                    .await
            }
            ClientMessage::SubscribeTeam { team_id } => {
                let organization_id = self
                    .access
                    .can_subscribe_team(self.profile_id, team_id)
                    .await?;
                let mut topics = vec![team_id.to_string()];
                if let Some(organization_id) = organization_id {
                    topics.push(organization_id.to_string());
                }
                let subscription = self.subscribe(topics, self.options.scope_capacity).await?;
                let previous = self.team.replace(ScopedReceiver {
                    topic: team_id,
                    subscription,
                });
                if let Some(previous) = previous {
                    self.bus
                        .unsubscribe(previous.subscription.subscription)
                        .await?;
                }
                Ok(())
            }
            ClientMessage::UnsubscribeFile { file_id } => {
                let matches = self
                    .file
                    .as_ref()
                    .is_some_and(|subscription| subscription.topic == file_id);
                if matches {
                    self.bus
                        .publish(&file_id.to_string(), self.file_event("leave-file", file_id))
                        .await?;
                    if let Some(subscription) = self.file.take() {
                        self.bus
                            .unsubscribe(subscription.subscription.subscription)
                            .await?;
                    }
                }
                Ok(())
            }
            ClientMessage::PointerUpdate {
                file_id,
                mut message,
            } => {
                let matches = self
                    .file
                    .as_ref()
                    .is_some_and(|subscription| subscription.topic == file_id);
                if matches {
                    add_sender_fields(&mut message, file_id, self.profile_id, self.session_id);
                    self.bus.publish(&file_id.to_string(), message).await?;
                }
                Ok(())
            }
            ClientMessage::Broadcast { mut message } => {
                add_sender_fields(
                    &mut message,
                    self.profile_id,
                    self.profile_id,
                    self.session_id,
                );
                self.bus
                    .publish(&self.profile_id.to_string(), message)
                    .await
            }
            ClientMessage::Keepalive => Ok(()),
            ClientMessage::Unknown { message_type } => {
                tracing::warn!(%message_type, "received unexpected websocket message");
                Ok(())
            }
        }
    }

    /// Process a message received on one of the connection subscriptions.
    ///
    /// # Errors
    ///
    /// Returns [`WsError::Closed`] when the writer has stopped, or a bus error
    /// while announcing presence.
    pub async fn handle_bus_message(
        &mut self,
        scope: Scope,
        message: Map,
        outbound: &mpsc::Sender<ServerFrame>,
    ) -> Result<()> {
        if is_own_session(&message, self.session_id) {
            return Ok(());
        }

        outbound
            .send(ServerFrame::Message(message.clone()))
            .await
            .map_err(|_| WsError::Closed)?;

        if scope == Scope::File
            && matches!(
                message.get_kw("type").and_then(Value::as_keyword),
                Some("join-file" | "leave-file" | "disconnect")
            )
        {
            if let Some(file) = &self.file {
                let file_id = file.topic;
                self.bus
                    .publish(&file_id.to_string(), self.file_event("presence", file_id))
                    .await?;
            }
        }
        Ok(())
    }

    /// Announce disconnect and close every local subscription.
    pub async fn shutdown(&mut self) {
        if let Some(file) = self.file.take() {
            let file_id = file.topic;
            if let Err(error) = self
                .bus
                .publish(&file_id.to_string(), self.disconnect_event())
                .await
            {
                tracing::warn!(%error, "unable to publish websocket disconnect");
            }
            if let Err(error) = self.bus.unsubscribe(file.subscription.subscription).await {
                tracing::warn!(%error, "unable to unsubscribe file topic");
            }
        }
        if let Some(team) = self.team.take() {
            if let Err(error) = self.bus.unsubscribe(team.subscription.subscription).await {
                tracing::warn!(%error, "unable to unsubscribe team topic");
            }
        }
        if let Some(profile) = self.profile.take() {
            if let Err(error) = self.bus.unsubscribe(profile.subscription).await {
                tracing::warn!(%error, "unable to unsubscribe profile topic");
            }
        }
    }

    /// Run until the socket input closes.
    ///
    /// # Errors
    ///
    /// Returns a protocol or bus error that ends the connection.
    ///
    /// # Panics
    ///
    /// Panics only if a `select!` guard is inconsistent with the receiver it
    /// protects, which the loop's assignments rule out.
    pub async fn run(
        mut self,
        mut input: mpsc::Receiver<String>,
        outbound: mpsc::Sender<ServerFrame>,
    ) -> Result<()> {
        self.open().await?;
        let result = loop {
            tokio::select! {
                message = async {
                    self.profile.as_mut().expect("guarded profile receiver").receiver.recv().await
                }, if self.profile.is_some() => {
                    match message {
                        Some(message) => {
                            if let Err(error) = self.handle_bus_message(Scope::Profile, message, &outbound).await {
                                break Err(error);
                            }
                        }
                        None => {
                            self.profile = None;
                        }
                    }
                }
                message = async {
                    self.team.as_mut().expect("guarded team receiver").subscription.receiver.recv().await
                }, if self.team.is_some() => {
                    match message {
                        Some(message) => {
                            if let Err(error) = self.handle_bus_message(Scope::Team, message, &outbound).await {
                                break Err(error);
                            }
                        }
                        None => {
                            self.team = None;
                        }
                    }
                }
                message = async {
                    self.file.as_mut().expect("guarded file receiver").subscription.receiver.recv().await
                }, if self.file.is_some() => {
                    match message {
                        Some(message) => {
                            if let Err(error) = self.handle_bus_message(Scope::File, message, &outbound).await {
                                break Err(error);
                            }
                        }
                        None => {
                            self.file = None;
                        }
                    }
                }
                raw = input.recv() => {
                    let Some(raw) = raw else { break Ok(()) };
                    match self.handle_client_text(&raw, &outbound).await {
                        Ok(()) => {}
                        Err(error) => {
                            if outbound.send(ServerFrame::Message(error_map(&error))).await.is_err() {
                                break Err(WsError::Closed);
                            }
                        }
                    }
                }
            }
        };
        self.shutdown().await;
        result
    }

    async fn subscribe(&self, topics: Vec<String>, capacity: usize) -> Result<BusReceiver> {
        let (sender, receiver) = mpsc::channel(capacity);
        let subscription = self.bus.subscribe(&topics, capacity, sender).await?;
        Ok(BusReceiver {
            subscription,
            receiver,
        })
    }

    fn file_event(&self, message_type: &str, file_id: Uuid) -> Map {
        Map::from_iter([
            (Value::kw("type"), Value::kw(message_type)),
            (Value::kw("file-id"), Value::Uuid(file_id)),
            (Value::kw("session-id"), Value::Uuid(self.session_id)),
            (Value::kw("profile-id"), Value::Uuid(self.profile_id)),
        ])
    }

    fn disconnect_event(&self) -> Map {
        Map::from_iter([
            (Value::kw("type"), Value::kw("disconnect")),
            (Value::kw("session-id"), Value::Uuid(self.session_id)),
            (Value::kw("profile-id"), Value::Uuid(self.profile_id)),
        ])
    }
}

/// Decode the Transit map sent by `notifications.cljs`.
///
/// # Errors
///
/// Returns [`WsError::InvalidMessage`] for malformed Transit, a non-map value,
/// a missing keyword `type`, or a required id that is not a Transit UUID.
pub fn decode_client_message(raw: &str) -> Result<ClientMessage> {
    let value = transit::decode(raw)
        .map_err(|error| WsError::InvalidMessage(format!("invalid transit: {error}")))?;
    let Value::Map(message) = value else {
        return Err(WsError::InvalidMessage("expected a map".into()));
    };
    let message_type = message
        .get_kw("type")
        .and_then(Value::as_keyword)
        .ok_or_else(|| WsError::InvalidMessage("missing keyword `type`".into()))?;

    match message_type {
        "subscribe-file" => Ok(ClientMessage::SubscribeFile {
            file_id: required_uuid(&message, "file-id")?,
            version: message.get_kw("version").cloned(),
        }),
        "subscribe-team" => Ok(ClientMessage::SubscribeTeam {
            team_id: required_uuid(&message, "team-id")?,
        }),
        "unsubscribe-file" => Ok(ClientMessage::UnsubscribeFile {
            file_id: required_uuid(&message, "file-id")?,
        }),
        "pointer-update" => Ok(ClientMessage::PointerUpdate {
            file_id: required_uuid(&message, "file-id")?,
            message,
        }),
        "broadcast" => Ok(ClientMessage::Broadcast { message }),
        "keepalive" => Ok(ClientMessage::Keepalive),
        other => Ok(ClientMessage::Unknown {
            message_type: other.to_owned(),
        }),
    }
}

fn required_uuid(message: &Map, name: &str) -> Result<Uuid> {
    message
        .get_kw(name)
        .and_then(Value::as_uuid)
        .ok_or_else(|| WsError::InvalidMessage(format!("missing uuid `{name}`")))
}

fn add_sender_fields(message: &mut Map, topic: Uuid, profile_id: Uuid, session_id: Uuid) {
    message.insert(Value::kw("subs-id"), Value::Uuid(topic));
    message.insert(Value::kw("profile-id"), Value::Uuid(profile_id));
    message.insert(Value::kw("session-id"), Value::Uuid(session_id));
}

fn is_own_session(message: &Map, session_id: Uuid) -> bool {
    match message.get_kw("session-id") {
        Some(Value::Uuid(value)) => *value == session_id,
        Some(Value::Str(value)) => value.parse::<Uuid>().is_ok_and(|value| value == session_id),
        _ => false,
    }
}

fn error_map(error: &WsError) -> Map {
    let (kind, code, hint) = match error {
        WsError::InvalidMessage(message) => ("validation", "params-validation", message.clone()),
        WsError::InvalidSessionId(message) => ("validation", "missing-session-id", message.clone()),
        WsError::AuthenticationRequired => (
            "authentication",
            "authentication-required",
            "authentication required".into(),
        ),
        WsError::AccessDenied(message) => ("authorization", "access-denied", message.clone()),
        _ => ("internal", "unexpected", "unexpected error".into()),
    };
    let detail = Map::from_iter([
        (Value::kw("type"), Value::kw(kind)),
        (Value::kw("code"), Value::kw(code)),
        (Value::kw("hint"), Value::str(hint)),
    ]);
    Map::from_iter([
        (Value::kw("type"), Value::kw("error")),
        (Value::kw("error"), Value::Map(detail)),
    ])
}
