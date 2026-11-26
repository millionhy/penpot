//! Buddy-compatible password verification.
//!
//! `app.auth/derive-password` hashes with `buddy.hashers` and the options
//! `{:alg :argon2id :memory 32768 :iterations 3 :parallelism 2}`. Buddy does
//! not write PHC strings; it writes its own six-part encoding:
//!
//! ```text
//! argon2id$<salt hex>$<memory KiB>$<iterations>$<parallelism>$<hash hex>
//! ```
//!
//! The parameters travel with the row, so verification follows the row rather
//! than the current defaults. Only `argon2id` is supported: the weak
//! `pbkdf2+sha256` scheme is used only by demo profiles.

use argon2::{Algorithm, Argon2, Params, Version};
use subtle::ConstantTimeEq;

/// Upper bound for the stored memory cost (256 MiB).
pub const MAX_MEMORY_KIB: u32 = 262_144;
/// Upper bound for the stored iteration count.
pub const MAX_ITERATIONS: u32 = 16;
/// Upper bound for the stored lane count.
pub const MAX_PARALLELISM: u32 = 16;
/// Upper bound for the stored digest length, in bytes.
pub const MAX_HASH_LEN: usize = 64;
/// Shortest salt this crate accepts.
pub const MIN_SALT_LEN: usize = 8;
/// Longest salt this crate accepts.
pub const MAX_SALT_LEN: usize = 64;

/// A parsed buddy `argon2id` row.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedHash {
    /// Memory cost in KiB, as stored.
    pub memory_kib: u32,
    pub iterations: u32,
    pub parallelism: u32,
    pub salt: Vec<u8>,
    pub hash: Vec<u8>,
}

/// Why a stored or attempted password cannot be handled.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PasswordError {
    #[error("password hash is not in buddy's six-part argon2id format")]
    Format,
    #[error("unsupported password algorithm `{0}`")]
    UnsupportedAlgorithm(String),
    #[error("password hash field `{0}` is out of range")]
    Field(&'static str),
    #[error("hex field `{0}` is malformed")]
    Hex(&'static str),
    #[error("argon2 rejected the stored parameters")]
    Argon2,
}

impl EncodedHash {
    /// Parse buddy's six-part encoding.
    ///
    /// # Errors
    ///
    /// [`PasswordError::Format`] for a wrong part count, [`PasswordError::
    /// UnsupportedAlgorithm`] for any algorithm other than `argon2id`, and
    /// [`PasswordError::Field`] / [`PasswordError::Hex`] for values outside the
    /// accepted ranges.
    pub fn parse(encoded: &str) -> Result<Self, PasswordError> {
        let parts: Vec<&str> = encoded.trim().split('$').collect();
        if parts.len() != 6 {
            return Err(PasswordError::Format);
        }

        if parts[0] != "argon2id" {
            return Err(PasswordError::UnsupportedAlgorithm(parts[0].to_owned()));
        }

        let memory_kib = number(parts[2], "memory")?;
        let iterations = number(parts[3], "iterations")?;
        let parallelism = number(parts[4], "parallelism")?;
        let hash_hex = parts[5];

        if !(8..=MAX_MEMORY_KIB).contains(&memory_kib) {
            return Err(PasswordError::Field("memory"));
        }
        if !(1..=MAX_ITERATIONS).contains(&iterations) {
            return Err(PasswordError::Field("iterations"));
        }
        if !(1..=MAX_PARALLELISM).contains(&parallelism) {
            return Err(PasswordError::Field("parallelism"));
        }

        let salt = hex(parts[1], "salt")?;
        if !(MIN_SALT_LEN..=MAX_SALT_LEN).contains(&salt.len()) {
            return Err(PasswordError::Field("salt"));
        }

        let hash = hex(hash_hex, "hash")?;
        if hash.is_empty() || hash.len() > MAX_HASH_LEN {
            return Err(PasswordError::Field("hash"));
        }

        Ok(Self {
            memory_kib,
            iterations,
            parallelism,
            salt,
            hash,
        })
    }

    /// Recompute the digest for `attempt` and compare it in constant time.
    ///
    /// # Errors
    ///
    /// [`PasswordError::Argon2`] when the stored parameters are rejected by
    /// the argon2 implementation.
    pub fn verify(&self, attempt: &str) -> Result<bool, PasswordError> {
        let params = Params::new(
            self.memory_kib,
            self.iterations,
            self.parallelism,
            Some(self.hash.len()),
        )
        .map_err(|_| PasswordError::Argon2)?;
        let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut digest = vec![0_u8; self.hash.len()];
        argon2
            .hash_password_into(attempt.as_bytes(), &self.salt, &mut digest)
            .map_err(|_| PasswordError::Argon2)?;
        Ok(digest.ct_eq(&self.hash).into())
    }
}

/// Verify `attempt` against a stored buddy `argon2id` row.
///
/// # Errors
///
/// Propagates [`EncodedHash::parse`] and [`EncodedHash::verify`].
pub fn verify(attempt: &str, encoded: &str) -> Result<bool, PasswordError> {
    EncodedHash::parse(encoded)?.verify(attempt)
}

/// Derive a buddy `argon2id` row with `app.auth`'s default options.
///
/// Test and fixture use only; the backend never invents credentials.
///
/// # Errors
///
/// [`PasswordError::Argon2`] if the fixed parameters are rejected.
pub fn derive(attempt: &str) -> Result<String, PasswordError> {
    let mut salt = [0_u8; 16];
    rand::Rng::fill(&mut rand::thread_rng(), &mut salt);
    derive_with(attempt, &salt)
}

/// Derive with an explicit salt, so tests can pin the output.
///
/// # Errors
///
/// [`PasswordError::Argon2`] if the fixed parameters are rejected.
pub fn derive_with(attempt: &str, salt: &[u8]) -> Result<String, PasswordError> {
    let params = Params::new(32_768, 3, 2, Some(32)).map_err(|_| PasswordError::Argon2)?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut digest = [0_u8; 32];
    argon2
        .hash_password_into(attempt.as_bytes(), salt, &mut digest)
        .map_err(|_| PasswordError::Argon2)?;
    Ok(format!(
        "argon2id${}$32768$3$2${}",
        to_hex(salt),
        to_hex(&digest)
    ))
}

fn number(text: &str, field: &'static str) -> Result<u32, PasswordError> {
    text.parse::<u32>().map_err(|_| PasswordError::Field(field))
}

fn hex(text: &str, field: &'static str) -> Result<Vec<u8>, PasswordError> {
    if !text.len().is_multiple_of(2) {
        return Err(PasswordError::Hex(field));
    }
    let mut out = Vec::with_capacity(text.len() / 2);
    for pair in text.as_bytes().as_chunks::<2>().0 {
        let high = digit(pair[0]).ok_or(PasswordError::Hex(field))?;
        let low = digit(pair[1]).ok_or(PasswordError::Hex(field))?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn digit(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(char::from(DIGITS[usize::from(byte >> 4)]));
        out.push(char::from(DIGITS[usize::from(byte & 0x0f)]));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    // Captured from a live Penpot 2.18 database for the throwaway account
    // rust-check-1795676855@example.com with password "Penpot-test-123!".
    const LIVE_ROW: &str = "argon2id$5b06591ef885ecba2b3a2e5b5653d388$32768$3$2$\
bbd9bcf8c5476f9118fce959b73fe089a2e0d9c6e7582dff520119f17aadc973";

    #[test]
    fn a_live_buddy_row_verifies() {
        assert!(verify("Penpot-test-123!", LIVE_ROW).expect("verify"));
        assert!(!verify("Penpot-test-123", LIVE_ROW).expect("verify"));
        assert!(!verify("", LIVE_ROW).expect("verify"));
    }

    #[test]
    fn derive_and_verify_round_trip() {
        let row = derive("correct horse battery staple").expect("derive");
        assert!(verify("correct horse battery staple", &row).expect("verify"));
        assert!(!verify("Correct horse battery staple", &row).expect("verify"));
    }

    #[test]
    fn parameters_come_from_the_row() {
        let row = derive_with("secret", &[7_u8; 16]).expect("derive");
        let parsed = EncodedHash::parse(&row).expect("parse");
        assert_eq!(parsed.memory_kib, 32_768);
        assert_eq!(parsed.iterations, 3);
        assert_eq!(parsed.parallelism, 2);
        assert_eq!(parsed.salt, [7_u8; 16]);
        assert_eq!(parsed.hash.len(), 32);
    }

    #[test]
    fn other_algorithms_are_reported() {
        let error = EncodedHash::parse("pbkdf2+sha256$aabbccddeeff0011$100$100$1$bb").unwrap_err();
        assert_eq!(
            error,
            PasswordError::UnsupportedAlgorithm("pbkdf2+sha256".into())
        );
    }

    #[test]
    fn malformed_rows_are_rejected() {
        assert_eq!(
            EncodedHash::parse("argon2id$aa").unwrap_err(),
            PasswordError::Format
        );
        assert_eq!(
            EncodedHash::parse("argon2id$zz$32768$3$2$bb").unwrap_err(),
            PasswordError::Hex("salt")
        );
        assert_eq!(
            EncodedHash::parse("argon2id$aabb$99999999$3$2$bb").unwrap_err(),
            PasswordError::Field("memory")
        );
        assert_eq!(
            EncodedHash::parse("argon2id$aabb$32768$0$2$bb").unwrap_err(),
            PasswordError::Field("iterations")
        );
        assert_eq!(
            EncodedHash::parse("argon2id$aa$32768$3$2$bb").unwrap_err(),
            PasswordError::Field("salt")
        );
    }

    #[test]
    fn a_stored_row_with_huge_memory_is_rejected_before_hashing() {
        let row = "argon2id$aabbccddeeff0011$4194304$3$2$aabb";
        assert_eq!(
            verify("x", row).unwrap_err(),
            PasswordError::Field("memory")
        );
    }
}
