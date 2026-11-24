//! Session cookie attributes.
//!
//! `app.http.session/assign-session-cookie` puts one cookie on the login and
//! renewal responses. The attributes are policy, not secrets:
//!
//! * `Path=/`, `HttpOnly`, and `Expires = modified-at + idle max-age`
//! * `Comment = "Renewal at: <RFC 1123>"`
//! * `SameSite=None` when CORS is on, else `Strict` when strict cookies are
//!   on, else `Lax`
//! * `Secure` only when the secure-cookie flag is on
//!
//! Clearing writes `Path=/`, an empty value, and `Max-Age=0`, nothing else.

use std::time::{Duration, UNIX_EPOCH};

use crate::error::{Result, SessionError};

/// `cf/get :auth-token-cookie-name` default.
pub const DEFAULT_COOKIE_NAME: &str = "auth-token";
/// `default-cookie-max-age`: seven days.
pub const DEFAULT_MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);
/// `default-renewal-max-age`: six hours.
pub const DEFAULT_RENEWAL_MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
/// `default-cookie-max-age-absolute`: thirty days.
pub const DEFAULT_ABSOLUTE_MAX_AGE: Duration = Duration::from_secs(30 * 24 * 60 * 60);

/// `SameSite` attribute values.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SameSite {
    None,
    Strict,
    Lax,
}

impl SameSite {
    /// The attribute spelling.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "None",
            Self::Strict => "Strict",
            Self::Lax => "Lax",
        }
    }
}

/// One cookie to add to a response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionCookie {
    pub name: String,
    pub value: String,
    pub path: String,
    pub http_only: bool,
    pub secure: bool,
    pub same_site: Option<SameSite>,
    /// `Expires`, Unix milliseconds. Cleared cookies leave this empty.
    pub expires_at_ms: Option<i64>,
    /// `Max-Age` in seconds. Only the clear cookie sets it.
    pub max_age_secs: Option<i64>,
    /// `Comment` renewal instant, Unix milliseconds.
    pub renewal_at_ms: Option<i64>,
}

impl SessionCookie {
    /// The `Comment` text, or `None` when the cookie has no renewal instant.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::CookieTime`] when the renewal instant cannot be
    /// rendered as an RFC 1123 date.
    pub fn comment(&self) -> Result<Option<String>> {
        self.renewal_at_ms
            .map(|ms| Ok(format!("Renewal at: {}", rfc1123(ms)?)))
            .transpose()
    }

    /// Render a `Set-Cookie` header value.
    ///
    /// Attribute order is fixed for stable tests. Browsers read attributes by
    /// name, and the values are the ones the Clojure session layer sets.
    ///
    /// # Errors
    ///
    /// Returns [`SessionError::CookieTime`] when `Expires` or `Comment` falls
    /// outside the RFC 1123 range.
    pub fn to_header_value(&self) -> Result<String> {
        let mut out = format!("{}={}; Path={}", self.name, self.value, self.path);
        if let Some(ms) = self.expires_at_ms {
            out.push_str("; Expires=");
            out.push_str(&rfc1123(ms)?);
        }
        if let Some(secs) = self.max_age_secs {
            out.push_str("; Max-Age=");
            out.push_str(&secs.to_string());
        }
        if self.http_only {
            out.push_str("; HttpOnly");
        }
        if let Some(same_site) = self.same_site {
            out.push_str("; SameSite=");
            out.push_str(same_site.as_str());
        }
        if self.secure {
            out.push_str("; Secure");
        }
        if let Some(comment) = self.comment()? {
            out.push_str("; Comment=\"");
            out.push_str(&comment);
            out.push('"');
        }
        Ok(out)
    }
}

/// Cookie name, ages, and the three flags that shape the attributes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CookiePolicy {
    pub name: String,
    pub max_age: Duration,
    pub renewal_max_age: Duration,
    pub absolute_max_age: Duration,
    pub secure: bool,
    pub strict: bool,
    pub cors: bool,
}

impl Default for CookiePolicy {
    fn default() -> Self {
        Self {
            name: DEFAULT_COOKIE_NAME.to_owned(),
            max_age: DEFAULT_MAX_AGE,
            renewal_max_age: DEFAULT_RENEWAL_MAX_AGE,
            absolute_max_age: DEFAULT_ABSOLUTE_MAX_AGE,
            secure: false,
            strict: false,
            cors: false,
        }
    }
}

impl CookiePolicy {
    /// `(if cors? :none (if strict? :strict :lax))`
    #[must_use]
    pub fn same_site(&self) -> SameSite {
        if self.cors {
            SameSite::None
        } else if self.strict {
            SameSite::Strict
        } else {
            SameSite::Lax
        }
    }

    /// `modified-at + idle max-age`, in Unix milliseconds.
    #[must_use]
    pub fn expires_at_ms(&self, modified_at_ms: i64) -> i64 {
        modified_at_ms.saturating_add(duration_millis(self.max_age))
    }

    /// `modified-at + renewal max-age`, in Unix milliseconds.
    #[must_use]
    pub fn renewal_at_ms(&self, modified_at_ms: i64) -> i64 {
        modified_at_ms.saturating_add(duration_millis(self.renewal_max_age))
    }

    /// `created-at + absolute max-age`, in Unix milliseconds.
    #[must_use]
    pub fn absolute_expiry_at_ms(&self, created_at_ms: i64) -> i64 {
        created_at_ms.saturating_add(duration_millis(self.absolute_max_age))
    }

    /// The cookie written after a login or a renewal.
    #[must_use]
    pub fn assign(&self, token: &str, modified_at_ms: i64) -> SessionCookie {
        SessionCookie {
            name: self.name.clone(),
            value: token.to_owned(),
            path: "/".to_owned(),
            http_only: true,
            secure: self.secure,
            same_site: Some(self.same_site()),
            expires_at_ms: Some(self.expires_at_ms(modified_at_ms)),
            max_age_secs: None,
            renewal_at_ms: Some(self.renewal_at_ms(modified_at_ms)),
        }
    }

    /// The cookie written by `clear-session-cookie`.
    #[must_use]
    pub fn clear(&self) -> SessionCookie {
        SessionCookie {
            name: self.name.clone(),
            value: String::new(),
            path: "/".to_owned(),
            http_only: false,
            secure: false,
            same_site: None,
            expires_at_ms: None,
            max_age_secs: Some(0),
            renewal_at_ms: None,
        }
    }
}

fn duration_millis(duration: Duration) -> i64 {
    i64::try_from(duration.as_millis()).unwrap_or(i64::MAX)
}

/// RFC 1123 in the exact shape Java's `RFC_1123_DATE_TIME` prints.
///
/// `httpdate` does the calendar math but pads the day of month; Java does not
/// (`Sun, 5 Nov 2026 …`). The Clojure backend formats the cookie, so its
/// unpadded form is the one to match.
fn rfc1123(ms: i64) -> Result<String> {
    const LIMIT_SECS: u64 = 253_402_300_800; // 10000-01-01
    if ms < 0 {
        return Err(SessionError::CookieTime(ms));
    }
    let secs = u64::try_from(ms / 1000).map_err(|_| SessionError::CookieTime(ms))?;
    if secs >= LIMIT_SECS {
        return Err(SessionError::CookieTime(ms));
    }
    let text = httpdate::fmt_http_date(UNIX_EPOCH + Duration::from_secs(secs));
    if text.as_bytes().get(5) == Some(&b'0') {
        Ok(format!("{}{}", &text[..5], &text[6..]))
    } else {
        Ok(text)
    }
}
