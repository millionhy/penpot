//! AES Key Wrap (RFC 3394), the `A256KW` half of Penpot's JWE.
//!
//! The `aes-kw` crate on the local registry needs `aes 0.9`/`cipher 0.5`,
//! which are not cached, so the 60 lines of RFC 3394 live here on top of
//! `aes 0.8`. The published vectors in `tests` are the contract: if they pass,
//! this is the same construction buddy uses through Bouncy Castle.

use aes::cipher::consts::U16;
use aes::cipher::generic_array::GenericArray;
use aes::cipher::{BlockDecrypt, BlockEncrypt, BlockSizeUser, KeyInit};
use aes::{Aes128, Aes192, Aes256};
use subtle::ConstantTimeEq;

use crate::error::{InvalidReason, Result, SessionError};

/// The RFC 3394 default initial value, `A6A6A6A6A6A6A6A6`.
pub(crate) const DEFAULT_IV: [u8; 8] = [0xA6; 8];

type Block = GenericArray<u8, U16>;

/// Wrap `key` under `kek`.
///
/// `kek` must be 16, 24, or 32 bytes, and `key` must be a multiple of eight
/// bytes with at least two blocks, as RFC 3394 §2 requires.
pub(crate) fn wrap(kek: &[u8], key: &[u8]) -> Result<Vec<u8>> {
    if key.len() < 16 || !key.len().is_multiple_of(8) {
        return Err(malformed());
    }
    match kek.len() {
        16 => wrap_with::<Aes128>(kek, key),
        24 => wrap_with::<Aes192>(kek, key),
        32 => wrap_with::<Aes256>(kek, key),
        _ => Err(malformed()),
    }
}

/// Undo [`wrap`].
///
/// A wrong key or a tampered block fails the constant-time IV check and comes
/// back as [`InvalidReason::IntegrityFailed`].
pub(crate) fn unwrap(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>> {
    if wrapped.len() < 24 || !wrapped.len().is_multiple_of(8) {
        return Err(malformed());
    }
    match kek.len() {
        16 => unwrap_with::<Aes128>(kek, wrapped),
        24 => unwrap_with::<Aes192>(kek, wrapped),
        32 => unwrap_with::<Aes256>(kek, wrapped),
        _ => Err(malformed()),
    }
}

fn malformed() -> SessionError {
    SessionError::invalid(InvalidReason::Malformed)
}

fn integrity() -> SessionError {
    SessionError::invalid(InvalidReason::IntegrityFailed)
}

fn wrap_with<C>(kek: &[u8], key: &[u8]) -> Result<Vec<u8>>
where
    C: KeyInit + BlockEncrypt + BlockSizeUser<BlockSize = U16>,
{
    let cipher = C::new_from_slice(kek).map_err(|_| malformed())?;
    let n = key.len() / 8;
    let mut a = DEFAULT_IV;
    let mut r = key.to_vec();
    let mut block = Block::default();

    for j in 0..6_u64 {
        for i in 1..=n {
            block[..8].copy_from_slice(&a);
            block[8..].copy_from_slice(&r[(i - 1) * 8..i * 8]);
            cipher.encrypt_block(&mut block);

            let t = n as u64 * j + i as u64;
            a.copy_from_slice(&block[..8]);
            xor_be(&mut a, t);
            r[(i - 1) * 8..i * 8].copy_from_slice(&block[8..]);
        }
    }

    let mut out = Vec::with_capacity(8 + r.len());
    out.extend_from_slice(&a);
    out.extend_from_slice(&r);
    Ok(out)
}

fn unwrap_with<C>(kek: &[u8], wrapped: &[u8]) -> Result<Vec<u8>>
where
    C: KeyInit + BlockDecrypt + BlockSizeUser<BlockSize = U16>,
{
    let cipher = C::new_from_slice(kek).map_err(|_| malformed())?;
    let n = (wrapped.len() / 8) - 1;
    let mut a = [0_u8; 8];
    a.copy_from_slice(&wrapped[..8]);
    let mut r = wrapped[8..].to_vec();
    let mut block = Block::default();

    for j in (0..6_u64).rev() {
        for i in (1..=n).rev() {
            let t = n as u64 * j + i as u64;
            block[..8].copy_from_slice(&xor_be_bytes(a, t));
            block[8..].copy_from_slice(&r[(i - 1) * 8..i * 8]);
            cipher.decrypt_block(&mut block);

            a.copy_from_slice(&block[..8]);
            r[(i - 1) * 8..i * 8].copy_from_slice(&block[8..]);
        }
    }

    if !bool::from(a.ct_eq(&DEFAULT_IV)) {
        return Err(integrity());
    }
    Ok(r)
}

fn xor_be(bytes: &mut [u8; 8], value: u64) {
    *bytes = xor_be_bytes(*bytes, value);
}

fn xor_be_bytes(bytes: [u8; 8], value: u64) -> [u8; 8] {
    let t = value.to_be_bytes();
    let mut out = [0_u8; 8];
    for i in 0..8 {
        out[i] = bytes[i] ^ t[i];
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unhex(value: &str) -> Vec<u8> {
        hex::decode(value).unwrap()
    }

    #[test]
    fn rfc3394_128_bit_kek() {
        let kek = unhex("000102030405060708090A0B0C0D0E0F");
        let key = unhex("00112233445566778899AABBCCDDEEFF");
        let wrapped = unhex("1FA68B0A8112B447AEF34BD8FB5A7B829D3E862371D2CFE5");
        assert_eq!(wrap(&kek, &key).unwrap(), wrapped);
        assert_eq!(unwrap(&kek, &wrapped).unwrap(), key);
    }

    #[test]
    fn rfc3394_192_bit_kek() {
        let kek = unhex("000102030405060708090A0B0C0D0E0F1011121314151617");
        let key = unhex("00112233445566778899AABBCCDDEEFF");
        let wrapped = unhex("96778B25AE6CA435F92B5B97C050AED2468AB8A17AD84E5D");
        assert_eq!(wrap(&kek, &key).unwrap(), wrapped);
        assert_eq!(unwrap(&kek, &wrapped).unwrap(), key);
    }

    #[test]
    fn rfc3394_256_bit_kek() {
        let kek = unhex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
        let key = unhex("00112233445566778899AABBCCDDEEFF000102030405060708090A0B0C0D0E0F");
        let wrapped = unhex(
            "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21",
        );
        assert_eq!(wrap(&kek, &key).unwrap(), wrapped);
        assert_eq!(unwrap(&kek, &wrapped).unwrap(), key);
    }

    #[test]
    fn rejects_short_and_ragged_inputs() {
        let kek = [0_u8; 32];
        assert_eq!(wrap(&kek, &[0_u8; 8]).unwrap_err(), malformed());
        assert_eq!(wrap(&kek, &[0_u8; 20]).unwrap_err(), malformed());
        assert_eq!(unwrap(&kek, &[0_u8; 16]).unwrap_err(), malformed());
        assert_eq!(wrap(&[0_u8; 15], &[0_u8; 16]).unwrap_err(), malformed());
    }

    #[test]
    fn unwrap_rejects_a_tampered_block() {
        let kek = unhex("000102030405060708090A0B0C0D0E0F101112131415161718191A1B1C1D1E1F");
        let mut tampered = unhex(
            "28C9F404C4B810F4CBCCB35CFB87F8263F5786E2D80ED326CBC7F0E71A99F43BFB988B9B7A02DD21",
        );
        tampered[9] ^= 0x01;
        assert_eq!(unwrap(&kek, &tampered).unwrap_err(), integrity());
    }
}
