//! Tokens written by a second JWE implementation.
//!
//! `fixtures/gen-jwe-vector.mjs` uses Node/OpenSSL for HKDF, RFC 3394 AES-KW,
//! and AES-256-GCM. These vectors prove format agreement between two
//! implementations. They are not buddy output; see `buddy_vector.rs` for the
//! C1 hook.

use session::{Token, TokenCodec};
use uuid::Uuid;

const SECRET: &str = "penpot-test-secret";

/// Plaintext `hello`, CEK `[7; 32]`, IV `[9; 12]`.
const HELLO: &str = concat!(
    "eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoxLCJ2ZXIiOjF9",
    ".jDSocGjAsBckFneOPgPLbEp6Jza4OhOvuPg_dMoyKAjW7zVmXqUtJA",
    ".CQkJCQkJCQkJCQkJ",
    ".T-Do-NE",
    ".3HE4kPbxOsctt2HBuPSZLA"
);

/// Session claims, CEK `[3; 32]`, IV `[4; 12]`.
const CLAIMS: &str = concat!(
    "eyJhbGciOiJBMjU2S1ciLCJlbmMiOiJBMjU2R0NNIiwia2lkIjoxLCJ2ZXIiOjF9",
    ".nD2XqT3lQ2vEmVNuhydvwvC5-p3IVwAaCziX8nznwZblTKH2DXsArg",
    ".BAQEBAQEBAQEBAQE",
    ".GwVN7Y-yJWCjffMtU3gbEeQI5wktty6BSRxu_k2sxX7dQ1WpJXHEZWlX7mxCwM66iy8hlqrJ6RTcq96yZ0co41Y-WaRfLNRuT_3ZxBipNqI9WnAzvKgZBrJvmdoWHoi9Uv-NZEZUXs0qH-dHqEXlEQzcB5oDPWPa5T_LlQdW6C1hPc2sK5rN2u5_K3wbeO-qCyaehBxrcGx77zItWyBkb3evxk-LnImdEVF6lQ",
    ".swUBW18luFQVrLmNKaAn7A"
);

fn codec() -> TokenCodec {
    TokenCodec::new(SECRET).unwrap()
}

fn token() -> Token {
    Token::new(SECRET).unwrap()
}

#[test]
fn encoder_matches_openssl_byte_for_byte() {
    let produced = codec()
        .encrypt_with(b"hello", &[7_u8; 32], &[9_u8; 12])
        .unwrap();
    assert_eq!(produced, HELLO);
}

#[test]
fn decrypts_openssl_ciphertext() {
    assert_eq!(codec().decrypt(HELLO).unwrap(), b"hello");
}

#[test]
fn decrypts_an_openssl_claims_payload() {
    let claims = token().decode(CLAIMS).unwrap();
    assert_eq!(claims.iss(), Some("authentication"));
    assert_eq!(claims.aud(), Some("penpot"));
    assert_eq!(claims.sid(), Some(Uuid::nil()));
    assert_eq!(claims.uid(), Some(Uuid::nil()));
    assert_eq!(claims.iat_ms(), Some(1_700_000_000_000));
    assert_eq!(claims.exp_ms(), None);
}
