//! Pool options mirroring `app.db/defaults` and `initsql`.

use std::time::Duration;

use crate::DbError;

/// Pool and session settings taken from `app.db/defaults`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DbOptions {
    /// `::db/uri`, e.g. `postgres://penpot:penpot@localhost:5433/penpot`.
    pub uri: String,
    /// `::max-size`, default 60.
    pub max_connections: u32,
    /// `::min-size`, defaults to `max_connections` like the Clojure code.
    pub min_connections: u32,
    /// `::connection-timeout`, default 30s.
    pub acquire_timeout: Duration,
    /// `::idle-timeout`, default 2min.
    pub idle_timeout: Option<Duration>,
    /// `::max-lifetime`, default 30min.
    pub max_lifetime: Option<Duration>,
    /// `SET statement_timeout`, default 300s.
    pub statement_timeout: Duration,
    /// `SET idle_in_transaction_session_timeout`, default 300s.
    pub idle_in_transaction_timeout: Duration,
    /// `::read-only`: mark every session read-only.
    pub read_only: bool,
}

impl DbOptions {
    /// Defaults from `app.db/defaults`, with the given URI.
    #[must_use]
    pub fn new(uri: impl Into<String>) -> Self {
        let max_connections = 60;
        Self {
            uri: uri.into(),
            max_connections,
            min_connections: max_connections,
            acquire_timeout: Duration::from_secs(30),
            idle_timeout: Some(Duration::from_secs(120)),
            max_lifetime: Some(Duration::from_mins(30)),
            statement_timeout: Duration::from_secs(300),
            idle_in_transaction_timeout: Duration::from_secs(300),
            read_only: false,
        }
    }

    /// Reject settings the pool would otherwise accept and misbehave on.
    pub(crate) fn validate(&self) -> Result<(), DbError> {
        if self.max_connections == 0 {
            return Err(DbError::Configuration(
                "max connections must be at least 1".to_owned(),
            ));
        }
        if self.min_connections > self.max_connections {
            return Err(DbError::Configuration(
                "min connections cannot exceed max connections".to_owned(),
            ));
        }
        if self.acquire_timeout.is_zero() {
            return Err(DbError::Configuration(
                "acquire timeout must be positive".to_owned(),
            ));
        }
        Ok(())
    }
}

impl Default for DbOptions {
    fn default() -> Self {
        Self::new(String::new())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn defaults_match_the_clojure_pool() {
        let options = DbOptions::new("postgres://localhost/penpot");
        assert_eq!(options.max_connections, 60);
        assert_eq!(options.min_connections, 60);
        assert_eq!(options.acquire_timeout, Duration::from_secs(30));
        assert_eq!(options.idle_timeout, Some(Duration::from_mins(2)));
        assert_eq!(options.max_lifetime, Some(Duration::from_mins(30)));
        assert_eq!(options.statement_timeout, Duration::from_mins(5));
        assert_eq!(options.idle_in_transaction_timeout, Duration::from_mins(5));
        assert!(!options.read_only);
    }

    #[test]
    fn impossible_sizes_are_rejected() {
        let mut options = DbOptions::new("postgres://localhost/penpot");
        options.max_connections = 0;
        assert!(matches!(options.validate(), Err(DbError::Configuration(_))));

        let mut options = DbOptions::new("postgres://localhost/penpot");
        options.min_connections = options.max_connections + 1;
        assert!(matches!(options.validate(), Err(DbError::Configuration(_))));

        let mut options = DbOptions::new("postgres://localhost/penpot");
        options.acquire_timeout = Duration::ZERO;
        assert!(matches!(options.validate(), Err(DbError::Configuration(_))));
    }
}
