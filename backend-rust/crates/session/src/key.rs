//! Token key derivation.
//!
//! `backend/src/app/setup/keys.clj` derives the JWE key with
//! `(bk/engine {:key secret :salt "tokens" :alg :hkdf :digest :blake2b-512})`
//! and takes 32 bytes. Buddy's HKDF engine is RFC 5869 with the secret as the
//! input keying material, no `info`, and a BLAKE2b-512 HMAC. That is what this
//! module computes; the parameters are pinned by `tests/key.rs`.

use blake2::Blake2b512;
use hkdf::SimpleHkdf;
use zeroize::{Zeroize, Zeroizing};

use crate::error::{Result, SessionError};

/// The HKDF salt used by `app.setup.keys/derive` for the token key.
pub const TOKEN_KEY_SALT: &[u8] = b"tokens";
/// Derived key size asked of buddy (`size` defaults to 32).
pub const TOKEN_KEY_LEN: usize = 32;

/// A 32-byte AES key used to wrap per-token content encryption keys.
///
/// The key never appears in `Debug` output and is zeroed on drop.
#[derive(Clone, PartialEq, Eq)]
pub struct TokenKey([u8; TOKEN_KEY_LEN]);

impl TokenKey {
    /// Derive the token key from `PENPOT_SECRET_KEY`.
    ///
    /// Clojure asserts that the secret is a non-empty string; an empty secret
    /// is rejected here for the same reason.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::EmptySecret`] when `secret` is empty.
    pub fn derive(secret: &str) -> Result<Self> {
        if secret.is_empty() {
            return Err(SessionError::EmptySecret);
        }

        // BLAKE2b's core is not an "eager" hash, so `Hmac<Blake2b512>` does not
        // implement the optimized HMAC path; `SimpleHkdf` picks `SimpleHmac`,
        // which computes the same RFC 2104 construction over any digest.
        let hkdf = SimpleHkdf::<Blake2b512>::new(Some(TOKEN_KEY_SALT), secret.as_bytes());
        let mut okm = Zeroizing::new([0_u8; TOKEN_KEY_LEN]);
        hkdf.expand(&[], &mut okm[..])
            .map_err(|_| SessionError::KeyDerivation)?;
        Ok(Self(*okm))
    }

    /// Wrap raw key bytes, for tests and for callers that already hold a key.
    #[must_use]
    pub fn from_bytes(bytes: [u8; TOKEN_KEY_LEN]) -> Self {
        Self(bytes)
    }

    /// The raw key bytes.
    #[must_use]
    pub fn as_bytes(&self) -> &[u8; TOKEN_KEY_LEN] {
        &self.0
    }
}

impl std::fmt::Debug for TokenKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TokenKey(<redacted>)")
    }
}

impl Drop for TokenKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}
