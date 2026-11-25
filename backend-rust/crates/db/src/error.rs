//! `sqlx` failures mapped onto the `errors` crate.

use errors::Cause;

/// A database failure before it reaches the HTTP error handler.
#[derive(Debug, thiserror::Error)]
pub enum DbError {
    /// Settings that can never form a usable pool.
    #[error("invalid database configuration: {0}")]
    Configuration(String),
    /// A `sqlx` error: bad URL, connect failure, timeout, or server error.
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
}

impl From<DbError> for Cause {
    fn from(error: DbError) -> Self {
        match error {
            DbError::Configuration(message) => Cause::other(message),
            DbError::Sqlx(error) => map_sqlx(error),
        }
    }
}

/// `errors/handle-exception` for a `sqlx` error.
///
/// A server error keeps its SQLSTATE so the `errors` crate can pick the right
/// status (57014 and 25P03 are 504, everything else 500). Transport and pool
/// failures have no SQLSTATE and become generic 500s.
#[must_use]
pub fn map_sqlx(error: sqlx::Error) -> Cause {
    match error {
        sqlx::Error::Database(database) => Cause::postgres(
            database
                .code()
                .map_or_else(String::new, |code| code.to_string()),
        ),
        sqlx::Error::Io(error) => Cause::io(error.to_string()),
        sqlx::Error::PoolTimedOut => Cause::io("database pool acquire timed out"),
        sqlx::Error::PoolClosed => Cause::io("database pool is closed"),
        other => Cause::other(other.to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sqlstate(cause: &Cause) -> Option<&str> {
        match cause {
            Cause::Postgres { sqlstate } => Some(sqlstate),
            _ => None,
        }
    }

    #[test]
    fn transport_and_pool_failures_become_io_causes() {
        assert!(matches!(
            map_sqlx(sqlx::Error::PoolTimedOut),
            Cause::Io { .. }
        ));
        assert!(matches!(
            map_sqlx(sqlx::Error::PoolClosed),
            Cause::Io { .. }
        ));
        let io = std::io::Error::new(std::io::ErrorKind::ConnectionRefused, "refused");
        assert!(matches!(map_sqlx(sqlx::Error::Io(io)), Cause::Io { .. }));
    }

    #[test]
    fn configuration_errors_do_not_claim_a_sqlstate() {
        let cause = Cause::from(DbError::Configuration("bad settings".to_owned()));
        assert!(matches!(cause, Cause::Other { .. }));
        assert_eq!(sqlstate(&cause), None);
    }

    #[test]
    fn protocol_errors_become_generic_causes() {
        let cause = map_sqlx(sqlx::Error::Protocol("unexpected frame".to_owned()));
        assert!(matches!(cause, Cause::Other { .. }));
    }
}
