//! Encode/decode/verify behaviour.

use std::time::Duration;

use session::{
    InvalidReason, SessionClaims, SessionError, SessionIdentity, Token, TokenCodec,
    AUTHENTICATION_ISSUER, PENPOT_AUDIENCE,
};
use transit::Value;
use uuid::Uuid;

const SECRET: &str = "token-test-secret";
const NOW: i64 = 1_700_000_000_000;

fn token() -> Token {
    Token::new(SECRET).unwrap()
}

fn claims(exp_ms: Option<i64>) -> SessionClaims {
    SessionClaims {
        iss: Some(AUTHENTICATION_ISSUER.to_owned()),
        aud: Some(PENPOT_AUDIENCE.to_owned()),
        sid: Some(Uuid::from_u128(0x1234)),
        iat_ms: Some(NOW - 1_000),
        uid: Some(Uuid::from_u128(0x5678)),
        sso_provider_id: Some(Uuid::from_u128(0x9abc)),
        sso_session_id: Some("sso-1".to_owned()),
        exp_ms,
    }
}

fn invalid(reason: InvalidReason) -> SessionError {
    SessionError::invalid(reason)
}

#[test]
fn round_trips_every_claim() {
    let encoded = token().encode_at(&claims(Some(NOW + 60_000)), NOW).unwrap();
    let decoded = token().decode(&encoded).unwrap();
    assert_eq!(decoded.iss(), Some(AUTHENTICATION_ISSUER));
    assert_eq!(decoded.aud(), Some(PENPOT_AUDIENCE));
    assert_eq!(decoded.sid(), Some(Uuid::from_u128(0x1234)));
    assert_eq!(decoded.uid(), Some(Uuid::from_u128(0x5678)));
    assert_eq!(decoded.sso_provider_id(), Some(Uuid::from_u128(0x9abc)));
    assert_eq!(decoded.sso_session_id(), Some("sso-1"));
    assert_eq!(decoded.iat_ms(), Some(NOW - 1_000));
    assert_eq!(decoded.exp_ms(), Some(NOW + 60_000));
}

#[test]
fn defaults_iat_when_missing() {
    let encoded = token()
        .encode_at(
            &SessionClaims {
                iss: Some(AUTHENTICATION_ISSUER.to_owned()),
                ..SessionClaims::default()
            },
            NOW,
        )
        .unwrap();
    assert_eq!(token().decode(&encoded).unwrap().iat_ms(), Some(NOW));
}

#[test]
fn exp_equal_to_now_is_still_valid() {
    let encoded = token().encode_at(&claims(Some(NOW)), NOW).unwrap();
    assert!(token().verify(&encoded, None, NOW).is_ok());

    let encoded = token().encode_at(&claims(Some(NOW + 1)), NOW).unwrap();
    assert!(token().verify(&encoded, None, NOW).is_ok());
}

#[test]
fn exp_before_now_is_expired() {
    let encoded = token().encode_at(&claims(Some(NOW - 1)), NOW).unwrap();
    assert_eq!(
        token().verify(&encoded, None, NOW).unwrap_err(),
        invalid(InvalidReason::TokenExpired)
    );
}

#[test]
fn a_missing_exp_never_expires() {
    let encoded = token().encode_at(&claims(None), NOW).unwrap();
    assert!(token().verify(&encoded, None, i64::MAX / 2).is_ok());
}

#[test]
fn expiry_is_checked_before_the_issuer() {
    let mut claims = claims(Some(NOW - 1));
    claims.iss = Some("someone-else".to_owned());
    let encoded = token().encode_at(&claims, NOW).unwrap();
    assert_eq!(
        token()
            .verify(&encoded, Some(AUTHENTICATION_ISSUER), NOW)
            .unwrap_err(),
        invalid(InvalidReason::TokenExpired)
    );
}

#[test]
fn issuer_is_checked_only_when_requested() {
    let encoded = token().encode_at(&claims(None), NOW).unwrap();
    assert!(token().verify(&encoded, None, NOW).is_ok());
    assert!(token()
        .verify(&encoded, Some(AUTHENTICATION_ISSUER), NOW)
        .is_ok());

    let mut claims = claims(None);
    claims.iss = Some("someone-else".to_owned());
    let encoded = token().encode_at(&claims, NOW).unwrap();
    assert_eq!(
        token()
            .verify(&encoded, Some(AUTHENTICATION_ISSUER), NOW)
            .unwrap_err(),
        invalid(InvalidReason::InvalidIssuer)
    );
    assert!(token().verify(&encoded, None, NOW).is_ok());
}

#[test]
fn every_segment_rejects_tampering() {
    let encoded = token().encode_at(&claims(Some(NOW + 60_000)), NOW).unwrap();
    let parts: Vec<&str> = encoded.split('.').collect();
    assert_eq!(parts.len(), 5);

    for index in 0..parts.len() {
        let mut tampered = parts.clone();
        let segment = parts[index];
        let mut bytes = segment.as_bytes().to_vec();
        // Flip one character well inside the segment so the change is not a
        // pure padding-bit artefact.
        let position = 4.min(bytes.len() - 1);
        bytes[position] = if bytes[position] == b'A' { b'B' } else { b'A' };
        let replacement = String::from_utf8(bytes).unwrap();
        tampered[index] = &replacement;
        assert!(
            token().decode(&tampered.join(".")).is_err(),
            "segment {index} tampering was accepted"
        );
    }
}

#[test]
fn rejects_a_token_from_another_secret() {
    let encoded = token().encode_at(&claims(None), NOW).unwrap();
    let other = Token::new("other-secret").unwrap();
    assert_eq!(
        other.decode(&encoded).unwrap_err(),
        invalid(InvalidReason::IntegrityFailed)
    );
}

#[test]
fn rejects_a_payload_that_is_not_transit() {
    let encoded = token().codec().encrypt(b"\x01not transit").unwrap();
    assert_eq!(
        token().decode(&encoded).unwrap_err(),
        invalid(InvalidReason::InvalidClaims)
    );
}

#[test]
fn rejects_a_known_claim_with_the_wrong_type() {
    let payload = transit::encode(&Value::map([
        (Value::kw("iss"), Value::str(AUTHENTICATION_ISSUER)),
        (Value::kw("exp"), Value::Integer(NOW + 1)),
    ]));
    let encoded = token().codec().encrypt(payload.as_bytes()).unwrap();
    assert_eq!(
        token().decode(&encoded).unwrap_err(),
        invalid(InvalidReason::InvalidClaims)
    );
}

#[test]
fn session_claims_expire_from_created_at() {
    let identity = SessionIdentity {
        id: Uuid::from_u128(1),
        profile_id: Uuid::from_u128(2),
        created_at_ms: Some(NOW - 86_400_000),
        modified_at_ms: NOW,
        sso_provider_id: None,
        sso_session_id: None,
    };
    let claims = SessionClaims::for_session(&identity, Duration::from_hours(720));
    let encoded = token().encode_at(&claims, NOW).unwrap();
    let verified = token()
        .verify(&encoded, Some(AUTHENTICATION_ISSUER), NOW)
        .unwrap();
    assert_eq!(
        verified.exp_ms(),
        Some(NOW - 86_400_000 + 30 * 86_400 * 1_000)
    );
    assert_eq!(verified.sid(), Some(Uuid::from_u128(1)));
    assert_eq!(verified.uid(), Some(Uuid::from_u128(2)));
}

#[test]
fn codec_exposes_the_penpot_header() {
    assert_eq!(token().codec().header(), session::TokenHeader::PENPOT);
    let codec = TokenCodec::new(SECRET).unwrap();
    assert_eq!(codec.header().kid, 1);
    assert_eq!(codec.header().ver, 1);
}
