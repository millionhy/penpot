//! C1 hook: a real token captured from a running Penpot instance.
//!
//! Capturing one is manual:
//!
//! 1. Start devenv and log in once.
//! 2. Copy the `auth-token` cookie value and the instance's
//!    `PENPOT_SECRET_KEY`.
//! 3. Run:
//!
//!    ```text
//!    $env:PENPOT_TOKEN = "<cookie value>"
//!    $env:PENPOT_SECRET = "<secret>"
//!    cargo test -p session --test buddy_vector -- --ignored --nocapture
//!    ```
//!
//! Until this passes, "compatible with buddy" is an argument from the
//! algorithm choices, not a measured fact (`PLAN.md` §10, C1).

use session::{Token, AUTHENTICATION_ISSUER};

#[test]
#[ignore = "needs a live Penpot token (PLAN.md §10 C1)"]
fn decodes_a_buddy_token() {
    let raw =
        std::env::var("PENPOT_TOKEN").expect("set PENPOT_TOKEN to the auth-token cookie value");
    let secret = std::env::var("PENPOT_SECRET").expect("set PENPOT_SECRET to PENPOT_SECRET_KEY");

    let codec = Token::new(&secret).expect("derive token key");
    let claims = codec
        .verify(&raw, Some(AUTHENTICATION_ISSUER), session::now_ms())
        .expect("decode a real buddy token");
    println!("iss={:?}", claims.iss());
    println!("sid={:?}", claims.sid());
    println!("uid={:?}", claims.uid());
    println!("iat={:?}", claims.iat_ms());
    println!("exp={:?}", claims.exp_ms());
    println!("payload={}", transit::encode(claims.value()));
}
