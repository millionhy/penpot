//! JWE compact serialization with `A256KW` + `A256GCM`.
//!
//! This is the shape `buddy.sign.jwe/encrypt` produces for Penpot tokens
//! (`backend/src/app/tokens.clj`):
//!
//! * protected header `{"alg":"A256KW","enc":"A256GCM","kid":1,"ver":1}`
//! * a fresh 256-bit content encryption key, wrapped with the token key
//! * a 96-bit IV and a 128-bit authentication tag
//! * the protected header segment as ASCII additional authenticated data
//!
//! Decoding treats every segment as hostile: sizes are checked before use,
//! base64url is unpadded and strict, and a failure never says which check
//! passed.

use aes_gcm::aead::{AeadInPlace, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce, Tag};
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::RngCore;
use zeroize::Zeroizing;

use crate::aes_kw;
use crate::error::{InvalidReason, Result, SessionError};
use crate::key::TokenKey;

/// Number of dot-separated segments in JWE compact serialization.
pub const SEGMENTS: usize = 5;
/// Content encryption key size for `A256GCM`.
pub const CEK_LEN: usize = 32;
/// IV size for `A256GCM`.
pub const IV_LEN: usize = 12;
/// Authentication tag size for `A256GCM`.
pub const TAG_LEN: usize = 16;
/// AES-KW adds one block to the 32-byte CEK.
pub const WRAPPED_KEY_LEN: usize = CEK_LEN + 8;
/// Upper bound on the decoded protected header, before JSON parsing.
pub const MAX_HEADER_LEN: usize = 512;
/// Upper bound on a whole compact token. Real session tokens are under 1 KiB;
/// the cap keeps a hostile cookie from forcing a large allocation.
pub const MAX_TOKEN_LEN: usize = 8 * 1024;

/// The `alg`/`enc` pair Penpot uses.
pub const ALGORITHM: &str = "A256KW";
/// The `enc` value Penpot uses.
pub const ENCRYPTION: &str = "A256GCM";

/// Business fields carried in the protected header.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TokenHeader {
    /// Key id. Penpot only ever writes `1`.
    pub kid: i64,
    /// Token format version. Penpot only ever writes `1`.
    pub ver: i64,
}

impl TokenHeader {
    /// `{:kid 1 :ver 1}`, the header used by `app.http.session/assign-token`.
    pub const PENPOT: Self = Self { kid: 1, ver: 1 };

    /// Serialize the protected header in the order buddy emits.
    #[must_use]
    pub fn to_json(self) -> String {
        format!(
            r#"{{"alg":"{ALGORITHM}","enc":"{ENCRYPTION}","kid":{},"ver":{}}}"#,
            self.kid, self.ver
        )
    }
}

/// A token key plus the header values this codec accepts.
#[derive(Debug, Clone)]
pub struct TokenCodec {
    key: TokenKey,
    header: TokenHeader,
}

impl TokenCodec {
    /// Derive the token key from `PENPOT_SECRET_KEY` and use the Penpot header.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::EmptySecret`] for an empty secret.
    pub fn new(secret: &str) -> Result<Self> {
        Ok(Self {
            key: TokenKey::derive(secret)?,
            header: TokenHeader::PENPOT,
        })
    }

    /// Build a codec around an already derived key.
    #[must_use]
    pub fn with_header(key: TokenKey, header: TokenHeader) -> Self {
        Self { key, header }
    }

    /// The header this codec writes and accepts.
    #[must_use]
    pub fn header(&self) -> TokenHeader {
        self.header
    }

    /// Encrypt `plaintext` into a five-segment JWE compact token.
    ///
    /// # Errors
    ///
    /// Fails only if the derived key or AES setup is refused; randomness comes
    /// from the OS.
    pub fn encrypt(&self, plaintext: &[u8]) -> Result<String> {
        let mut cek = Zeroizing::new([0_u8; CEK_LEN]);
        let mut iv = [0_u8; IV_LEN];
        rand::rngs::OsRng.fill_bytes(&mut cek[..]);
        rand::rngs::OsRng.fill_bytes(&mut iv);
        self.encrypt_with(plaintext, &cek, &iv)
    }

    /// Deterministic encryption for vectors. Not for production callers: a
    /// repeated `(cek, iv)` pair breaks AES-GCM confidentiality and integrity.
    #[doc(hidden)]
    pub fn encrypt_with(
        &self,
        plaintext: &[u8],
        cek: &[u8; CEK_LEN],
        iv: &[u8; IV_LEN],
    ) -> Result<String> {
        let protected = URL_SAFE_NO_PAD.encode(self.header.to_json().as_bytes());
        let wrapped = aes_kw::wrap(self.key.as_bytes(), cek)?;
        let cipher = Aes256Gcm::new_from_slice(cek).map_err(|_| malformed())?;
        let mut buffer = plaintext.to_vec();
        let tag = cipher
            .encrypt_in_place_detached(Nonce::from_slice(iv), protected.as_bytes(), &mut buffer)
            .map_err(|_| malformed())?;

        Ok(format!(
            "{protected}.{}.{}.{}.{}",
            URL_SAFE_NO_PAD.encode(&wrapped),
            URL_SAFE_NO_PAD.encode(iv),
            URL_SAFE_NO_PAD.encode(&buffer),
            URL_SAFE_NO_PAD.encode(tag.as_slice()),
        ))
    }

    /// Decrypt a token into its plaintext bytes.
    ///
    /// # Errors
    ///
    /// Returns an [`InvalidReason`] for a malformed token, an unexpected
    /// header, a failed key unwrap, or a failed authentication tag.
    pub fn decrypt(&self, token: &str) -> Result<Vec<u8>> {
        if token.len() > MAX_TOKEN_LEN {
            return Err(malformed());
        }
        let mut parts = token.split('.');
        let protected = parts.next().ok_or_else(malformed)?;
        let wrapped = parts.next().ok_or_else(malformed)?;
        let iv = parts.next().ok_or_else(malformed)?;
        let ciphertext = parts.next().ok_or_else(malformed)?;
        let tag = parts.next().ok_or_else(malformed)?;
        if parts.next().is_some() {
            return Err(malformed());
        }

        // Reject an oversized protected segment before allocating its decode.
        if protected.len() > MAX_HEADER_LEN * 4 / 3 + 4 {
            return Err(malformed());
        }
        let header_bytes = decode_segment(protected)?;
        if header_bytes.len() > MAX_HEADER_LEN {
            return Err(malformed());
        }
        let header = parse_header(&header_bytes)?;
        if header != self.header {
            return Err(SessionError::invalid(InvalidReason::HeaderMismatch));
        }

        let wrapped = decode_segment(wrapped)?;
        let iv = decode_segment(iv)?;
        let mut ciphertext = decode_segment(ciphertext)?;
        let tag = decode_segment(tag)?;

        if wrapped.len() != WRAPPED_KEY_LEN || iv.len() != IV_LEN || tag.len() != TAG_LEN {
            return Err(malformed());
        }

        let cek = aes_kw::unwrap(self.key.as_bytes(), &wrapped)?;
        let cek = Zeroizing::new(<[u8; CEK_LEN]>::try_from(cek).map_err(|_| malformed())?);

        // The protected header segment itself is the AAD, exactly as sent.
        let cipher = Aes256Gcm::new_from_slice(&cek[..]).map_err(|_| malformed())?;
        cipher
            .decrypt_in_place_detached(
                Nonce::from_slice(&iv),
                protected.as_bytes(),
                &mut ciphertext,
                Tag::from_slice(&tag),
            )
            .map_err(|_| SessionError::invalid(InvalidReason::IntegrityFailed))?;
        Ok(ciphertext)
    }
}

fn malformed() -> SessionError {
    SessionError::invalid(InvalidReason::Malformed)
}

fn decode_segment(segment: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(segment).map_err(|_| malformed())
}

fn parse_header(bytes: &[u8]) -> Result<TokenHeader> {
    let value: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| malformed())?;
    let object = value.as_object().ok_or_else(malformed)?;

    if object.get("alg").and_then(serde_json::Value::as_str) != Some(ALGORITHM) {
        return Err(SessionError::invalid(InvalidReason::UnsupportedAlgorithm));
    }
    if object.get("enc").and_then(serde_json::Value::as_str) != Some(ENCRYPTION) {
        return Err(SessionError::invalid(InvalidReason::UnsupportedAlgorithm));
    }

    let kid = object
        .get("kid")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| SessionError::invalid(InvalidReason::HeaderMismatch))?;
    let ver = object
        .get("ver")
        .and_then(serde_json::Value::as_i64)
        .ok_or_else(|| SessionError::invalid(InvalidReason::HeaderMismatch))?;
    Ok(TokenHeader { kid, ver })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn codec() -> TokenCodec {
        TokenCodec::with_header(
            TokenKey::derive("test-secret").unwrap(),
            TokenHeader::PENPOT,
        )
    }

    #[test]
    fn deterministic_round_trip() {
        let cek = [7_u8; CEK_LEN];
        let iv = [9_u8; IV_LEN];
        let token = codec().encrypt_with(b"hello", &cek, &iv).expect("encrypt");
        assert_eq!(token.split('.').count(), SEGMENTS);
        assert_eq!(codec().decrypt(&token).unwrap(), b"hello");
    }

    #[test]
    fn header_json_matches_expected_order() {
        assert_eq!(
            TokenHeader::PENPOT.to_json(),
            r#"{"alg":"A256KW","enc":"A256GCM","kid":1,"ver":1}"#
        );
    }

    #[test]
    fn rejects_segment_count_and_alphabet() {
        let token = codec()
            .encrypt_with(b"x", &[1_u8; CEK_LEN], &[2_u8; IV_LEN])
            .unwrap();
        assert_eq!(codec().decrypt("").unwrap_err(), malformed());
        let oversized = format!("{}.b.c.d.e", "A".repeat(MAX_TOKEN_LEN));
        assert_eq!(codec().decrypt(&oversized).unwrap_err(), malformed());
        assert_eq!(codec().decrypt("a.b.c.d").unwrap_err(), malformed());
        assert_eq!(
            codec().decrypt(&format!("{token}.x")).unwrap_err(),
            malformed()
        );
        assert_eq!(
            codec().decrypt(&format!("{token}=")).unwrap_err(),
            malformed()
        );
        assert_eq!(codec().decrypt(&token[1..]).unwrap_err(), malformed());
    }

    #[test]
    fn rejects_empty_and_wrong_sized_segments() {
        let token = codec()
            .encrypt_with(b"payload", &[3_u8; CEK_LEN], &[4_u8; IV_LEN])
            .unwrap();
        let mut parts: Vec<&str> = token.split('.').collect();

        parts[2] = "";
        assert_eq!(codec().decrypt(&parts.join(".")).unwrap_err(), malformed());

        parts[2] = token.split('.').nth(2).unwrap();
        parts[3] = "";
        // An empty ciphertext segment has a valid length; the tag check is
        // what rejects it.
        assert_eq!(
            codec().decrypt(&parts.join(".")).unwrap_err(),
            SessionError::invalid(InvalidReason::IntegrityFailed)
        );

        parts[3] = token.split('.').nth(3).unwrap();
        parts[4] = "";
        assert_eq!(codec().decrypt(&parts.join(".")).unwrap_err(), malformed());
    }

    #[test]
    fn rejects_a_short_iv_and_tag() {
        let token = codec()
            .encrypt_with(b"payload", &[5_u8; CEK_LEN], &[6_u8; IV_LEN])
            .unwrap();
        let parts: Vec<&str> = token.split('.').collect();

        let short_iv = URL_SAFE_NO_PAD.encode([0_u8; 8]);
        let bad = format!(
            "{}.{}.{}.{}.{}",
            parts[0], parts[1], short_iv, parts[3], parts[4]
        );
        assert_eq!(codec().decrypt(&bad).unwrap_err(), malformed());

        let short_tag = URL_SAFE_NO_PAD.encode([0_u8; 8]);
        let bad = format!(
            "{}.{}.{}.{}.{}",
            parts[0], parts[1], parts[2], parts[3], short_tag
        );
        assert_eq!(codec().decrypt(&bad).unwrap_err(), malformed());
    }

    #[test]
    fn rejects_a_header_with_another_algorithm() {
        let token = codec()
            .encrypt_with(b"payload", &[7_u8; CEK_LEN], &[8_u8; IV_LEN])
            .unwrap();
        let parts: Vec<&str> = token.split('.').collect();
        let original = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
        let replaced = String::from_utf8(original)
            .unwrap()
            .replace("A256KW", "A128KW");
        let protected = URL_SAFE_NO_PAD.encode(replaced.as_bytes());
        let bad = format!(
            "{protected}.{}.{}.{}.{}",
            parts[1], parts[2], parts[3], parts[4]
        );
        assert_eq!(
            codec().decrypt(&bad).unwrap_err(),
            SessionError::invalid(InvalidReason::UnsupportedAlgorithm)
        );

        let original = URL_SAFE_NO_PAD.decode(parts[0]).unwrap();
        let replaced = String::from_utf8(original)
            .unwrap()
            .replace("A256GCM", "A128GCM");
        let protected = URL_SAFE_NO_PAD.encode(replaced.as_bytes());
        let bad = format!(
            "{protected}.{}.{}.{}.{}",
            parts[1], parts[2], parts[3], parts[4]
        );
        assert_eq!(
            codec().decrypt(&bad).unwrap_err(),
            SessionError::invalid(InvalidReason::UnsupportedAlgorithm)
        );
    }

    #[test]
    fn rejects_another_kid_or_version() {
        for header in [
            TokenHeader { kid: 2, ver: 1 },
            TokenHeader { kid: 1, ver: 2 },
        ] {
            let other = TokenCodec::with_header(TokenKey::derive("test-secret").unwrap(), header);
            let token = other
                .encrypt_with(b"payload", &[9_u8; CEK_LEN], &[10_u8; IV_LEN])
                .unwrap();
            assert_eq!(
                codec().decrypt(&token).unwrap_err(),
                SessionError::invalid(InvalidReason::HeaderMismatch)
            );
        }
    }

    #[test]
    fn rejects_a_wrong_key() {
        let token = codec()
            .encrypt_with(b"payload", &[11_u8; CEK_LEN], &[12_u8; IV_LEN])
            .unwrap();
        let other = TokenCodec::with_header(
            TokenKey::derive("another-secret").unwrap(),
            TokenHeader::PENPOT,
        );
        assert_eq!(
            other.decrypt(&token).unwrap_err(),
            SessionError::invalid(InvalidReason::IntegrityFailed)
        );
    }
}
