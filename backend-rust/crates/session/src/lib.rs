//! Penpot session tokens, cookies, and the key that protects them.
//!
//! This is milestone M4 of `backend-rust/PLAN.md`. It covers the parts of
//! `backend/src/app/tokens.clj`, `backend/src/app/setup/keys.clj`, and the
//! token/cookie half of `backend/src/app/http/session.clj`:
//!
//! 1. Derive a 32-byte token key with HKDF-HMAC-BLAKE2b-512 and the `"tokens"`
//!    salt ([`TokenKey::derive`]).
//! 2. Encrypt a transit payload as a JWE compact token with `A256KW` and
//!    `A256GCM` ([`TokenCodec`]).
//! 3. Check `exp` and `iss` with the same order and strictness as `verify`
//!    ([`Token::verify`]).
//! 4. Describe the session cookie ([`CookiePolicy`], [`SessionCookie`]).
//!
//! ```
//! use session::{SessionClaims, Token};
//!
//! let token = Token::new("secret").unwrap();
//! let jwe = token.encode_at(&SessionClaims::default(), 1_700_000_000_000).unwrap();
//! let claims = token.decode(&jwe).unwrap();
//! assert_eq!(claims.iat_ms(), Some(1_700_000_000_000));
//! ```
//!
//! # Compatibility
//!
//! Encoding follows RFC 7516 and the header/algorithm choices in
//! `app.tokens/generate`, so a token this crate writes should decrypt in the
//! Clojure backend and vice versa. Byte-for-byte agreement with buddy is
//! **not yet proven**: that needs a token captured from a live instance
//! (`PLAN.md` §10, C1). `tests/buddy_vector.rs` is the switch that turns the
//! captured vector into an assertion.
//!
//! # Failure model
//!
//! Token input is hostile. Sizes are checked before any cipher call, the
//! protected header must carry `alg`/`enc`/`kid`/`ver` with the expected
//! values, base64url must be unpadded, and every rejection is a small
//! [`InvalidReason`] without key material or plaintext.

mod aes_kw;
mod claims;
mod cookie;
mod error;
mod jwe;
mod key;

pub use claims::{
    now_ms, Claims, SessionClaims, SessionIdentity, AUTHENTICATION_ISSUER, PENPOT_AUDIENCE,
};
pub use cookie::{
    CookiePolicy, SameSite, SessionCookie, DEFAULT_ABSOLUTE_MAX_AGE, DEFAULT_COOKIE_NAME,
    DEFAULT_MAX_AGE, DEFAULT_RENEWAL_MAX_AGE,
};
pub use error::{InvalidReason, Result, SessionError};
pub use jwe::{
    decode_header, TokenCodec, TokenHeader, ALGORITHM, CEK_LEN, ENCRYPTION, IV_LEN, MAX_HEADER_LEN,
    MAX_TOKEN_LEN, SEGMENTS, TAG_LEN, WRAPPED_KEY_LEN,
};
pub use key::{TokenKey, TOKEN_KEY_LEN, TOKEN_KEY_SALT};

/// A token codec that speaks Penpot's transit claim payload.
#[derive(Debug, Clone)]
pub struct Token {
    codec: TokenCodec,
}

impl Token {
    /// Derive the token key from `PENPOT_SECRET_KEY`.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::EmptySecret`] for an empty secret.
    pub fn new(secret: &str) -> Result<Self> {
        Ok(Self {
            codec: TokenCodec::new(secret)?,
        })
    }

    /// Build a token codec from an already derived key.
    #[must_use]
    pub fn from_key(key: TokenKey) -> Self {
        Self {
            codec: TokenCodec::with_header(key, TokenHeader::PENPOT),
        }
    }

    /// The underlying JWE codec.
    #[must_use]
    pub fn codec(&self) -> &TokenCodec {
        &self.codec
    }

    /// Encode claims, defaulting `iat` to the current time.
    ///
    /// # Errors
    ///
    /// Fails if the JWE layer rejects the payload.
    pub fn encode(&self, claims: &SessionClaims) -> Result<String> {
        self.encode_at(claims, now_ms())
    }

    /// Encode claims with an explicit `iat`, for tests and replays.
    ///
    /// # Errors
    ///
    /// Fails if the JWE layer rejects the payload.
    pub fn encode_at(&self, claims: &SessionClaims, now_ms: i64) -> Result<String> {
        let mut claims = claims.clone();
        if claims.iat_ms.is_none() {
            claims.iat_ms = Some(now_ms);
        }
        let payload = transit::encode(&claims.to_value());
        self.codec.encrypt(payload.as_bytes())
    }

    /// Decrypt and parse a token. No claim checks run here.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidReason::IntegrityFailed`] for a wrong key or tampering,
    /// or [`InvalidReason::InvalidClaims`] when the payload is not transit or
    /// has mistyped known claims.
    pub fn decode(&self, token: &str) -> Result<Claims> {
        let payload = self.codec.decrypt(token)?;
        let text = std::str::from_utf8(&payload)
            .map_err(|_| SessionError::invalid(InvalidReason::InvalidClaims))?;
        let value = transit::decode(text)
            .map_err(|_| SessionError::invalid(InvalidReason::InvalidClaims))?;
        Claims::parse(value)
    }

    /// `app.tokens/verify`: expiry first, then the optional issuer check.
    ///
    /// `exp` equal to `now_ms` is still valid; only `exp < now` is expired,
    /// matching `ct/is-before?`.
    ///
    /// # Errors
    ///
    /// Propagates [`Token::decode`] failures, then returns
    /// [`InvalidReason::TokenExpired`] or [`InvalidReason::InvalidIssuer`].
    pub fn verify(&self, token: &str, iss: Option<&str>, now_ms: i64) -> Result<Claims> {
        let claims = self.decode(token)?;
        if let Some(exp) = claims.exp_ms() {
            if exp < now_ms {
                return Err(SessionError::invalid(InvalidReason::TokenExpired));
            }
        }
        if let Some(expected) = iss {
            if claims.iss() != Some(expected) {
                return Err(SessionError::invalid(InvalidReason::InvalidIssuer));
            }
        }
        Ok(claims)
    }

    /// [`Token::verify`] against the system clock.
    ///
    /// # Errors
    ///
    /// Same as [`Token::verify`].
    pub fn verify_now(&self, token: &str, iss: Option<&str>) -> Result<Claims> {
        self.verify(token, iss, now_ms())
    }
}
