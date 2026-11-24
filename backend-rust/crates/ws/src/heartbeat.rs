//! Ping/pong bookkeeping for the notification socket.

use std::collections::BTreeSet;

use crate::{Result, WsError};

/// Close code used by the Clojure listener when pongs stop arriving.
pub const HEARTBEAT_TIMEOUT_CLOSE_CODE: u16 = 8802;

/// Tracks the sequence numbers of pings that are still waiting for a pong.
#[derive(Debug, Clone)]
pub struct Heartbeat {
    max_missed: usize,
    next_sequence: i64,
    outstanding: BTreeSet<i64>,
}

impl Heartbeat {
    /// Create a tracker that allows at most `max_missed` unanswered pings.
    #[must_use]
    pub const fn new(max_missed: usize) -> Self {
        Self {
            max_missed,
            next_sequence: 0,
            outstanding: BTreeSet::new(),
        }
    }

    /// Reserve the next eight-byte, big-endian ping payload.
    ///
    /// # Errors
    ///
    /// Returns [`WsError::HeartbeatTimeout`] when the number of unanswered
    /// pings has already reached the configured limit.
    pub fn next_ping(&mut self) -> Result<[u8; 8]> {
        if self.outstanding.len() >= self.max_missed {
            return Err(WsError::HeartbeatTimeout);
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        self.outstanding.insert(sequence);
        Ok(sequence.to_be_bytes())
    }

    /// Match a pong against the outstanding pings.
    #[must_use]
    pub fn on_pong(&mut self, payload: &[u8]) -> bool {
        let Ok(bytes) = <[u8; 8]>::try_from(payload) else {
            return false;
        };
        self.outstanding.remove(&i64::from_be_bytes(bytes))
    }

    /// Number of pings that still lack a pong.
    #[must_use]
    pub fn outstanding(&self) -> usize {
        self.outstanding.len()
    }
}
