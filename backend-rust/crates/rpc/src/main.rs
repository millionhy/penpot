//! Local M3 server: DB-free sample commands on `127.0.0.1:6061`.
//!
//! Run with `cargo run -p rpc`. It never talks to nginx or the Clojure backend;
//! port 6061 keeps it clear of the backend's 6060.

use rpc::{build_router, context_snapshot, AppState, Command, CommandResult, Registry};
use std::net::SocketAddr;
use transit::Value;

#[tokio::main]
async fn main() {
    let mut registry = Registry::new();

    registry.register(
        Command::new("get-echo", |ctx| {
            Box::pin(async move { Ok(context_snapshot(&ctx)) })
        })
        .public(),
    );

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

    let state = AppState::new(registry).with_public_uri("http://localhost:6061");
    let app = build_router(state);

    let listener = match tokio::net::TcpListener::bind("127.0.0.1:6061").await {
        Ok(listener) => listener,
        Err(error) => {
            eprintln!("cannot bind 127.0.0.1:6061: {error}");
            std::process::exit(1);
        }
    };

    println!("rpc M3 skeleton listening on http://127.0.0.1:6061");
    println!("  GET /api/main/methods/get-echo?message=hi");
    println!("  GET /api/rpc/command/get-health");

    let service = app.into_make_service_with_connect_info::<SocketAddr>();
    if let Err(error) = axum::serve(listener, service).await {
        eprintln!("server error: {error}");
        std::process::exit(1);
    }
}
