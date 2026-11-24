//! Token key derivation vectors.

use session::{SessionError, TokenKey, TOKEN_KEY_LEN, TOKEN_KEY_SALT};

const SECRET: &str = "penpot-test-secret";
/// `HKDF-BLAKE2b-512(salt="tokens", ikm=SECRET, info="", L=32)`.
///
/// Reproduced independently with OpenSSL 3 through Node:
/// `crypto.hkdfSync("blake2b512", ikm, salt, "", 32)`. The buddy engine uses
/// the same RFC 5869 construction, but a live buddy vector is still C1.
const EXPECTED: &str = "20e34b2106d41f044de03f10e65d42ba8b2395c958ff9d65315cf846e27db92e";

#[test]
fn derives_the_pinned_vector() {
    let key = TokenKey::derive(SECRET).unwrap();
    assert_eq!(hex::encode(key.as_bytes()), EXPECTED);
    assert_eq!(key.as_bytes().len(), TOKEN_KEY_LEN);
    assert_eq!(TOKEN_KEY_SALT, b"tokens");
}

#[test]
fn derivation_is_deterministic_and_secret_sensitive() {
    let first = TokenKey::derive(SECRET).unwrap();
    let second = TokenKey::derive(SECRET).unwrap();
    let other = TokenKey::derive("another-secret").unwrap();
    assert_eq!(first.as_bytes(), second.as_bytes());
    assert_ne!(first.as_bytes(), other.as_bytes());
}

#[test]
fn rejects_an_empty_secret() {
    assert_eq!(TokenKey::derive("").unwrap_err(), SessionError::EmptySecret);
}

#[test]
fn debug_output_is_redacted() {
    let key = TokenKey::derive(SECRET).unwrap();
    let text = format!("{key:?}");
    assert_eq!(text, "TokenKey(<redacted>)");
    assert!(!text.contains(EXPECTED));
}
