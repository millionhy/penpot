//! Tenant-prefixed pub/sub with local subscription counting.

use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    sync::{Arc, Mutex, PoisonError},
};

use async_trait::async_trait;
use tokio::sync::mpsc;
use transit::{Map, Value};
use uuid::Uuid;

use crate::{Result, WsError};

/// Apply the msgbus tenant prefix exactly as `prefix-topic` does.
#[must_use]
pub fn prefix_topic(tenant: &str, topic: &str) -> String {
    format!("{tenant}.{topic}")
}

/// Identifier returned by [`RedisBus::subscribe`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct Subscription(Uuid);

impl Subscription {
    /// Stable identifier used by logs and tests.
    #[must_use]
    pub const fn id(self) -> Uuid {
        self.0
    }
}

/// Pub/sub operations used by the notification protocol.
///
/// Topics are logical ids such as a profile, file, team or organization UUID.
/// Implementations apply the `<tenant>.` prefix themselves, so callers never
/// touch Redis key formatting.
#[async_trait]
pub trait RedisBus: Send + Sync {
    /// Subscribe one local sender to a non-empty topic set.
    async fn subscribe(
        &self,
        topics: &[String],
        capacity: usize,
        sender: mpsc::Sender<Map>,
    ) -> Result<Subscription>;

    /// Remove every topic owned by a subscription. Repeated calls are no-ops.
    async fn unsubscribe(&self, subscription: Subscription) -> Result<()>;

    /// Publish a map to one logical topic.
    async fn publish(&self, topic: &str, message: Map) -> Result<()>;
}

#[derive(Debug, Default)]
struct BusState {
    topics: HashMap<String, BTreeMap<Subscription, mpsc::Sender<Map>>>,
    subscriptions: HashMap<Subscription, BTreeSet<String>>,
}

/// Offline bus with the same topic and local subscriber semantics as Redis.
#[derive(Debug, Clone)]
pub struct InMemoryBus {
    tenant: Arc<str>,
    state: Arc<Mutex<BusState>>,
}

impl InMemoryBus {
    /// Create a bus for one tenant.
    #[must_use]
    pub fn new(tenant: impl Into<String>) -> Self {
        let tenant = tenant.into();
        Self {
            tenant: Arc::from(tenant),
            state: Arc::new(Mutex::new(BusState::default())),
        }
    }

    /// Current local subscriber count for one logical topic.
    #[must_use]
    pub fn subscriber_count(&self, topic: &str) -> usize {
        self.state
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .topics
            .get(topic)
            .map_or(0, BTreeMap::len)
    }

    /// Whether a topic currently has a Redis-side subscription.
    #[must_use]
    pub fn is_open(&self, topic: &str) -> bool {
        self.subscriber_count(topic) > 0
    }

    pub(crate) fn tenant(&self) -> &str {
        &self.tenant
    }

    pub(crate) fn topics_for(&self, subscription: Subscription) -> Vec<String> {
        self.state()
            .subscriptions
            .get(&subscription)
            .map_or_else(Vec::new, |topics| topics.iter().cloned().collect())
    }

    /// Insert a local subscription and report the topics it opened.
    pub(crate) fn insert_subscription(
        &self,
        topics: &[String],
        capacity: usize,
        sender: mpsc::Sender<Map>,
    ) -> Result<(Subscription, Vec<String>)> {
        let topics: BTreeSet<_> = topics.iter().cloned().collect();
        if topics.is_empty() {
            return Err(WsError::Bus("subscription needs at least one topic".into()));
        }
        if capacity == 0 {
            return Err(WsError::Bus(
                "subscription capacity must be positive".into(),
            ));
        }

        let subscription = Subscription(Uuid::new_v4());
        let mut state = self.state();
        let opened = topics
            .iter()
            .filter(|topic| state.topics.get(*topic).is_none_or(BTreeMap::is_empty))
            .cloned()
            .collect();
        for topic in &topics {
            state
                .topics
                .entry(topic.clone())
                .or_default()
                .insert(subscription, sender.clone());
        }
        state.subscriptions.insert(subscription, topics);
        Ok((subscription, opened))
    }

    /// Deliver to the local senders and return every topic that became empty.
    pub(crate) fn deliver(&self, topic: &str, message: Map) -> Vec<String> {
        let mut state = self.state();
        let mut removed = BTreeSet::new();
        let (closed, empty) = {
            let Some(subscribers) = state.topics.get_mut(topic) else {
                return Vec::new();
            };

            let mut closed = Vec::new();
            for (subscription, sender) in subscribers.iter() {
                match sender.try_send(message.clone()) {
                    Ok(()) => {}
                    Err(mpsc::error::TrySendError::Full(_)) => {
                        tracing::warn!(
                            topic,
                            tenant = %self.tenant,
                            "dropping msgbus message for a slow subscriber"
                        );
                    }
                    Err(mpsc::error::TrySendError::Closed(_)) => closed.push(*subscription),
                }
            }
            for subscription in &closed {
                subscribers.remove(subscription);
            }
            (closed, subscribers.is_empty())
        };
        for subscription in closed {
            if let Some(topics) = state.subscriptions.remove(&subscription) {
                for topic in topics {
                    let remove_topic = state.topics.get_mut(&topic).is_some_and(|subscribers| {
                        subscribers.remove(&subscription);
                        subscribers.is_empty()
                    });
                    if remove_topic {
                        state.topics.remove(&topic);
                        removed.insert(topic);
                    }
                }
            }
        }
        if empty {
            state.topics.remove(topic);
            removed.insert(topic.to_owned());
        }
        removed.into_iter().collect()
    }

    fn state(&self) -> std::sync::MutexGuard<'_, BusState> {
        self.state.lock().unwrap_or_else(PoisonError::into_inner)
    }
}

#[async_trait]
impl RedisBus for InMemoryBus {
    async fn subscribe(
        &self,
        topics: &[String],
        capacity: usize,
        sender: mpsc::Sender<Map>,
    ) -> Result<Subscription> {
        self.insert_subscription(topics, capacity, sender)
            .map(|(subscription, _opened)| subscription)
    }

    async fn unsubscribe(&self, subscription: Subscription) -> Result<()> {
        let mut state = self.state();
        let Some(topics) = state.subscriptions.remove(&subscription) else {
            return Ok(());
        };
        for topic in topics {
            let remove_topic = if let Some(subscribers) = state.topics.get_mut(&topic) {
                subscribers.remove(&subscription);
                subscribers.is_empty()
            } else {
                false
            };
            if remove_topic {
                state.topics.remove(&topic);
            }
        }
        Ok(())
    }

    async fn publish(&self, topic: &str, mut message: Map) -> Result<()> {
        message.insert(Value::kw("topic"), Value::str(topic));
        let _ = self.deliver(topic, message);
        Ok(())
    }
}
