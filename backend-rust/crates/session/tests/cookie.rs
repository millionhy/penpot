//! Cookie attributes and rendering.

use session::{
    CookiePolicy, SameSite, SessionError, DEFAULT_COOKIE_NAME, DEFAULT_MAX_AGE,
    DEFAULT_RENEWAL_MAX_AGE,
};

const NOW: i64 = 1_700_000_000_000;

#[test]
fn defaults_match_the_clojure_constants() {
    let policy = CookiePolicy::default();
    assert_eq!(policy.name, DEFAULT_COOKIE_NAME);
    assert_eq!(policy.max_age, DEFAULT_MAX_AGE);
    assert_eq!(policy.renewal_max_age, DEFAULT_RENEWAL_MAX_AGE);
    assert_eq!(policy.same_site(), SameSite::Lax);
    assert!(!policy.secure);
}

#[test]
fn assign_sets_the_documented_attributes() {
    let cookie = CookiePolicy::default().assign("abc.def", NOW);
    assert_eq!(cookie.name, "auth-token");
    assert_eq!(cookie.value, "abc.def");
    assert_eq!(cookie.path, "/");
    assert!(cookie.http_only);
    assert!(!cookie.secure);
    assert_eq!(cookie.same_site, Some(SameSite::Lax));
    assert_eq!(cookie.expires_at_ms, Some(NOW + 7 * 86_400_000));
    assert_eq!(cookie.renewal_at_ms, Some(NOW + 6 * 3_600_000));
    assert_eq!(cookie.max_age_secs, None);
}

#[test]
fn renders_a_full_set_cookie_header() {
    let header = CookiePolicy::default()
        .assign("abc.def", NOW)
        .to_header_value()
        .unwrap();
    assert_eq!(
        header,
        concat!(
            "auth-token=abc.def; Path=/; Expires=Tue, 21 Nov 2023 22:13:20 GMT; ",
            "HttpOnly; SameSite=Lax; Comment=\"Renewal at: Wed, 15 Nov 2023 04:13:20 GMT\""
        )
    );
}

#[test]
fn cors_wins_over_strict() {
    let policy = CookiePolicy {
        cors: true,
        strict: true,
        ..CookiePolicy::default()
    };
    assert_eq!(policy.same_site(), SameSite::None);
    let header = policy.assign("t", NOW).to_header_value().unwrap();
    assert!(header.contains("; SameSite=None"));
}

#[test]
fn strict_wins_when_cors_is_off() {
    let policy = CookiePolicy {
        strict: true,
        ..CookiePolicy::default()
    };
    assert_eq!(policy.same_site(), SameSite::Strict);
    let header = policy.assign("t", NOW).to_header_value().unwrap();
    assert!(header.contains("; SameSite=Strict"));
}

#[test]
fn secure_is_driven_by_the_flag() {
    let policy = CookiePolicy {
        secure: true,
        ..CookiePolicy::default()
    };
    let header = policy.assign("t", NOW).to_header_value().unwrap();
    assert!(header.contains("; Secure;"));
}

#[test]
fn clear_writes_only_path_and_zero_max_age() {
    let cookie = CookiePolicy::default().clear();
    assert_eq!(cookie.value, "");
    assert_eq!(cookie.path, "/");
    assert_eq!(cookie.max_age_secs, Some(0));
    assert_eq!(cookie.expires_at_ms, None);
    assert_eq!(cookie.same_site, None);
    assert!(!cookie.http_only);
    assert_eq!(
        cookie.to_header_value().unwrap(),
        "auth-token=; Path=/; Max-Age=0"
    );
}

#[test]
fn formats_single_digit_days_like_java() {
    // 2026-11-05T10:00:00Z is a Thursday; Java prints "5 Nov", not "05 Nov".
    let ms = 1_793_872_800_000;
    let header = CookiePolicy::default()
        .assign("t", ms)
        .to_header_value()
        .unwrap();
    assert!(header.contains("Expires=Thu, 12 Nov 2026 10:00:00 GMT"));
    assert!(header.contains("Renewal at: Thu, 5 Nov 2026 16:00:00 GMT"));
}

#[test]
fn absolute_expiry_uses_the_absolute_age() {
    let policy = CookiePolicy::default();
    assert_eq!(policy.absolute_expiry_at_ms(NOW), NOW + 30 * 86_400_000);
}

#[test]
fn rejects_a_timestamp_outside_rfc1123() {
    // Eight days before the epoch: the expiry lands one day before it.
    let modified_at = -8 * 86_400_000;
    let cookie = CookiePolicy::default().assign("t", modified_at);
    assert_eq!(
        cookie.to_header_value().unwrap_err(),
        SessionError::CookieTime(modified_at + 7 * 86_400_000)
    );
}
