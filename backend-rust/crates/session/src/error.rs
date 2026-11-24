//! Structured token and cookie failures.
//!
//! Token input is untrusted, so every rejection collapses to a small set of
//! reasons. None of them carry key material, plaintext, or parser detail: a
//! caller can log the reason and return a generic `invalid-token` answer
//! without leaking how far decoding got.

use thiserror::Error;

/// Why a token was rejected.
///
/// The two verification reasons use the same spellings as
/// `backend/src/app/tokens.clj`: `:token-expired` and `:invalid-issuer`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum InvalidReason {
    /// Not five base64url segments, or a segment/field with a wrong size.
    Malformed,
    /// `alg`/`enc` are not `A256KW`/`A256GCM`.
    UnsupportedAlgorithm,
    /// `kid` or `ver` do not match the expected token header.
    HeaderMismatch,
    /// The wrapped key, ciphertext, or tag failed authentication.
    IntegrityFailed,
    /// The decrypted payload is not a transit map with the expected types.
    InvalidClaims,
    /// `exp` is before the verification instant.
    TokenExpired,
    /// `iss` differs from the issuer the caller asked for.
    InvalidIssuer,
}

impl InvalidReason {
    /// Stable lowercase spelling, matching the Clojure `:reason` keywords.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Malformed => "malformed",
            Self::UnsupportedAlgorithm => "unsupported-algorithm",
            Self::HeaderMismatch => "header-mismatch",
            Self::IntegrityFailed => "integrity-failed",
            Self::InvalidClaims => "invalid-claims",
            Self::TokenExpired => "token-expired",
            Self::InvalidIssuer => "invalid-issuer",
        }
    }

    /// The generic `:code` a rejected token raises in Penpot.
    #[must_use]
    pub fn code(self) -> &'static str {
        "invalid-token"
    }
}

/// A session-layer failure.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum SessionError {
    /// `PENPOT_SECRET_KEY` (or whatever secret was passed) was empty.
    #[error("token secret must not be empty")]
    EmptySecret,
    /// HKDF refused the requested output length (32 bytes always fit today).
    #[error("HKDF could not produce the token key")]
    KeyDerivation,
    /// The token was rejected at the untrusted boundary.
    #[error("invalid token: {}", .0.as_str())]
    InvalidToken(InvalidReason),
    /// A timestamp cannot be rendered as an RFC 1123 cookie date.
    #[error("cookie timestamp {0} ms is outside the RFC 1123 range")]
    CookieTime(i64),
}

impl SessionError {
    /// Build an [`InvalidReason`] rejection.
    #[must_use]
    pub fn invalid(reason: InvalidReason) -> Self {
        Self::InvalidToken(reason)
    }

    /// The rejection reason, when this is a token failure.
    #[must_use]
    pub fn reason(&self) -> Option<InvalidReason> {
        match self {
            Self::InvalidToken(reason) => Some(*reason),
            Self::EmptySecret | Self::KeyDerivation | Self::CookieTime(_) => None,
        }
    }
}

/// Crate result alias.
pub type Result<T> = std::result::Result<T, SessionError>;
