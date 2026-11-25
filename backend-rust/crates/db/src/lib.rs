//! PostgreSQL access for the Rust backend.
//!
//! This is the foundation the later repository work needs and the first
//! crate that touches `sqlx`. It mirrors the parts of `backend/src/app/db.clj`
//! and `backend/src/app/db/sql.clj` that are independent of a live database:
//!
//! * [`DbOptions`] carries the Hikari defaults (60 connections, 30s acquire
//!   timeout, 2min idle, 30min lifetime) plus the two session timeouts
//!   `app.db/initsql` sets on every connection.
//! * [`Database::connect`] builds a lazy pool, so constructing it does not
//!   open a socket. The first query does.
//! * [`table_name`] and [`snake_case`] apply `app.db.sql`'s `:table-fn` /
//!   `:column-fn` rule: replace `-` with `_`.
//! * [`DbError`] maps `sqlx` failures onto the `errors` crate's
//!   [`Cause`](errors::Cause), so callers keep the Clojure status mapping
//!   (57014 and 25P03 become 504, other SQLSTATEs become 500).
//!
//! Queries use the runtime API (`sqlx::query`), never the `query!` macro, so
//! the build needs neither a live database nor a `.sqlx` cache. TLS is off:
//! the pool talks to the local devenv container.
//!
//! ```no_run
//! use db::{Database, DbOptions};
//!
//! # async fn example() -> Result<(), errors::Cause> {
//! let database = Database::connect(DbOptions::new("postgres://penpot@localhost/penpot"))
//!     .map_err(errors::Cause::from)?;
//! let mut tx = database.begin().await?;
//! sqlx::query("SELECT 1").execute(&mut *tx).await.map_err(db::map_sqlx)?;
//! tx.commit().await.map_err(db::map_sqlx)?;
//! # Ok(())
//! # }
//! ```

mod error;
mod ident;
mod options;
mod pool;

pub use error::{map_sqlx, DbError};
pub use ident::{kebab_case, snake_case, table_name};
pub use options::DbOptions;
pub use pool::Database;
pub use sqlx;
pub use sqlx::{PgPool, Postgres, Transaction};
