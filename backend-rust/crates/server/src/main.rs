//! Runnable Rust backend for the M18 login vertical slice.
//!
//! It wires the generic RPC router to PostgreSQL, reads the same token secret
//! and cookie settings as the Clojure backend, and serves on port 6061 by
//! default.

use std::collections::BTreeSet;
use std::error::Error;
use std::io::{Error as IoError, ErrorKind};
use std::net::SocketAddr;
use std::sync::Arc;

use config::Config;
use db::{Database, DbOptions};
use pg::{PgDashboardStore, PgProfileStore, PgSessionCreator, PgSessionStore};
use rpc::commands::auth::AuthCommands;
use rpc::commands::dashboard::DashboardCommands;
use rpc::{
    build_router, context_snapshot, AppState, AuthOptions, Command, CommandResult, Options,
    Registry, TokenResolver,
};
use session::{CookiePolicy, Token};
use transit::Value;

const DEFAULT_ADDR: &str = "127.0.0.1:6061";

#[tokio::main]
async fn main() {
    if let Err(error) = run().await {
        eprintln!("backend-rust: {error}");
        std::process::exit(1);
    }
}

async fn run() -> Result<(), Box<dyn Error>> {
    let config = Config::from_process_env()?;
    let secret = config
        .secret_key()
        .filter(|secret| !secret.is_empty())
        .ok_or_else(|| missing("PENPOT_SECRET_KEY"))?;
    let database_uri = config
        .database_uri()
        .ok_or_else(|| missing("PENPOT_DATABASE_URI"))?;

    let database = Database::connect(DbOptions::new(database_uri))?;
    db::sqlx::query("SELECT 1").execute(database.pool()).await?;

    let token = Token::new(secret)?;
    let cookie = cookie_policy(&config);
    let flags = config.flags();
    let admins: BTreeSet<String> = config
        .admins()
        .into_iter()
        .flatten()
        .map(|email| email.trim().to_lowercase())
        .filter(|email| !email.is_empty())
        .collect();

    let mut registry = Registry::new();
    registry.register(
        Command::new("get-health", |_| {
            Box::pin(async {
                Ok(CommandResult::ok(Value::map([
                    (Value::kw("status"), Value::kw("ok")),
                    (Value::kw("service"), Value::str("penpot-rpc")),
                ])))
            })
        })
        .public(),
    );
    registry.register(
        Command::new("get-echo", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .public(),
    );

    AuthCommands {
        profiles: Arc::new(PgProfileStore::new(database.clone())),
        sessions: Arc::new(PgSessionCreator::new(database.clone())),
        token: token.clone(),
        cookie: cookie.clone(),
        admins,
        login_enabled: flags.contains("login") || flags.contains("login-with-password"),
    }
    .register(&mut registry);

    DashboardCommands {
        store: Arc::new(PgDashboardStore::new(database.clone())),
    }
    .register(&mut registry);

    let resolver = TokenResolver::new(token, Arc::new(PgSessionStore::new(database.clone())))
        .with_options(AuthOptions {
            cookie_name: cookie.name.clone(),
            idle_max_age: cookie.max_age,
        });
    let options = Options {
        client_header_check: flags.contains("client-header-check-middleware"),
        transit_readable: flags.contains("transit-readable-response"),
        ..Options::default()
    };

    let state = AppState::new(registry)
        .with_resolver(Arc::new(resolver))
        .with_public_uri(config.public_uri())
        .with_options(options);
    let app = build_router(state);

    let addr: SocketAddr = std::env::var("PENPOT_RUST_HTTP_ADDR")
        .unwrap_or_else(|_| DEFAULT_ADDR.to_owned())
        .parse()
        .map_err(|error| {
            IoError::new(
                ErrorKind::InvalidInput,
                format!("invalid PENPOT_RUST_HTTP_ADDR: {error}"),
            )
        })?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    println!("backend-rust listening on http://{addr}");
    println!("  GET  /api/rpc/command/get-health");
    println!("  GET  /api/main/methods/get-profile");
    println!("  GET  /api/main/methods/get-teams");
    println!("  GET  /api/main/methods/get-projects");
    println!("  POST /api/main/methods/login-with-password");

    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    tokio::select! {
        result = axum::serve(listener, service) => result?,
        _ = tokio::signal::ctrl_c() => {}
    }

    database.close().await;
    Ok(())
}

fn cookie_policy(config: &Config) -> CookiePolicy {
    let mut cookie = CookiePolicy {
        name: config.auth_token_cookie_name().to_owned(),
        ..CookiePolicy::default()
    };
    if let Some(max_age) = config.auth_token_cookie_max_age() {
        cookie.max_age = max_age;
    }
    if let Some(max_age) = config.auth_token_cookie_max_age_absolute() {
        cookie.absolute_max_age = max_age;
    }
    cookie.secure = config.flags().contains("secure-session-cookies");
    cookie.strict = config.flags().contains("strict-session-cookies");
    cookie.cors = config.flags().contains("cors");
    cookie
}

fn missing(name: &'static str) -> IoError {
    IoError::new(ErrorKind::InvalidInput, format!("{name} is required"))
}
