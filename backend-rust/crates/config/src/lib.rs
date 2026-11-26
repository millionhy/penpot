//! Penpot `PENPOT_*` configuration and feature flags.
//!
//! Mirrors the parts of `backend/src/app/config.clj` and
//! `common/src/app/common/flags.cljc` that the Rust backend needs first:
//! required schema fields, the secret key, auth cookie settings, object
//! storage, redis, and worker parallelism.
//!
//! Two behaviours are load bearing:
//!
//! * `PENPOT_FLAGS` is split on whitespace/commas and applied after the
//!   defaults, so `disable-x` can turn off a default flag.
//! * An HTTP `public-uri` whose host is not `localhost` automatically disables
//!   secure session cookies, and `telemetry-enabled = true` adds the
//!   `telemetry` flag. Both match `parse-flags`.
//!
//! `PENPOT_*` keys outside [`KNOWN_KEYS`] are recorded in [`Config::unknown`];
//! they are never silently dropped. [`Config::pending`] separates keys that
//! `schema:config` defines but this crate does not decode yet from
//! [`Config::unrecognized`] typos.

mod duration;
mod flags;
mod keys;

pub use duration::{parse_duration, DurationError};
pub use flags::{FlagSet, ALL_FLAGS, DEFAULT_FLAGS};
pub use keys::{key_status, KeyStatus, PENDING_KEYS};

use std::collections::{BTreeMap, BTreeSet};
use std::time::Duration;

use thiserror::Error;

/// The default worker queue of `app.main` (`::wrk/runner` `:default`).
pub const WORKER_DEFAULT_QUEUE: &str = "default";
/// The webhook worker queue of `app.main` (`::wrk/runner` `:webhooks`).
pub const WORKER_WEBHOOK_QUEUE: &str = "webhooks";
/// `(cf/get ::worker-default-parallelism 1)` / webhook equivalent.
pub const DEFAULT_WORKER_PARALLELISM: i64 = 1;

/// A decoded configuration value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigValue {
    Str(String),
    Bool(bool),
    Int(i64),
    Duration(Duration),
    Keyword(String),
    Set(BTreeSet<String>),
    Vec(Vec<String>),
    Uri(String),
}

impl ConfigValue {
    #[must_use]
    pub fn as_str(&self) -> Option<&str> {
        match self {
            Self::Str(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Self::Bool(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_i64(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_duration(&self) -> Option<Duration> {
        match self {
            Self::Duration(value) => Some(*value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_keyword(&self) -> Option<&str> {
        match self {
            Self::Keyword(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_set(&self) -> Option<&BTreeSet<String>> {
        match self {
            Self::Set(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_vec(&self) -> Option<&[String]> {
        match self {
            Self::Vec(value) => Some(value),
            _ => None,
        }
    }

    #[must_use]
    pub fn as_uri(&self) -> Option<&str> {
        match self {
            Self::Uri(value) => Some(value),
            _ => None,
        }
    }
}

/// How a `PENPOT_*` string is decoded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ValueKind {
    Str,
    Bool,
    Int,
    Duration,
    Keyword,
    Set,
    Vec,
    Uri,
}

/// One entry of the environment key table.
#[derive(Debug, Clone, Copy)]
pub struct KeySpec {
    pub name: &'static str,
    pub kind: ValueKind,
    pub default: Option<&'static str>,
    pub required: bool,
}

/// The `PENPOT_*` keys this milestone decodes.
pub const KNOWN_KEYS: &[KeySpec] = &[
    KeySpec {
        name: "admins",
        kind: ValueKind::Set,
        default: None,
        required: false,
    },
    KeySpec {
        name: "auth-token-cookie-max-age",
        kind: ValueKind::Duration,
        default: None,
        required: false,
    },
    KeySpec {
        name: "auth-token-cookie-max-age-absolute",
        kind: ValueKind::Duration,
        default: None,
        required: false,
    },
    KeySpec {
        name: "auth-token-cookie-name",
        kind: ValueKind::Str,
        default: Some("auth-token"),
        required: false,
    },
    KeySpec {
        name: "database-uri",
        kind: ValueKind::Uri,
        default: None,
        required: false,
    },
    KeySpec {
        name: "flags",
        kind: ValueKind::Set,
        default: None,
        required: false,
    },
    KeySpec {
        name: "host",
        kind: ValueKind::Str,
        default: Some("localhost"),
        required: true,
    },
    KeySpec {
        name: "is-saas",
        kind: ValueKind::Bool,
        default: Some("false"),
        required: true,
    },
    KeySpec {
        name: "objects-storage-backend",
        kind: ValueKind::Keyword,
        default: Some("fs"),
        required: false,
    },
    KeySpec {
        name: "objects-storage-fs-directory",
        kind: ValueKind::Str,
        default: Some("assets"),
        required: false,
    },
    KeySpec {
        name: "objects-storage-s3-bucket",
        kind: ValueKind::Str,
        default: None,
        required: false,
    },
    KeySpec {
        name: "objects-storage-s3-endpoint",
        kind: ValueKind::Uri,
        default: None,
        required: false,
    },
    KeySpec {
        name: "objects-storage-s3-region",
        kind: ValueKind::Keyword,
        default: None,
        required: false,
    },
    KeySpec {
        name: "public-uri",
        kind: ValueKind::Uri,
        default: Some("http://localhost:3449"),
        required: true,
    },
    KeySpec {
        name: "redis-uri",
        kind: ValueKind::Uri,
        default: Some("redis://redis/0"),
        required: false,
    },
    KeySpec {
        name: "secret-key",
        kind: ValueKind::Str,
        default: None,
        required: false,
    },
    KeySpec {
        name: "smtp-default-from",
        kind: ValueKind::Str,
        default: Some("Penpot <no-reply@example.com>"),
        required: false,
    },
    KeySpec {
        name: "smtp-default-reply-to",
        kind: ValueKind::Str,
        default: Some("Penpot <no-reply@example.com>"),
        required: false,
    },
    KeySpec {
        name: "smtp-host",
        kind: ValueKind::Str,
        default: None,
        required: false,
    },
    KeySpec {
        name: "smtp-password",
        kind: ValueKind::Str,
        default: None,
        required: false,
    },
    KeySpec {
        name: "smtp-port",
        kind: ValueKind::Int,
        default: None,
        required: false,
    },
    KeySpec {
        name: "smtp-ssl",
        kind: ValueKind::Bool,
        default: None,
        required: false,
    },
    KeySpec {
        name: "smtp-tls",
        kind: ValueKind::Bool,
        default: None,
        required: false,
    },
    KeySpec {
        name: "smtp-username",
        kind: ValueKind::Str,
        default: None,
        required: false,
    },
    KeySpec {
        name: "telemetry-enabled",
        kind: ValueKind::Bool,
        default: None,
        required: false,
    },
    KeySpec {
        name: "tenant",
        kind: ValueKind::Str,
        default: Some("default"),
        required: true,
    },
    KeySpec {
        name: "worker-default-parallelism",
        kind: ValueKind::Int,
        default: None,
        required: false,
    },
    KeySpec {
        name: "worker-webhook-parallelism",
        kind: ValueKind::Int,
        default: None,
        required: false,
    },
];

/// Configuration loading error.
#[derive(Debug, Clone, PartialEq, Eq, Error)]
pub enum ConfigError {
    #[error("invalid value for `{key}`: {value:?} ({reason})")]
    InvalidValue {
        key: String,
        value: String,
        reason: String,
    },
    #[error("missing required key `{0}`")]
    Missing(&'static str),
}

/// Decoded configuration plus the flags derived from it.
#[derive(Debug, Clone)]
pub struct Config {
    values: BTreeMap<String, ConfigValue>,
    flags: FlagSet,
    unknown: BTreeMap<String, String>,
}

impl Config {
    /// Build a config from an environment iterator. Keys are matched
    /// case-insensitively after the `PENPOT_` prefix and `_` becomes `-`.
    ///
    /// # Errors
    ///
    /// [`ConfigError`] for an invalid known value or a missing required key.
    pub fn from_env<I, K, V>(env: I) -> Result<Self, ConfigError>
    where
        I: IntoIterator<Item = (K, V)>,
        K: AsRef<str>,
        V: AsRef<str>,
    {
        let mut values = BTreeMap::new();
        for spec in KNOWN_KEYS {
            if let Some(raw) = spec.default {
                values.insert(spec.name.to_owned(), decode(spec.name, spec.kind, raw)?);
            }
        }

        let mut unknown = BTreeMap::new();
        let mut flag_tokens = Vec::new();

        for (key, value) in env {
            let raw_key = key.as_ref();
            let lower = raw_key.to_ascii_lowercase();
            let Some(rest) = lower.strip_prefix("penpot_") else {
                continue;
            };
            let name = rest.replace('_', "-");
            if name.is_empty() {
                continue;
            }
            let raw_value = value.as_ref();

            if name == "flags" {
                flag_tokens = split_words(raw_value);
                values.insert(
                    name,
                    ConfigValue::Set(flag_tokens.iter().cloned().collect()),
                );
                continue;
            }

            match KNOWN_KEYS.iter().find(|spec| spec.name == name) {
                Some(spec) => {
                    values.insert(name, decode(spec.name, spec.kind, raw_value)?);
                }
                None => {
                    unknown.insert(name, raw_value.to_owned());
                }
            }
        }

        for spec in KNOWN_KEYS.iter().filter(|spec| spec.required) {
            if !values.contains_key(spec.name) {
                return Err(ConfigError::Missing(spec.name));
            }
        }

        let public_uri = values
            .get("public-uri")
            .and_then(ConfigValue::as_uri)
            .unwrap_or_default();
        let telemetry = values
            .get("telemetry-enabled")
            .and_then(ConfigValue::as_bool)
            .unwrap_or(false);

        let mut flags = FlagSet::with_defaults();
        if let Some((scheme, host)) = uri_scheme_host(public_uri) {
            if scheme == "http" && host != "localhost" {
                flags.apply("disable-secure-session-cookies");
            }
        }
        if telemetry {
            flags.apply("enable-telemetry");
        }
        flags.apply_all(flag_tokens.iter().map(String::as_str));

        Ok(Self {
            values,
            flags,
            unknown,
        })
    }

    /// Read the current process environment.
    ///
    /// # Errors
    ///
    /// The same conditions as [`Config::from_env`].
    pub fn from_process_env() -> Result<Self, ConfigError> {
        Self::from_env(std::env::vars())
    }

    #[must_use]
    pub fn get(&self, key: &str) -> Option<&ConfigValue> {
        self.values.get(key)
    }

    #[must_use]
    pub fn str(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(ConfigValue::as_str)
    }

    #[must_use]
    pub fn bool(&self, key: &str) -> Option<bool> {
        self.get(key).and_then(ConfigValue::as_bool)
    }

    #[must_use]
    pub fn i64(&self, key: &str) -> Option<i64> {
        self.get(key).and_then(ConfigValue::as_i64)
    }

    #[must_use]
    pub fn duration(&self, key: &str) -> Option<Duration> {
        self.get(key).and_then(ConfigValue::as_duration)
    }

    #[must_use]
    pub fn keyword(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(ConfigValue::as_keyword)
    }

    #[must_use]
    pub fn set(&self, key: &str) -> Option<&BTreeSet<String>> {
        self.get(key).and_then(ConfigValue::as_set)
    }

    #[must_use]
    pub fn uri(&self, key: &str) -> Option<&str> {
        self.get(key).and_then(ConfigValue::as_uri)
    }

    #[must_use]
    pub fn tenant(&self) -> &str {
        self.str("tenant").unwrap_or("default")
    }

    #[must_use]
    pub fn secret_key(&self) -> Option<&str> {
        self.str("secret-key")
    }

    #[must_use]
    pub fn database_uri(&self) -> Option<&str> {
        self.uri("database-uri")
    }

    #[must_use]
    pub fn admins(&self) -> Option<&BTreeSet<String>> {
        self.set("admins")
    }

    #[must_use]
    pub fn public_uri(&self) -> &str {
        self.uri("public-uri").unwrap_or("http://localhost:3449")
    }

    #[must_use]
    pub fn host(&self) -> &str {
        self.str("host").unwrap_or("localhost")
    }

    #[must_use]
    pub fn is_saas(&self) -> bool {
        self.bool("is-saas").unwrap_or(false)
    }

    #[must_use]
    pub fn telemetry_enabled(&self) -> bool {
        self.bool("telemetry-enabled").unwrap_or(false)
    }

    #[must_use]
    pub fn flags(&self) -> &FlagSet {
        &self.flags
    }

    /// `PENPOT_*` keys present in the environment but absent from
    /// [`KNOWN_KEYS`].
    #[must_use]
    pub fn unknown(&self) -> &BTreeMap<String, String> {
        &self.unknown
    }

    /// Unrecognized keys that `schema:config` defines but this crate does not
    /// decode yet.
    pub fn pending(&self) -> impl Iterator<Item = (&str, &str)> {
        self.unknown
            .iter()
            .filter(|(name, _)| key_status(name) == KeyStatus::Pending)
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    /// Unrecognized keys that `schema:config` does not define either.
    pub fn unrecognized(&self) -> impl Iterator<Item = (&str, &str)> {
        self.unknown
            .iter()
            .filter(|(name, _)| key_status(name) == KeyStatus::Unrecognized)
            .map(|(name, value)| (name.as_str(), value.as_str()))
    }

    #[must_use]
    pub fn auth_token_cookie_name(&self) -> &str {
        self.str("auth-token-cookie-name").unwrap_or("auth-token")
    }

    #[must_use]
    pub fn auth_token_cookie_max_age(&self) -> Option<Duration> {
        self.duration("auth-token-cookie-max-age")
    }

    #[must_use]
    pub fn auth_token_cookie_max_age_absolute(&self) -> Option<Duration> {
        self.duration("auth-token-cookie-max-age-absolute")
    }

    #[must_use]
    pub fn objects_storage_backend(&self) -> &str {
        self.keyword("objects-storage-backend").unwrap_or("fs")
    }

    #[must_use]
    pub fn objects_storage_fs_directory(&self) -> &str {
        self.str("objects-storage-fs-directory").unwrap_or("assets")
    }

    #[must_use]
    pub fn objects_storage_s3_bucket(&self) -> Option<&str> {
        self.str("objects-storage-s3-bucket")
    }

    #[must_use]
    pub fn objects_storage_s3_region(&self) -> Option<&str> {
        self.keyword("objects-storage-s3-region")
    }

    #[must_use]
    pub fn objects_storage_s3_endpoint(&self) -> Option<&str> {
        self.uri("objects-storage-s3-endpoint")
    }

    #[must_use]
    pub fn redis_uri(&self) -> &str {
        self.uri("redis-uri").unwrap_or("redis://redis/0")
    }

    #[must_use]
    pub fn worker_default_parallelism(&self) -> i64 {
        self.i64("worker-default-parallelism")
            .unwrap_or(DEFAULT_WORKER_PARALLELISM)
    }

    #[must_use]
    pub fn worker_webhook_parallelism(&self) -> i64 {
        self.i64("worker-webhook-parallelism")
            .unwrap_or(DEFAULT_WORKER_PARALLELISM)
    }
}

fn decode(key: &str, kind: ValueKind, raw: &str) -> Result<ConfigValue, ConfigError> {
    let invalid = |reason: String| ConfigError::InvalidValue {
        key: key.to_owned(),
        value: raw.to_owned(),
        reason,
    };

    match kind {
        ValueKind::Str => Ok(ConfigValue::Str(raw.to_owned())),
        ValueKind::Bool => match raw.trim().to_ascii_lowercase().as_str() {
            "true" | "t" | "1" => Ok(ConfigValue::Bool(true)),
            "false" | "f" | "0" => Ok(ConfigValue::Bool(false)),
            _ => Err(invalid("expected a boolean".to_owned())),
        },
        ValueKind::Int => raw
            .trim()
            .parse::<i64>()
            .map(ConfigValue::Int)
            .map_err(|error| invalid(format!("expected an integer: {error}"))),
        ValueKind::Duration => parse_duration(raw)
            .map(ConfigValue::Duration)
            .map_err(|error| invalid(error.to_string())),
        ValueKind::Keyword => {
            let value = raw.trim().to_ascii_lowercase();
            if value.is_empty() {
                Err(invalid("expected a keyword".to_owned()))
            } else {
                Ok(ConfigValue::Keyword(value))
            }
        }
        ValueKind::Set => Ok(ConfigValue::Set(split_words(raw).into_iter().collect())),
        ValueKind::Vec => Ok(ConfigValue::Vec(split_words(raw))),
        ValueKind::Uri => {
            let value = raw.trim();
            if value.is_empty() {
                Err(invalid("expected a URI".to_owned()))
            } else {
                Ok(ConfigValue::Uri(value.to_owned()))
            }
        }
    }
}

fn split_words(raw: &str) -> Vec<String> {
    raw.split(|c: char| c.is_whitespace() || c == ',')
        .filter(|word| !word.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `(scheme, host)` for an absolute URI; used only by the secure-cookie rule.
fn uri_scheme_host(uri: &str) -> Option<(String, String)> {
    let (scheme, rest) = uri.split_once("://")?;
    if scheme.is_empty() {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next()?;
    let host_port = authority.rsplit('@').next()?;
    let host = if let Some(rest) = host_port.strip_prefix('[') {
        rest.split(']').next()?
    } else {
        host_port.split(':').next()?
    };
    if host.is_empty() {
        return None;
    }
    Some((scheme.to_ascii_lowercase(), host.to_ascii_lowercase()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(env: &[(&str, &str)]) -> Config {
        Config::from_env(env.iter().copied()).expect("config")
    }

    #[test]
    fn defaults_match_the_clj_config() {
        let config = config(&[]);
        assert_eq!(config.tenant(), "default");
        assert_eq!(config.public_uri(), "http://localhost:3449");
        assert_eq!(config.host(), "localhost");
        assert!(!config.is_saas());
        assert_eq!(config.auth_token_cookie_name(), "auth-token");
        assert_eq!(config.objects_storage_backend(), "fs");
        assert_eq!(config.objects_storage_fs_directory(), "assets");
        assert_eq!(config.redis_uri(), "redis://redis/0");
        assert_eq!(
            config.str("smtp-default-from"),
            Some("Penpot <no-reply@example.com>")
        );
        assert_eq!(
            config.str("smtp-default-reply-to"),
            Some("Penpot <no-reply@example.com>")
        );
        assert_eq!(config.worker_default_parallelism(), 1);
        assert_eq!(config.worker_webhook_parallelism(), 1);
        assert!(config.flags().contains("registration"));
        assert!(config.flags().contains("secure-session-cookies"));
        assert!(config.unknown().is_empty());
    }

    #[test]
    fn environment_overrides_and_decodes_known_keys() {
        let config = config(&[
            ("PENPOT_TENANT", "acme"),
            ("PENPOT_SECRET_KEY", "super-secret"),
            ("PENPOT_DATABASE_URI", "postgres://db/penpot"),
            ("PENPOT_ADMINS", "one@example.com two@example.com"),
            ("PENPOT_IS_SAAS", "true"),
            ("PENPOT_REDIS_URI", "redis://valkey/2"),
            ("PENPOT_AUTH_TOKEN_COOKIE_MAX_AGE", "168h"),
            ("PENPOT_AUTH_TOKEN_COOKIE_MAX_AGE_ABSOLUTE", "720h"),
            ("PENPOT_OBJECTS_STORAGE_BACKEND", "S3"),
            ("PENPOT_OBJECTS_STORAGE_S3_BUCKET", "penpot"),
            ("PENPOT_OBJECTS_STORAGE_S3_REGION", "eu-west-1"),
            ("PENPOT_OBJECTS_STORAGE_S3_ENDPOINT", "http://minio:9000"),
            ("PENPOT_WORKER_DEFAULT_PARALLELISM", "4"),
            ("PENPOT_WORKER_WEBHOOK_PARALLELISM", "2"),
            ("PENPOT_SMTP_HOST", "smtp.example.com"),
            ("PENPOT_SMTP_PORT", "587"),
            ("PENPOT_SMTP_TLS", "true"),
            ("PENPOT_SMTP_USERNAME", "mailer"),
            ("PENPOT_SMTP_PASSWORD", "secret"),
        ]);

        assert_eq!(config.tenant(), "acme");
        assert_eq!(config.secret_key(), Some("super-secret"));
        assert_eq!(config.database_uri(), Some("postgres://db/penpot"));
        assert_eq!(
            config.admins().unwrap(),
            &["one@example.com".to_owned(), "two@example.com".to_owned()]
                .into_iter()
                .collect()
        );
        assert!(config.is_saas());
        assert_eq!(config.redis_uri(), "redis://valkey/2");
        assert_eq!(
            config.auth_token_cookie_max_age(),
            Some(Duration::from_hours(168))
        );
        assert_eq!(
            config.auth_token_cookie_max_age_absolute(),
            Some(Duration::from_hours(720))
        );
        assert_eq!(config.objects_storage_backend(), "s3");
        assert_eq!(config.objects_storage_s3_bucket(), Some("penpot"));
        assert_eq!(config.objects_storage_s3_region(), Some("eu-west-1"));
        assert_eq!(
            config.objects_storage_s3_endpoint(),
            Some("http://minio:9000")
        );
        assert_eq!(config.worker_default_parallelism(), 4);
        assert_eq!(config.worker_webhook_parallelism(), 2);
        assert_eq!(config.str("smtp-host"), Some("smtp.example.com"));
        assert_eq!(config.i64("smtp-port"), Some(587));
        assert_eq!(config.bool("smtp-tls"), Some(true));
        assert_eq!(config.str("smtp-username"), Some("mailer"));
        assert_eq!(config.str("smtp-password"), Some("secret"));
    }

    #[test]
    fn flags_split_on_whitespace_and_commas() {
        let config = config(&[(
            "PENPOT_FLAGS",
            "enable-mcp,disable-login-with-password  enable-nexus",
        )]);
        assert!(config.flags().contains("mcp"));
        assert!(config.flags().contains("nexus"));
        assert!(!config.flags().contains("login-with-password"));
        assert_eq!(
            config.set("flags").unwrap().len(),
            3,
            "the raw token set keeps all three tokens"
        );
    }

    #[test]
    fn http_public_uri_on_a_real_host_disables_secure_cookies() {
        let config = config(&[("PENPOT_PUBLIC_URI", "http://penpot.example.com")]);
        assert!(!config.flags().contains("secure-session-cookies"));
    }

    #[test]
    fn localhost_and_https_keep_secure_cookies() {
        for uri in ["http://localhost:3449", "https://penpot.example.com"] {
            let config = config(&[("PENPOT_PUBLIC_URI", uri)]);
            assert!(
                config.flags().contains("secure-session-cookies"),
                "{uri} should keep secure cookies"
            );
        }
    }

    #[test]
    fn telemetry_enabled_adds_the_flag() {
        let config = config(&[("PENPOT_TELEMETRY_ENABLED", "true")]);
        assert!(config.telemetry_enabled());
        assert!(config.flags().contains("telemetry"));
    }

    #[test]
    fn unknown_penpot_keys_are_recorded() {
        let config = config(&[("PENPOT_FUTURE_FEATURE", "on"), ("PATH", "/usr/bin")]);
        assert_eq!(
            config.unknown().get("future-feature"),
            Some(&"on".to_owned())
        );
        assert!(!config.unknown().contains_key("path"));
    }

    #[test]
    fn pending_and_unrecognized_keys_are_separated() {
        let config = config(&[
            ("PENPOT_MEDIA_DIRECTORY", "/tmp/media"),
            ("PENPOT_TYPOO", "1"),
        ]);
        assert_eq!(
            config.pending().collect::<Vec<_>>(),
            vec![("media-directory", "/tmp/media")]
        );
        assert_eq!(
            config.unrecognized().collect::<Vec<_>>(),
            vec![("typoo", "1")]
        );
        assert_eq!(config.unknown().len(), 2);
    }

    #[test]
    fn invalid_values_are_errors_not_silent_strings() {
        assert!(matches!(
            Config::from_env([("PENPOT_WORKER_DEFAULT_PARALLELISM", "four")]),
            Err(ConfigError::InvalidValue { .. })
        ));
        assert!(matches!(
            Config::from_env([("PENPOT_IS_SAAS", "yes")]),
            Err(ConfigError::InvalidValue { .. })
        ));
        assert!(matches!(
            Config::from_env([("PENPOT_AUTH_TOKEN_COOKIE_MAX_AGE", "15")]),
            Err(ConfigError::InvalidValue { .. })
        ));
    }
}
