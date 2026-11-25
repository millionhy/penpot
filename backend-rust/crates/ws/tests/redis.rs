use std::time::Duration;

use redis::AsyncCommands as _;
use tokio::sync::mpsc;
use transit::{Map, Value};
use uuid::Uuid;
use ws::{prefix_topic, RedisBus, RedisBusClient};

fn redis_url() -> String {
    std::env::var("PENPOT_TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/15".into())
}

async fn client_with_tenant(tenant: String) -> RedisBusClient {
    RedisBusClient::connect(&redis_url(), tenant)
        .await
        .expect("connect to redis")
}

async fn client() -> RedisBusClient {
    client_with_tenant(format!("ws-test-{}", Uuid::new_v4())).await
}

async fn publisher() -> redis::aio::MultiplexedConnection {
    redis::Client::open(redis_url())
        .expect("redis url")
        .get_multiplexed_async_connection()
        .await
        .expect("redis publisher")
}

fn message(kind: &str) -> Map {
    Map::from_iter([(Value::kw("type"), Value::kw(kind))])
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn publish_round_trips_through_redis() {
    let bus = client().await;
    let topic = format!("file-{}", Uuid::new_v4());
    let (sender, mut receiver) = mpsc::channel(8);
    let _subscription = bus
        .subscribe(std::slice::from_ref(&topic), 8, sender)
        .await
        .expect("subscribe");

    bus.publish(&topic, message("join-file"))
        .await
        .expect("publish");

    let delivery = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("delivery timeout")
        .expect("message");
    assert_eq!(delivery.get_kw("type"), Some(&Value::kw("join-file")));
    assert_eq!(delivery.get_kw("topic"), Some(&Value::str(topic)));
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn one_publish_reaches_every_local_subscriber_once() {
    let bus = client().await;
    let topic = format!("file-{}", Uuid::new_v4());
    let (first_tx, mut first_rx) = mpsc::channel(8);
    let (second_tx, mut second_rx) = mpsc::channel(8);
    let _first = bus
        .subscribe(std::slice::from_ref(&topic), 8, first_tx)
        .await
        .expect("first");
    let _second = bus
        .subscribe(std::slice::from_ref(&topic), 8, second_tx)
        .await
        .expect("second");

    bus.publish(&topic, message("pointer-update"))
        .await
        .expect("publish");

    for receiver in [&mut first_rx, &mut second_rx] {
        let delivery = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
            .await
            .expect("delivery timeout")
            .expect("message");
        assert_eq!(delivery.get_kw("type"), Some(&Value::kw("pointer-update")));
        assert!(receiver.try_recv().is_err());
    }
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn local_subscribers_share_one_redis_channel() {
    let tenant = format!("ws-test-{}", Uuid::new_v4());
    let bus = client_with_tenant(tenant.clone()).await;
    let topic = format!("file-{}", Uuid::new_v4());
    let channel = prefix_topic(&tenant, &topic);
    let mut connection = publisher().await;

    let (first_tx, _first_rx) = mpsc::channel(8);
    let first = bus
        .subscribe(std::slice::from_ref(&topic), 8, first_tx)
        .await
        .expect("first");
    assert_eq!(redis_subscribers(&mut connection, &channel).await, 1);

    let (second_tx, _second_rx) = mpsc::channel(8);
    let second = bus
        .subscribe(std::slice::from_ref(&topic), 8, second_tx)
        .await
        .expect("second");
    assert_eq!(redis_subscribers(&mut connection, &channel).await, 1);

    bus.unsubscribe(first).await.expect("remove first");
    assert_eq!(redis_subscribers(&mut connection, &channel).await, 1);
    bus.unsubscribe(second).await.expect("remove second");
    assert_eq!(redis_subscribers(&mut connection, &channel).await, 0);
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn remote_publisher_reaches_a_local_subscriber() {
    let tenant = format!("ws-test-{}", Uuid::new_v4());
    let bus = client_with_tenant(tenant.clone()).await;
    let topic = format!("team-{}", Uuid::new_v4());
    let (sender, mut receiver) = mpsc::channel(8);
    let _subscription = bus
        .subscribe(std::slice::from_ref(&topic), 8, sender)
        .await
        .expect("subscribe");

    let payload = transit::encode(&Value::Map(Map::from_iter([
        (Value::kw("type"), Value::kw("presence")),
        (Value::kw("topic"), Value::str(topic.clone())),
    ])));
    let mut connection = publisher().await;
    let _: i64 = connection
        .publish(prefix_topic(&tenant, &topic), payload)
        .await
        .expect("remote publish");

    let delivery = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("delivery timeout")
        .expect("message");
    assert_eq!(delivery.get_kw("type"), Some(&Value::kw("presence")));
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn malformed_payload_does_not_stop_the_listener() {
    let tenant = format!("ws-test-{}", Uuid::new_v4());
    let bus = client_with_tenant(tenant.clone()).await;
    let topic = format!("file-{}", Uuid::new_v4());
    let (sender, mut receiver) = mpsc::channel(8);
    let _subscription = bus
        .subscribe(std::slice::from_ref(&topic), 8, sender)
        .await
        .expect("subscribe");

    let mut connection = publisher().await;
    let _: i64 = connection
        .publish(prefix_topic(&tenant, &topic), "not transit")
        .await
        .expect("malformed publish");
    bus.publish(&topic, message("join-file"))
        .await
        .expect("valid publish");

    let delivery = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("delivery timeout")
        .expect("message");
    assert_eq!(delivery.get_kw("type"), Some(&Value::kw("join-file")));
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn tenant_prefix_isolates_the_same_logical_topic() {
    let suffix = Uuid::new_v4();
    let first = client_with_tenant(format!("ws-test-a-{suffix}")).await;
    let second = client_with_tenant(format!("ws-test-b-{suffix}")).await;
    let topic = format!("team-{suffix}");
    let (sender, mut receiver) = mpsc::channel(8);
    let _subscription = first
        .subscribe(std::slice::from_ref(&topic), 8, sender)
        .await
        .expect("subscribe");

    second
        .publish(&topic, message("broadcast"))
        .await
        .expect("publish other tenant");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), receiver.recv())
            .await
            .is_err()
    );

    first
        .publish(&topic, message("broadcast"))
        .await
        .expect("publish same tenant");
    let delivery = tokio::time::timeout(Duration::from_secs(2), receiver.recv())
        .await
        .expect("delivery timeout")
        .expect("message");
    assert_eq!(delivery.get_kw("type"), Some(&Value::kw("broadcast")));
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn unsubscribe_closes_the_topic_and_a_new_subscribe_reopens_it() {
    let bus = client().await;
    let topic = format!("file-{}", Uuid::new_v4());
    let (first_tx, mut first_rx) = mpsc::channel(8);
    let first = bus
        .subscribe(std::slice::from_ref(&topic), 8, first_tx)
        .await
        .expect("subscribe");

    bus.unsubscribe(first).await.expect("unsubscribe");
    assert_eq!(bus.subscriber_count(&topic), 0);
    bus.publish(&topic, message("leave-file"))
        .await
        .expect("publish after close");
    let after_close = tokio::time::timeout(Duration::from_millis(300), first_rx.recv()).await;
    assert!(!matches!(after_close, Ok(Some(_))));

    let (second_tx, mut second_rx) = mpsc::channel(8);
    let _second = bus
        .subscribe(std::slice::from_ref(&topic), 8, second_tx)
        .await
        .expect("resubscribe");
    bus.publish(&topic, message("join-file"))
        .await
        .expect("publish after reopen");
    let delivery = tokio::time::timeout(Duration::from_secs(2), second_rx.recv())
        .await
        .expect("delivery timeout")
        .expect("message");
    assert_eq!(delivery.get_kw("type"), Some(&Value::kw("join-file")));
}

async fn redis_subscribers(
    connection: &mut redis::aio::MultiplexedConnection,
    channel: &str,
) -> i64 {
    redis::cmd("PUBSUB")
        .arg("NUMSUB")
        .arg(channel)
        .query_async::<(String, i64)>(connection)
        .await
        .expect("PUBSUB NUMSUB")
        .1
}
