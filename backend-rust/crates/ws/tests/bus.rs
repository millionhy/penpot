use std::time::Duration;

use tokio::sync::mpsc;
use transit::{Map, Value};
use ws::{prefix_topic, InMemoryBus, RedisBus};

fn message(kind: &str) -> Map {
    Map::from_iter([(Value::kw("type"), Value::kw(kind))])
}

#[test]
fn topics_keep_the_tenant_dot_prefix() {
    assert_eq!(prefix_topic("acme", "file-1"), "acme.file-1");
}

#[tokio::test]
async fn first_subscription_opens_once_and_the_last_removes_the_topic() {
    let bus = InMemoryBus::new("acme");
    let (first_tx, _first_rx) = mpsc::channel(4);

    let first = bus
        .subscribe(&["file-1".into()], 4, first_tx)
        .await
        .expect("subscribe");
    assert_eq!(bus.subscriber_count("file-1"), 1);

    let (second_tx, _second_rx) = mpsc::channel(4);
    let second = bus
        .subscribe(&["file-1".into()], 4, second_tx)
        .await
        .expect("subscribe");
    assert_eq!(bus.subscriber_count("file-1"), 2);

    bus.unsubscribe(first).await.expect("unsubscribe");
    assert_eq!(bus.subscriber_count("file-1"), 1);
    bus.unsubscribe(second).await.expect("unsubscribe");
    assert_eq!(bus.subscriber_count("file-1"), 0);
}

#[tokio::test]
async fn unsubscribe_is_idempotent() {
    let bus = InMemoryBus::new("acme");
    let (tx, _rx) = mpsc::channel(4);
    let subscription = bus
        .subscribe(&["team-1".into()], 4, tx)
        .await
        .expect("subscribe");

    bus.unsubscribe(subscription).await.expect("first");
    bus.unsubscribe(subscription).await.expect("second");
    assert_eq!(bus.subscriber_count("team-1"), 0);
}

#[tokio::test]
async fn publish_adds_the_logical_topic_and_reaches_only_subscribers() {
    let bus = InMemoryBus::new("acme");
    let (subscribed_tx, mut subscribed_rx) = mpsc::channel(4);
    let (other_tx, mut other_rx) = mpsc::channel(4);
    let _subscribed = bus
        .subscribe(&["file-1".into()], 4, subscribed_tx)
        .await
        .expect("subscribe");
    let _other = bus
        .subscribe(&["file-2".into()], 4, other_tx)
        .await
        .expect("subscribe");

    bus.publish("file-1", message("join-file"))
        .await
        .expect("publish");

    let received = tokio::time::timeout(Duration::from_secs(1), subscribed_rx.recv())
        .await
        .expect("delivery timeout")
        .expect("message");
    assert_eq!(received.get_kw("type"), Some(&Value::kw("join-file")));
    assert_eq!(received.get_kw("topic"), Some(&Value::str("file-1")));
    assert!(other_rx.try_recv().is_err());
}

#[tokio::test]
async fn one_publish_reaches_every_local_subscriber() {
    let bus = InMemoryBus::new("acme");
    let (first_tx, mut first_rx) = mpsc::channel(4);
    let (second_tx, mut second_rx) = mpsc::channel(4);
    let _first = bus
        .subscribe(&["team-1".into()], 4, first_tx)
        .await
        .expect("subscribe");
    let _second = bus
        .subscribe(&["team-1".into()], 4, second_tx)
        .await
        .expect("subscribe");

    bus.publish("team-1", message("team-update"))
        .await
        .expect("publish");

    for receiver in [&mut first_rx, &mut second_rx] {
        let received = tokio::time::timeout(Duration::from_secs(1), receiver.recv())
            .await
            .expect("delivery timeout")
            .expect("message");
        assert_eq!(received.get_kw("type"), Some(&Value::kw("team-update")));
    }
}

#[tokio::test]
async fn publish_drops_a_closed_subscriber_and_frees_the_count() {
    let bus = InMemoryBus::new("acme");
    let (tx, rx) = mpsc::channel(4);
    let subscription = bus
        .subscribe(&["file-1".into()], 4, tx)
        .await
        .expect("subscribe");
    drop(rx);

    bus.publish("file-1", message("ping"))
        .await
        .expect("publish");
    assert_eq!(bus.subscriber_count("file-1"), 0);

    bus.unsubscribe(subscription).await.expect("unsubscribe");
}

#[tokio::test]
async fn subscribe_rejects_an_empty_topic_set() {
    let bus = InMemoryBus::new("acme");
    let (tx, _rx) = mpsc::channel(1);
    assert!(bus.subscribe(&[], 1, tx).await.is_err());
}
