//! Session token claims.
//!
//! The payload of a Penpot auth token is a transit map built by
//! `app.http.session/assign-token`:
//!
//! ```clojure
//! {:iss "authentication" :aud "penpot" :sid <uuid> :iat <inst>
//!  :uid <uuid> :sso-provider-id <uuid>? :sso-session-id <string>? :exp <inst>?}
//! ```
//!
//! [`SessionClaims`] builds that map for new sessions. [`Claims`] wraps a
//! decoded map and keeps unknown keys visible, because Clojure callers get the
//! whole map back and may read claims added later.

use std::time::{Duration, SystemTime, UNIX_EPOCH};

use transit::Value;
use uuid::Uuid;

use crate::error::{InvalidReason, Result, SessionError};

/// `:iss` written by the session layer.
pub const AUTHENTICATION_ISSUER: &str = "authentication";
/// `:aud` written by the session layer.
pub const PENPOT_AUDIENCE: &str = "penpot";

/// The session row fields that end up in a token.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionIdentity {
    /// `http_session_v2.id`, carried as `:sid`.
    pub id: Uuid,
    /// `http_session_v2.profile_id`, carried as `:uid`.
    pub profile_id: Uuid,
    /// `http_session_v2.created_at`, in Unix milliseconds.
    pub created_at_ms: Option<i64>,
    /// `http_session_v2.modified_at`, in Unix milliseconds.
    pub modified_at_ms: i64,
    /// Optional SSO provider id.
    pub sso_provider_id: Option<Uuid>,
    /// Optional SSO session id.
    pub sso_session_id: Option<String>,
}

/// Claims for a new or renewed session.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionClaims {
    pub iss: Option<String>,
    pub aud: Option<String>,
    pub sid: Option<Uuid>,
    /// Issued-at instant, Unix milliseconds.
    pub iat_ms: Option<i64>,
    pub uid: Option<Uuid>,
    pub sso_provider_id: Option<Uuid>,
    pub sso_session_id: Option<String>,
    /// Absolute expiry instant, Unix milliseconds.
    pub exp_ms: Option<i64>,
}

impl SessionClaims {
    /// Build the claims `assign-token` writes for a session row.
    ///
    /// `exp` exists only when the session has a creation instant, and is
    /// `created-at + absolute-max-age`.
    #[must_use]
    pub fn for_session(session: &SessionIdentity, absolute_max_age: Duration) -> Self {
        Self {
            iss: Some(AUTHENTICATION_ISSUER.to_owned()),
            aud: Some(PENPOT_AUDIENCE.to_owned()),
            sid: Some(session.id),
            iat_ms: Some(session.modified_at_ms),
            uid: Some(session.profile_id),
            sso_provider_id: session.sso_provider_id,
            sso_session_id: session.sso_session_id.clone(),
            exp_ms: session
                .created_at_ms
                .map(|created| created.saturating_add(duration_millis(absolute_max_age))),
        }
    }

    /// Encode as the transit value buddy encrypts.
    ///
    /// Nil claims are dropped (`d/without-nils`) in the same fixed order the
    /// Clojure map literal uses.
    #[must_use]
    pub fn to_value(&self) -> Value {
        let mut entries = Vec::with_capacity(8);
        if let Some(value) = &self.iss {
            entries.push((Value::kw("iss"), Value::str(value)));
        }
        if let Some(value) = &self.aud {
            entries.push((Value::kw("aud"), Value::str(value)));
        }
        if let Some(value) = self.sid {
            entries.push((Value::kw("sid"), Value::Uuid(value)));
        }
        if let Some(value) = self.iat_ms {
            entries.push((Value::kw("iat"), Value::Instant(value)));
        }
        if let Some(value) = self.uid {
            entries.push((Value::kw("uid"), Value::Uuid(value)));
        }
        if let Some(value) = self.sso_provider_id {
            entries.push((Value::kw("sso-provider-id"), Value::Uuid(value)));
        }
        if let Some(value) = &self.sso_session_id {
            entries.push((Value::kw("sso-session-id"), Value::str(value)));
        }
        if let Some(value) = self.exp_ms {
            entries.push((Value::kw("exp"), Value::Instant(value)));
        }
        Value::map(entries)
    }
}

/// A decoded claim map.
#[derive(Debug, Clone, PartialEq)]
pub struct Claims(Value);

impl Claims {
    /// Wrap a transit value after checking the types of known claims.
    ///
    /// A present but mistyped known claim is rejected. Clojure's
    /// `(ct/inst? (:exp claims))` guard would silently skip expiry for a
    /// non-instant `exp`; this port fails closed instead.
    ///
    /// # Errors
    ///
    /// Returns [`InvalidReason::InvalidClaims`] for a non-map value or a known
    /// claim with the wrong transit type.
    pub fn parse(value: Value) -> Result<Self> {
        if !value.is_map() {
            return Err(SessionError::invalid(InvalidReason::InvalidClaims));
        }
        let claims = Self(value);
        claims.check_types()?;
        Ok(claims)
    }

    fn check_types(&self) -> Result<()> {
        for key in ["iss", "aud", "sso-session-id"] {
            if let Some(value) = self.0.get_kw(key) {
                if !matches!(value, Value::Str(_)) {
                    return Err(invalid_claims());
                }
            }
        }
        for key in ["sid", "uid", "sso-provider-id"] {
            if let Some(value) = self.0.get_kw(key) {
                if !matches!(value, Value::Uuid(_)) {
                    return Err(invalid_claims());
                }
            }
        }
        for key in ["iat", "exp"] {
            if let Some(value) = self.0.get_kw(key) {
                if !matches!(value, Value::Instant(_)) {
                    return Err(invalid_claims());
                }
            }
        }
        Ok(())
    }

    /// The underlying transit value.
    #[must_use]
    pub fn value(&self) -> &Value {
        &self.0
    }

    /// Consume the wrapper and return the transit value.
    #[must_use]
    pub fn into_value(self) -> Value {
        self.0
    }

    /// Read any claim by keyword name.
    #[must_use]
    pub fn get(&self, name: &str) -> Option<&Value> {
        self.0.get_kw(name)
    }

    /// `:iss`
    #[must_use]
    pub fn iss(&self) -> Option<&str> {
        self.0.get_kw("iss").and_then(Value::as_str)
    }

    /// `:aud`
    #[must_use]
    pub fn aud(&self) -> Option<&str> {
        self.0.get_kw("aud").and_then(Value::as_str)
    }

    /// `:sid`
    #[must_use]
    pub fn sid(&self) -> Option<Uuid> {
        self.0.get_kw("sid").and_then(Value::as_uuid)
    }

    /// `:uid`
    #[must_use]
    pub fn uid(&self) -> Option<Uuid> {
        self.0.get_kw("uid").and_then(Value::as_uuid)
    }

    /// `:sso-provider-id`
    #[must_use]
    pub fn sso_provider_id(&self) -> Option<Uuid> {
        self.0.get_kw("sso-provider-id").and_then(Value::as_uuid)
    }

    /// `:sso-session-id`
    #[must_use]
    pub fn sso_session_id(&self) -> Option<&str> {
        self.0.get_kw("sso-session-id").and_then(Value::as_str)
    }

    /// `:iat`, in Unix milliseconds.
    #[must_use]
    pub fn iat_ms(&self) -> Option<i64> {
        instant(&self.0, "iat")
    }

    /// `:exp`, in Unix milliseconds.
    #[must_use]
    pub fn exp_ms(&self) -> Option<i64> {
        instant(&self.0, "exp")
    }
}

fn instant(value: &Value, key: &str) -> Option<i64> {
    match value.get_kw(key) {
        Some(Value::Instant(ms)) => Some(*ms),
        _ => None,
    }
}

fn invalid_claims() -> SessionError {
    SessionError::invalid(InvalidReason::InvalidClaims)
}

fn duration_millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// Current time in Unix milliseconds.
///
/// A clock before the epoch maps to `0`; that only makes expiry checks stricter.
#[must_use]
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |elapsed| {
            i64::try_from(elapsed.as_millis()).unwrap_or(i64::MAX)
        })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nils_are_dropped_in_clojure_order() {
        let claims = SessionClaims {
            iss: Some("authentication".into()),
            aud: Some("penpot".into()),
            sid: Some(Uuid::nil()),
            iat_ms: Some(1),
            uid: Some(Uuid::nil()),
            ..SessionClaims::default()
        };
        let encoded = transit::encode(&claims.to_value());
        assert_eq!(
            encoded,
            concat!(
                r#"["^ ","~:iss","authentication","~:aud","penpot","#,
                r#""~:sid","~u00000000-0000-0000-0000-000000000000","#,
                r#""~:iat","~m1","#,
                r#""~:uid","~u00000000-0000-0000-0000-000000000000"]"#
            )
        );
    }

    #[test]
    fn round_trips_types() {
        let value = SessionClaims {
            iss: Some("authentication".into()),
            sid: Some(Uuid::from_u128(7)),
            iat_ms: Some(1_700_000_000_123),
            exp_ms: Some(1_800_000_000_456),
            ..SessionClaims::default()
        }
        .to_value();
        let claims = Claims::parse(transit::decode(&transit::encode(&value)).unwrap()).unwrap();
        assert_eq!(claims.iss(), Some("authentication"));
        assert_eq!(claims.sid(), Some(Uuid::from_u128(7)));
        assert_eq!(claims.iat_ms(), Some(1_700_000_000_123));
        assert_eq!(claims.exp_ms(), Some(1_800_000_000_456));
    }

    #[test]
    fn rejects_unknown_types_for_known_claims() {
        for (key, value) in [
            ("sid", Value::str("not-a-uuid")),
            ("uid", Value::Integer(1)),
            ("iat", Value::Integer(1)),
            ("exp", Value::str("tomorrow")),
            ("iss", Value::Integer(1)),
        ] {
            let map = Value::map([(Value::kw(key), value)]);
            assert_eq!(
                Claims::parse(map).unwrap_err(),
                SessionError::invalid(InvalidReason::InvalidClaims)
            );
        }
    }

    #[test]
    fn rejects_a_non_map_payload() {
        assert_eq!(
            Claims::parse(Value::str("nope")).unwrap_err(),
            SessionError::invalid(InvalidReason::InvalidClaims)
        );
    }

    #[test]
    fn keeps_unknown_claims_visible() {
        let map = Value::map([
            (Value::kw("iss"), Value::str("authentication")),
            (Value::kw("future"), Value::Integer(42)),
        ]);
        let claims = Claims::parse(map).unwrap();
        assert_eq!(claims.get("future"), Some(&Value::Integer(42)));
    }

    #[test]
    fn session_expiry_follows_created_at() {
        let identity = SessionIdentity {
            id: Uuid::nil(),
            profile_id: Uuid::nil(),
            created_at_ms: Some(1_000),
            modified_at_ms: 2_000,
            sso_provider_id: None,
            sso_session_id: None,
        };
        let claims = SessionClaims::for_session(&identity, Duration::from_hours(720));
        assert_eq!(claims.iat_ms, Some(2_000));
        assert_eq!(claims.exp_ms, Some(1_000 + 30 * 86_400 * 1_000));

        let identity = SessionIdentity {
            created_at_ms: None,
            ..identity
        };
        let claims = SessionClaims::for_session(&identity, Duration::from_secs(1));
        assert_eq!(claims.exp_ms, None);
    }
}
