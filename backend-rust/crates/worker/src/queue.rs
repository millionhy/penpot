//! Redis list adapter for the worker queue.

use std::time::Duration;

use async_trait::async_trait;
use redis::aio::MultiplexedConnection;
use tokio::sync::Mutex;

use crate::{Result, TaskQueue, WorkerError};

/// Redis-backed [`TaskQueue`] using `RPUSH` and `BLPOP`.
///
/// Publishing uses its own multiplexed connection. Blocking pops take a
/// dedicated connection from a small reusable pool so parallel runners do not
/// serialize behind one `BLPOP`.
pub struct RedisTaskQueue {
    client: redis::Client,
    publish: MultiplexedConnection,
    pops: Mutex<Vec<MultiplexedConnection>>,
}

impl RedisTaskQueue {
    /// Connect to a Redis URI.
    ///
    /// # Errors
    ///
    /// Returns [`WorkerError::Queue`] when the URI or publisher connection is
    /// invalid.
    pub async fn connect(url: &str) -> Result<Self> {
        let client = redis::Client::open(url).map_err(WorkerError::queue)?;
        let publish = client
            .get_multiplexed_async_connection()
            .await
            .map_err(WorkerError::queue)?;
        Ok(Self {
            client,
            publish,
            pops: Mutex::new(Vec::new()),
        })
    }

    async fn pop_connection(&self) -> Result<MultiplexedConnection> {
        if let Some(connection) = self.pops.lock().await.pop() {
            return Ok(connection);
        }
        self.client
            .get_multiplexed_async_connection()
            .await
            .map_err(WorkerError::queue)
    }

    async fn release(&self, connection: MultiplexedConnection) {
        self.pops.lock().await.push(connection);
    }
}

#[async_trait]
impl TaskQueue for RedisTaskQueue {
    async fn push(&self, queue: &str, payloads: Vec<String>) -> Result<()> {
        if payloads.is_empty() {
            return Ok(());
        }
        let mut connection = self.publish.clone();
        redis::cmd("RPUSH")
            .arg(queue)
            .arg(payloads)
            .query_async::<i64>(&mut connection)
            .await
            .map_err(WorkerError::queue)?;
        Ok(())
    }

    async fn pop(&self, queue: &str, timeout: Duration) -> Result<Option<String>> {
        let mut connection = self.pop_connection().await?;
        let result = redis::cmd("BLPOP")
            .arg(queue)
            .arg(timeout.as_secs_f64())
            .query_async::<Option<(String, String)>>(&mut connection)
            .await;

        match result {
            Ok(value) => {
                self.release(connection).await;
                Ok(value.map(|(_key, payload)| payload))
            }
            Err(error) => Err(WorkerError::queue(error)),
        }
    }
}
