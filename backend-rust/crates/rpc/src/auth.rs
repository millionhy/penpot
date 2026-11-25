//! Session and access-token decoding behind [`SessionResolver`].
//!
//! This wires the `session` crate into the RPC pipeline the way
//! `app.http.middleware/wrap-auth` and the two `authz` wrappers do:
//!
//! * the `auth-token` cookie wins over the `Authorization` header
//!   (`some-fn get-token-from-cookie get-token-from-authorization`);
//! * `Bearer` carries a session token, `Token` carries an access token;
//! * a session token must use the current `{:kid 1 :ver 1}` header and the
//!   `"authentication"` issuer, then its `:sid` is read from
//!   `http_session_v2`. An idle-expired row authenticates like a missing one;
//! * an access token must use the `"access-token"` issuer; its `:tid` is
//!   read from `access_token`, which supplies the profile and permissions.
//!
//! Persistence sits behind [`SessionStore`] and [`AccessTokenStore`], so the
//! crate stays free of sqlx. The live implementation lands with the database
//! milestone; the tests use small in-memory stores.
//!
//! A credential that fails to decode is *unauthenticated*, not an error.
//! `app.http.session/decode-token` and `app.http.access-token/decode-token`
//! log and return nil, so the request continues without an identity. Store
//! failures do surface, because the Clojure code lets database exceptions
//! reach the error handler.

use std::collections::BTreeSet;
use std::sync::Arc;
use std::time::Duration;

use axum::http::{header, HeaderMap};
use errors::Cause;
use session::{TokenHeader, DEFAULT_COOKIE_NAME, DEFAULT_MAX_AGE};
use tracing::debug;
use transit::Value;
use uuid::Uuid;

use crate::context::{AuthType, Identity};
use crate::router::SessionResolver;

/// `:iss` of an access token (`app.http.access-token/decode-token`).
pub const ACCESS_TOKEN_ISSUER: &str = "access-token";

/// The `http_session_v2` fields the auth pipeline reads.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionRecord {
    /// `http_session_v2.id`, equal to the token `:sid` that found it.
    pub id: Uuid,
    /// `http_session_v2.profile_id`.
    pub profile_id: Uuid,
    /// `http_session_v2.modified_at`, Unix milliseconds. Drives idle expiry.
    pub modified_at_ms: i64,
}

/// Reads `http_session_v2` rows.
#[async_trait::async_trait]
pub trait SessionStore: Send + Sync {
    /// Return the row for `id`, or `None` when it does not exist.
    ///
    /// # Errors
    ///
    /// Any database failure; it reaches the client as a 500.
    async fn read_session(&self, id: Uuid) -> Result<Option<SessionRecord>, Cause>;
}

/// The `access_token` fields the auth pipeline reads.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct AccessTokenRecord {
    /// `access_token.profile_id`; `None` for a deleted profile.
    pub profile_id: Option<Uuid>,
    /// `access_token.perms` (`::actoken/perms`).
    pub perms: BTreeSet<String>,
    /// `access_token.expires_at`, Unix milliseconds; `None` never expires.
    pub expires_at_ms: Option<i64>,
}

/// Reads `access_token` rows.
#[async_trait::async_trait]
pub trait AccessTokenStore: Send + Sync {
    /// Return the row for `id`, or `None` when it does not exist.
    ///
    /// `sql:get-token-data` also filters expired rows; this resolver checks
    /// `expires_at_ms` again so a store cannot widen an expired token.
    ///
    /// # Errors
    ///
    /// Any database failure; it reaches the client as a 500.
    async fn read_token(&self, id: Uuid) -> Result<Option<AccessTokenRecord>, Cause>;
}

/// Values the resolver takes from config.
#[derive(Debug, Clone)]
pub struct AuthOptions {
    /// `auth-token-cookie-name`.
    pub cookie_name: String,
    /// `auth-token-cookie-max-age`: the idle window.
    pub idle_max_age: Duration,
}

impl Default for AuthOptions {
    fn default() -> Self {
        Self {
            cookie_name: DEFAULT_COOKIE_NAME.to_owned(),
            idle_max_age: DEFAULT_MAX_AGE,
        }
    }
}

/// Injectable clock, Unix milliseconds.
pub type Clock = Arc<dyn Fn() -> i64 + Send + Sync>;

/// [`SessionResolver`] backed by the `session` crate and two stores.
pub struct TokenResolver {
    token: session::Token,
    sessions: Arc<dyn SessionStore>,
    access_tokens: Option<Arc<dyn AccessTokenStore>>,
    options: AuthOptions,
    clock: Clock,
}

impl TokenResolver {
    /// Build a resolver for session (cookie/Bearer) tokens.
    #[must_use]
    pub fn new(token: session::Token, sessions: Arc<dyn SessionStore>) -> Self {
        Self {
            token,
            sessions,
            access_tokens: None,
            options: AuthOptions::default(),
            clock: Arc::new(session::now_ms),
        }
    }

    /// Enable `Authorization: Token …` when the `access-tokens` flag is on.
    #[must_use]
    pub fn with_access_tokens(mut self, store: Arc<dyn AccessTokenStore>) -> Self {
        self.access_tokens = Some(store);
        self
    }

    #[must_use]
    pub fn with_options(mut self, options: AuthOptions) -> Self {
        self.options = options;
        self
    }

    /// Replace the clock. Tests use this to pin expiry boundaries.
    #[must_use]
    pub fn with_clock(mut self, clock: Clock) -> Self {
        self.clock = clock;
        self
    }

    async fn session_identity(&self, raw: &str) -> Result<Option<Identity>, Cause> {
        let now = (self.clock)();

        // `wrap-auth` only decodes cookie/Bearer tokens whose header is the
        // current format; anything else stays unauthenticated.
        match session::decode_header(raw) {
            Ok(TokenHeader { kid: 1, ver: 1 }) => {}
            Ok(other) => {
                debug!(kid = other.kid, ver = other.ver, "unsupported token header");
                return Ok(None);
            }
            Err(error) => {
                debug!(%error, "unreadable token header");
                return Ok(None);
            }
        }

        let claims = match self
            .token
            .verify(raw, Some(session::AUTHENTICATION_ISSUER), now)
        {
            Ok(claims) => claims,
            Err(error) => {
                debug!(%error, "session token rejected");
                return Ok(None);
            }
        };

        let Some(sid) = claims.sid() else {
            return Ok(None);
        };
        let Some(record) = self.sessions.read_session(sid).await? else {
            return Ok(None);
        };
        if idle_expired(record.modified_at_ms, self.options.idle_max_age, now) {
            return Ok(None);
        }
        Ok(Some(
            Identity::default().with_profile(record.profile_id, AuthType::Session),
        ))
    }

    async fn access_identity(&self, raw: &str) -> Result<Option<Identity>, Cause> {
        let Some(store) = &self.access_tokens else {
            return Ok(None);
        };
        let now = (self.clock)();

        let claims = match self.token.verify(raw, Some(ACCESS_TOKEN_ISSUER), now) {
            Ok(claims) => claims,
            Err(error) => {
                debug!(%error, "access token rejected");
                return Ok(None);
            }
        };
        let Some(tid) = claims.get("tid").and_then(Value::as_uuid) else {
            return Ok(None);
        };
        let Some(record) = store.read_token(tid).await? else {
            return Ok(None);
        };
        if record.expires_at_ms.is_some_and(|expires| expires <= now) {
            return Ok(None);
        }
        Ok(Some(Identity {
            profile_id: record.profile_id,
            auth_type: Some(AuthType::Token),
            token_perms: record.perms,
            auth_key_id: None,
        }))
    }
}

#[async_trait::async_trait]
impl SessionResolver for TokenResolver {
    async fn resolve(
        &self,
        headers: &HeaderMap,
        _session_id: Option<Uuid>,
    ) -> Result<Identity, Cause> {
        let Some(credential) = credential(headers, &self.options.cookie_name) else {
            return Ok(Identity::default());
        };
        let identity = match credential.kind {
            CredentialKind::Cookie | CredentialKind::Bearer => {
                self.session_identity(&credential.token).await?
            }
            CredentialKind::AccessToken => self.access_identity(&credential.token).await?,
        };
        Ok(identity.unwrap_or_default())
    }
}

fn idle_expired(modified_at_ms: i64, max_age: Duration, now_ms: i64) -> bool {
    let max_age_ms = i64::try_from(max_age.as_millis()).unwrap_or(i64::MAX);
    modified_at_ms.saturating_add(max_age_ms) < now_ms
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CredentialKind {
    Cookie,
    Bearer,
    AccessToken,
}

struct Credential {
    kind: CredentialKind,
    token: String,
}

/// Cookie first, then `Authorization`, as `wrap-auth`'s `some-fn` does. An
/// empty cookie counts as absent and falls through.
fn credential(headers: &HeaderMap, cookie_name: &str) -> Option<Credential> {
    if let Some(token) = cookie_value(headers, cookie_name) {
        return Some(Credential {
            kind: CredentialKind::Cookie,
            token,
        });
    }
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, rest) = raw.split_once(char::is_whitespace)?;
    let kind = if scheme.eq_ignore_ascii_case("token") {
        CredentialKind::AccessToken
    } else if scheme.eq_ignore_ascii_case("bearer") {
        CredentialKind::Bearer
    } else {
        return None;
    };
    Some(Credential {
        kind,
        token: rest.trim().to_owned(),
    })
}

fn cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get_all(header::COOKIE)
        .iter()
        .filter_map(|value| value.to_str().ok())
        .flat_map(|value| value.split(';'))
        .filter_map(|pair| {
            let (key, value) = pair.split_once('=')?;
            (key.trim() == name).then(|| unquote(value.trim()).to_owned())
        })
        .find(|value| !value.is_empty())
}

fn unquote(value: &str) -> &str {
    value
        .strip_prefix('"')
        .and_then(|rest| rest.strip_suffix('"'))
        .unwrap_or(value)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    fn headers(cookie: Option<&str>, authorization: Option<&str>) -> HeaderMap {
        let mut headers = HeaderMap::new();
        if let Some(cookie) = cookie {
            headers.insert(header::COOKIE, cookie.parse().unwrap());
        }
        if let Some(authorization) = authorization {
            headers.insert(header::AUTHORIZATION, authorization.parse().unwrap());
        }
        headers
    }

    struct Sessions(HashMap<Uuid, SessionRecord>);

    #[async_trait::async_trait]
    impl SessionStore for Sessions {
        async fn read_session(&self, id: Uuid) -> Result<Option<SessionRecord>, Cause> {
            Ok(self.0.get(&id).cloned())
        }
    }

    struct Tokens(HashMap<Uuid, AccessTokenRecord>);

    #[async_trait::async_trait]
    impl AccessTokenStore for Tokens {
        async fn read_token(&self, id: Uuid) -> Result<Option<AccessTokenRecord>, Cause> {
            Ok(self.0.get(&id).cloned())
        }
    }

    const NOW: i64 = 1_700_000_000_000;
    const SID: Uuid = Uuid::from_u128(1);
    const PROFILE: Uuid = Uuid::from_u128(2);
    const TID: Uuid = Uuid::from_u128(9);

    fn frozen() -> Clock {
        Arc::new(|| NOW)
    }

    fn live_row() -> SessionRecord {
        SessionRecord {
            id: SID,
            profile_id: PROFILE,
            modified_at_ms: NOW - 1_000,
        }
    }

    fn session_token(sid: Uuid, profile: Uuid, exp_ms: Option<i64>) -> String {
        let token = session::Token::new("test-secret").unwrap();
        let claims = session::SessionClaims {
            iss: Some(session::AUTHENTICATION_ISSUER.to_owned()),
            aud: Some(session::PENPOT_AUDIENCE.to_owned()),
            sid: Some(sid),
            iat_ms: Some(NOW),
            uid: Some(profile),
            exp_ms,
            ..session::SessionClaims::default()
        };
        token.encode_at(&claims, NOW).unwrap()
    }

    fn access_token(tid: Uuid, issuer: &str) -> String {
        let token = session::Token::new("test-secret").unwrap();
        let claims = Value::map([
            (Value::kw("iss"), Value::str(issuer)),
            (Value::kw("tid"), Value::Uuid(tid)),
            (Value::kw("iat"), Value::Instant(NOW)),
        ]);
        token
            .codec()
            .encrypt(transit::encode(&claims).as_bytes())
            .unwrap()
    }

    fn resolver(sessions: Sessions) -> TokenResolver {
        TokenResolver::new(
            session::Token::new("test-secret").unwrap(),
            Arc::new(sessions),
        )
        .with_clock(frozen())
    }

    fn cookie(token: &str) -> String {
        format!("auth-token={token}")
    }

    #[tokio::test]
    async fn resolves_a_live_session_from_the_cookie() {
        let token = session_token(SID, PROFILE, None);
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity.profile_id, Some(PROFILE));
        assert_eq!(identity.auth_type, Some(AuthType::Session));
    }

    #[tokio::test]
    async fn bearer_resolves_like_the_cookie() {
        let token = session_token(SID, PROFILE, None);
        let authorization = format!("Bearer {token}");
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(None, Some(&authorization)), None)
            .await
            .unwrap();
        assert_eq!(identity.profile_id, Some(PROFILE));
        assert_eq!(identity.auth_type, Some(AuthType::Session));
    }

    #[tokio::test]
    async fn no_credential_is_anonymous() {
        let identity = resolver(Sessions(HashMap::new()))
            .resolve(&HeaderMap::new(), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn an_empty_cookie_falls_through_to_the_header() {
        let token = session_token(SID, PROFILE, None);
        let authorization = format!("Bearer {token}");
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(Some("auth-token="), Some(&authorization)), None)
            .await
            .unwrap();
        assert_eq!(identity.profile_id, Some(PROFILE));
    }

    #[tokio::test]
    async fn the_cookie_wins_over_the_authorization_header() {
        let token = session_token(SID, PROFILE, None);
        let authorization = format!("Bearer {token}");
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(
                &headers(Some("auth-token=not-a-token"), Some(&authorization)),
                None,
            )
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn a_token_from_another_key_is_anonymous() {
        let other = session::Token::new("another-secret").unwrap();
        let claims = session::SessionClaims {
            iss: Some(session::AUTHENTICATION_ISSUER.to_owned()),
            sid: Some(SID),
            iat_ms: Some(NOW),
            uid: Some(PROFILE),
            ..session::SessionClaims::default()
        };
        let token = other.encode_at(&claims, NOW).unwrap();
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn an_expired_token_is_anonymous_but_exp_eq_now_is_valid() {
        let token = session_token(SID, PROFILE, Some(NOW - 1));
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());

        let token = session_token(SID, PROFILE, Some(NOW));
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity.profile_id, Some(PROFILE));
    }

    #[tokio::test]
    async fn another_kid_is_anonymous() {
        let key = session::TokenKey::derive("test-secret").unwrap();
        let codec = session::TokenCodec::with_header(key, session::TokenHeader { kid: 2, ver: 1 });
        let payload = transit::encode(
            &session::SessionClaims {
                iss: Some(session::AUTHENTICATION_ISSUER.to_owned()),
                sid: Some(SID),
                iat_ms: Some(NOW),
                uid: Some(PROFILE),
                ..session::SessionClaims::default()
            }
            .to_value(),
        );
        let token = codec.encrypt(payload.as_bytes()).unwrap();
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn a_missing_session_row_is_anonymous() {
        let token = session_token(SID, PROFILE, None);
        let identity = resolver(Sessions(HashMap::new()))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn an_idle_expired_session_is_anonymous() {
        let row = SessionRecord {
            modified_at_ms: NOW - 8 * 24 * 60 * 60 * 1_000,
            ..live_row()
        };
        let token = session_token(SID, PROFILE, None);
        let identity = resolver(Sessions(HashMap::from([(SID, row)])))
            .resolve(&headers(Some(&cookie(&token)), None), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn access_tokens_carry_permissions() {
        let tokens = Arc::new(Tokens(HashMap::from([(
            TID,
            AccessTokenRecord {
                profile_id: Some(PROFILE),
                perms: ["read".to_owned()].into_iter().collect(),
                expires_at_ms: Some(NOW + 1_000),
            },
        )])));
        let authorization = format!("Token {}", access_token(TID, ACCESS_TOKEN_ISSUER));
        let identity = TokenResolver::new(
            session::Token::new("test-secret").unwrap(),
            Arc::new(Sessions(HashMap::new())),
        )
        .with_access_tokens(tokens)
        .with_clock(frozen())
        .resolve(&headers(None, Some(&authorization)), None)
        .await
        .unwrap();
        assert_eq!(identity.profile_id, Some(PROFILE));
        assert_eq!(identity.auth_type, Some(AuthType::Token));
        assert_eq!(
            identity.token_perms,
            ["read".to_owned()].into_iter().collect::<BTreeSet<_>>()
        );
    }

    #[tokio::test]
    async fn expired_or_unknown_access_tokens_are_anonymous() {
        let authorization = format!("Token {}", access_token(TID, ACCESS_TOKEN_ISSUER));
        let build = |record: Option<AccessTokenRecord>| {
            let tokens = Arc::new(Tokens(
                record
                    .map(|record| (TID, record))
                    .into_iter()
                    .collect::<HashMap<_, _>>(),
            ));
            TokenResolver::new(
                session::Token::new("test-secret").unwrap(),
                Arc::new(Sessions(HashMap::new())),
            )
            .with_access_tokens(tokens)
            .with_clock(frozen())
        };

        let identity = build(None)
            .resolve(&headers(None, Some(&authorization)), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());

        let identity = build(Some(AccessTokenRecord {
            profile_id: Some(PROFILE),
            perms: BTreeSet::new(),
            expires_at_ms: Some(NOW),
        }))
        .resolve(&headers(None, Some(&authorization)), None)
        .await
        .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn access_tokens_are_ignored_when_the_flag_is_off() {
        let authorization = format!("Token {}", access_token(TID, ACCESS_TOKEN_ISSUER));
        let identity = resolver(Sessions(HashMap::new()))
            .resolve(&headers(None, Some(&authorization)), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn a_session_token_in_the_token_scheme_is_anonymous() {
        let tokens = Arc::new(Tokens(HashMap::from([(
            TID,
            AccessTokenRecord {
                profile_id: Some(PROFILE),
                perms: BTreeSet::new(),
                expires_at_ms: None,
            },
        )])));
        // Minted with the session issuer, so the access-token check fails.
        let token = session_token(SID, PROFILE, None);
        let identity = TokenResolver::new(
            session::Token::new("test-secret").unwrap(),
            Arc::new(Sessions(HashMap::new())),
        )
        .with_access_tokens(tokens)
        .with_clock(frozen())
        .resolve(&headers(None, Some(&format!("Token {token}"))), None)
        .await
        .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn an_unknown_scheme_is_ignored() {
        let identity = resolver(Sessions(HashMap::new()))
            .resolve(&headers(None, Some("Basic abc")), None)
            .await
            .unwrap();
        assert_eq!(identity, Identity::default());
    }

    #[tokio::test]
    async fn a_quoted_cookie_value_is_unquoted() {
        let token = session_token(SID, PROFILE, None);
        let identity = resolver(Sessions(HashMap::from([(SID, live_row())])))
            .resolve(
                &headers(Some(&format!("a=1; auth-token=\"{token}\"; b=2")), None),
                None,
            )
            .await
            .unwrap();
        assert_eq!(identity.profile_id, Some(PROFILE));
    }
}
