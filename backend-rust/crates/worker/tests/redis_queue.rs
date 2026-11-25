use std::{sync::Arc, time::Duration};

use redis::AsyncCommands as _;
use uuid::Uuid;
use worker::{RedisTaskQueue, TaskQueue, WorkerError};

fn redis_url() -> String {
    std::env::var("PENPOT_TEST_REDIS_URL").unwrap_or_else(|_| "redis://127.0.0.1:6379/15".into())
}

fn queue_key() -> String {
    format!("penpot.worker.queue:worker-test:{}", Uuid::new_v4())
}

async fn redis() -> redis::aio::MultiplexedConnection {
    redis::Client::open(redis_url())
        .expect("redis url")
        .get_multiplexed_async_connection()
        .await
        .expect("redis connection")
}

async fn cleanup(key: &str) {
    let mut connection = redis().await;
    let _: i64 = connection.del(key).await.expect("delete queue");
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn push_then_pop_preserves_fifo_order() {
    let queue = RedisTaskQueue::connect(&redis_url())
        .await
        .expect("connect");
    let key = queue_key();
    queue
        .push(&key, vec!["first".into(), "second".into(), "third".into()])
        .await
        .expect("push");

    for expected in ["first", "second", "third"] {
        let payload = queue
            .pop(&key, Duration::from_millis(100))
            .await
            .expect("pop")
            .expect("payload");
        assert_eq!(payload, expected);
    }
    cleanup(&key).await;
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn pop_returns_none_after_the_timeout() {
    let queue = RedisTaskQueue::connect(&redis_url())
        .await
        .expect("connect");
    let key = queue_key();
    let payload = queue
        .pop(&key, Duration::from_millis(100))
        .await
        .expect("pop");
    assert!(payload.is_none());
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn a_blocked_pop_does_not_block_push() {
    let queue = Arc::new(
        RedisTaskQueue::connect(&redis_url())
            .await
            .expect("connect"),
    );
    let key = queue_key();
    let waiting = tokio::spawn({
        let queue = Arc::clone(&queue);
        let key = key.clone();
        async move { queue.pop(&key, Duration::from_secs(2)).await }
    });

    tokio::time::sleep(Duration::from_millis(50)).await;
    queue.push(&key, vec!["one".into()]).await.expect("push");
    let payload = waiting
        .await
        .expect("waiting task")
        .expect("waiting pop")
        .expect("payload");

    assert_eq!(payload, "one");
    cleanup(&key).await;
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn parallel_pops_share_the_list() {
    let queue = Arc::new(
        RedisTaskQueue::connect(&redis_url())
            .await
            .expect("connect"),
    );
    let key = queue_key();
    queue
        .push(&key, vec!["one".into(), "two".into()])
        .await
        .expect("push");

    let first = tokio::spawn({
        let queue = Arc::clone(&queue);
        let key = key.clone();
        async move { queue.pop(&key, Duration::from_secs(2)).await }
    });
    let second = tokio::spawn({
        let queue = Arc::clone(&queue);
        let key = key.clone();
        async move { queue.pop(&key, Duration::from_secs(2)).await }
    });
    let first = first
        .await
        .expect("first task")
        .expect("first pop")
        .expect("first payload");
    let second = second
        .await
        .expect("second task")
        .expect("second pop")
        .expect("second payload");

    let mut payloads = [first, second];
    payloads.sort();
    assert_eq!(payloads, ["one", "two"]);
    cleanup(&key).await;
}

#[tokio::test]
#[ignore = "requires PENPOT_TEST_REDIS_URL"]
async fn pushed_payloads_are_one_redis_list_append() {
    let queue = RedisTaskQueue::connect(&redis_url())
        .await
        .expect("connect");
    let key = queue_key();
    queue
        .push(&key, vec!["alpha".into(), "beta".into()])
        .await
        .expect("push");

    let mut connection = redis().await;
    let stored: Vec<String> = connection.lrange(&key, 0, -1).await.expect("lrange");
    assert_eq!(stored, ["alpha", "beta"]);
    cleanup(&key).await;
}

#[tokio::test]
async fn invalid_uri_is_a_queue_error() {
    let error = RedisTaskQueue::connect("not-a-redis-uri")
        .await
        .err()
        .expect("invalid uri");
    assert!(matches!(error, WorkerError::Queue(_)));
}
