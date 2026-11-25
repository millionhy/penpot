//! Redis Pub/Sub adapter for the notification bus.

use std::{collections::BTreeSet, sync::Arc, time::Duration};

use async_trait::async_trait;
use futures_util::StreamExt as _;
use redis::{
    aio::{MultiplexedConnection, PubSub, PubSubSink},
    AsyncCommands as _,
};
use tokio::sync::{mpsc, oneshot};
use transit::{Map, Value};

use crate::{prefix_topic, InMemoryBus, RedisBus, Result, Subscription, WsError};

const COMMAND_CAPACITY: usize = 64;
const SUBSCRIBE_TIMEOUT: Duration = Duration::from_secs(5);
const INITIAL_BACKOFF: Duration = Duration::from_millis(100);
const MAX_BACKOFF: Duration = Duration::from_secs(5);

enum Command {
    Open {
        channel: String,
        done: oneshot::Sender<Result<()>>,
    },
    Close {
        channel: String,
        done: oneshot::Sender<Result<()>>,
    },
}

/// Redis-backed [`RedisBus`] with tenant-prefixed channels.
///
/// One multiplexed connection publishes. A separate Pub/Sub connection is
/// owned by a listener task, which reconnects with backoff and reopens every
/// channel that still has local subscribers.
pub struct RedisBusClient {
    local: Arc<InMemoryBus>,
    publish: MultiplexedConnection,
    commands: mpsc::Sender<Command>,
    tenant: Arc<str>,
}

impl RedisBusClient {
    /// Connect to `url` and scope every channel to `tenant`.
    ///
    /// # Errors
    ///
    /// Returns [`WsError::Bus`] when either the publisher or the Pub/Sub
    /// connection cannot be opened.
    pub async fn connect(url: &str, tenant: impl Into<String>) -> Result<Self> {
        let tenant = tenant.into();
        let client =
            redis::Client::open(url).map_err(|error| bus_error("open redis client", error))?;
        let publish = client
            .get_multiplexed_async_connection()
            .await
            .map_err(|error| bus_error("connect redis publisher", error))?;
        let pubsub = client
            .get_async_pubsub()
            .await
            .map_err(|error| bus_error("connect redis subscriber", error))?;
        let (commands, receiver) = mpsc::channel(COMMAND_CAPACITY);
        let local = Arc::new(InMemoryBus::new(tenant.clone()));

        tokio::spawn(run_listener(
            client,
            pubsub,
            receiver,
            Arc::clone(&local),
            tenant.clone(),
        ));

        Ok(Self {
            local,
            publish,
            commands,
            tenant: Arc::from(tenant),
        })
    }

    /// Current local subscriber count for one logical topic.
    #[must_use]
    pub fn subscriber_count(&self, topic: &str) -> usize {
        self.local.subscriber_count(topic)
    }

    async fn open_channel(&self, channel: String) -> Result<()> {
        let (done, result) = oneshot::channel();
        self.commands
            .send(Command::Open { channel, done })
            .await
            .map_err(|_| WsError::Bus("redis listener stopped".into()))?;
        wait_for_command(result).await
    }

    async fn close_channel(&self, channel: String) -> Result<()> {
        let (done, result) = oneshot::channel();
        self.commands
            .send(Command::Close { channel, done })
            .await
            .map_err(|_| WsError::Bus("redis listener stopped".into()))?;
        wait_for_command(result).await
    }
}

#[async_trait]
impl RedisBus for RedisBusClient {
    async fn subscribe(
        &self,
        topics: &[String],
        capacity: usize,
        sender: mpsc::Sender<Map>,
    ) -> Result<Subscription> {
        let (subscription, opened) = self.local.insert_subscription(topics, capacity, sender)?;
        let mut channels = Vec::with_capacity(opened.len());

        for topic in opened {
            let channel = prefix_topic(&self.tenant, &topic);
            if let Err(error) = self.open_channel(channel.clone()).await {
                let _ = self.local.unsubscribe(subscription).await;
                let _ = self.close_channel(channel).await;
                for channel in channels {
                    let _ = self.close_channel(channel).await;
                }
                return Err(error);
            }
            channels.push(channel);
        }
        Ok(subscription)
    }

    async fn unsubscribe(&self, subscription: Subscription) -> Result<()> {
        let topics = self.local.topics_for(subscription);
        self.local.unsubscribe(subscription).await?;

        for topic in topics {
            if self.local.subscriber_count(&topic) == 0 {
                self.close_channel(prefix_topic(&self.tenant, &topic))
                    .await?;
            }
        }
        Ok(())
    }

    async fn publish(&self, topic: &str, mut message: Map) -> Result<()> {
        message.insert(Value::kw("topic"), Value::str(topic));
        let payload = transit::encode(&Value::Map(message));
        let channel = prefix_topic(&self.tenant, topic);
        let mut connection = self.publish.clone();
        let _: i64 = connection
            .publish(channel, payload)
            .await
            .map_err(|error| bus_error("publish redis message", error))?;
        Ok(())
    }
}

async fn wait_for_command(result: oneshot::Receiver<Result<()>>) -> Result<()> {
    match tokio::time::timeout(SUBSCRIBE_TIMEOUT, result).await {
        Ok(Ok(result)) => result,
        Ok(Err(_)) => Err(WsError::Bus("redis listener stopped".into())),
        Err(_) => Err(WsError::Bus("redis subscription timed out".into())),
    }
}

async fn run_listener(
    client: redis::Client,
    initial: PubSub,
    mut commands: mpsc::Receiver<Command>,
    local: Arc<InMemoryBus>,
    tenant: String,
) {
    let mut next = Some(initial);
    let mut active = BTreeSet::new();
    let mut backoff = INITIAL_BACKOFF;

    loop {
        let pubsub = if let Some(pubsub) = next.take() {
            pubsub
        } else {
            tokio::time::sleep(backoff).await;
            match client.get_async_pubsub().await {
                Ok(pubsub) => pubsub,
                Err(error) => {
                    tracing::warn!(%error, "redis pub/sub reconnect failed");
                    backoff = (backoff * 2).min(MAX_BACKOFF);
                    continue;
                }
            }
        };

        match listen_once(pubsub, &mut active, &mut commands, &local, &tenant).await {
            Ok(()) => return,
            Err(error) => {
                tracing::warn!(%error, "redis pub/sub listener disconnected");
                backoff = (backoff * 2).min(MAX_BACKOFF);
            }
        }
    }
}

async fn listen_once(
    pubsub: PubSub,
    active: &mut BTreeSet<String>,
    commands: &mut mpsc::Receiver<Command>,
    local: &InMemoryBus,
    tenant: &str,
) -> std::result::Result<(), String> {
    let (mut sink, mut messages) = pubsub.split();
    for channel in active.iter() {
        sink.subscribe(channel)
            .await
            .map_err(|error| format!("resubscribe {channel}: {error}"))?;
    }

    let tenant_prefix = format!("{tenant}.");
    loop {
        tokio::select! {
            command = commands.recv() => {
                let Some(command) = command else {
                    return Ok(());
                };
                handle_command(command, &mut sink, active).await?;
            }
            message = messages.next() => {
                let Some(message) = message else {
                    return Err("pub/sub stream closed".into());
                };
                deliver(message, &mut sink, active, local, &tenant_prefix).await;
            }
        }
    }
}

async fn handle_command(
    command: Command,
    sink: &mut PubSubSink,
    active: &mut BTreeSet<String>,
) -> std::result::Result<(), String> {
    match command {
        Command::Open { channel, done } => {
            let result = sink.subscribe(&channel).await;
            match result {
                Ok(()) => {
                    active.insert(channel);
                    let _ = done.send(Ok(()));
                    Ok(())
                }
                Err(error) => {
                    let message = format!("subscribe {channel}: {error}");
                    let _ = done.send(Err(WsError::Bus(message.clone())));
                    Err(message)
                }
            }
        }
        Command::Close { channel, done } => {
            active.remove(&channel);
            match sink.unsubscribe(&channel).await {
                Ok(()) => {
                    let _ = done.send(Ok(()));
                    Ok(())
                }
                Err(error) => {
                    let message = format!("unsubscribe {channel}: {error}");
                    let _ = done.send(Err(WsError::Bus(message.clone())));
                    Err(message)
                }
            }
        }
    }
}

async fn deliver(
    message: redis::Msg,
    sink: &mut PubSubSink,
    active: &mut BTreeSet<String>,
    local: &InMemoryBus,
    tenant_prefix: &str,
) {
    let channel = match message.get_channel::<String>() {
        Ok(channel) => channel,
        Err(error) => {
            tracing::warn!(%error, "invalid redis pub/sub channel");
            return;
        }
    };
    let Some(topic) = channel.strip_prefix(tenant_prefix) else {
        tracing::warn!(%channel, "redis pub/sub channel is outside the tenant");
        return;
    };
    let payload = match message.get_payload::<String>() {
        Ok(payload) => payload,
        Err(error) => {
            tracing::warn!(%error, %channel, "invalid redis pub/sub payload");
            return;
        }
    };
    let value = match transit::decode(&payload) {
        Ok(value) => value,
        Err(error) => {
            tracing::warn!(%error, %channel, "dropping malformed msgbus payload");
            return;
        }
    };
    let (Value::Map(map) | Value::OrderedMap(map) | Value::ObjectsMap(map)) = value else {
        tracing::warn!(%channel, "dropping non-map msgbus payload");
        return;
    };

    for empty_topic in local.deliver(topic, map) {
        let closed = prefix_topic(local.tenant(), &empty_topic);
        active.remove(&closed);
        if let Err(error) = sink.unsubscribe(&closed).await {
            tracing::warn!(%error, %closed, "failed to close empty msgbus topic");
        }
    }
}

fn bus_error(context: &str, error: redis::RedisError) -> WsError {
    WsError::Bus(format!("{context}: {error}"))
}
