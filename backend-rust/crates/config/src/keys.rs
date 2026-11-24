//! `schema:config` keys this crate does not decode yet.
//!
//! `backend/src/app/config.clj` defines ~160 keys; M2 decodes the subset the
//! first backend milestones need. The rest are listed here so that a
//! deployment setting one of them gets an explicit "known but not wired"
//! classification instead of looking like a typo.
//!
//! The list is sorted for binary search and asserted against `schema:config`
//! by `tests/cljc_tables.rs`. Adding or renaming a schema key fails that test
//! until the Rust side classifies it.

/// `schema:config` keys without a [`crate::KeySpec`] yet (sorted).
pub const PENDING_KEYS: &[&str] = &[
    "admin-console-shared-key",
    "admin-console-uri",
    "admins",
    "allow-demo-users",
    "allowed-origins",
    "assets-path",
    "assets-storage-backend",
    "audit-log-archive-uri",
    "audit-log-http-handler-concurrency",
    "auto-file-snapshot-every",
    "auto-file-snapshot-timeout",
    "binfile-import-max-binary-entry-size",
    "binfile-import-max-text-entry-size",
    "binfile-import-max-text-total-size",
    "binfile-import-max-zip-entries",
    "database-max-pool-size",
    "database-min-pool-size",
    "database-password",
    "database-readonly",
    "database-uri",
    "database-username",
    "default-blob-version",
    "default-executor-parallelism",
    "default-rpc-rlimit",
    "deletion-delay",
    "email-domain-blacklist",
    "email-domain-whitelist",
    "email-verify-threshold",
    "error-report-webhook",
    "exporter-shared-key",
    "file-clean-delay",
    "file-data-backend",
    "font-max-file-size",
    "font-process-cpu",
    "font-process-mem",
    "font-process-timeout",
    "github-client-id",
    "github-client-secret",
    "gitlab-base-uri",
    "gitlab-client-id",
    "gitlab-client-secret",
    "google-client-id",
    "google-client-secret",
    "http-server-host",
    "http-server-io-threads",
    "http-server-max-body-size",
    "http-server-max-worker-threads",
    "http-server-port",
    "imagemagick-area-limit",
    "imagemagick-disk-limit",
    "imagemagick-height-limit",
    "imagemagick-map-limit",
    "imagemagick-memory-limit",
    "imagemagick-thread-limit",
    "imagemagick-time-limit",
    "imagemagick-width-limit",
    "ldap-attrs-email",
    "ldap-attrs-fullname",
    "ldap-attrs-username",
    "ldap-base-dn",
    "ldap-bind-dn",
    "ldap-bind-password",
    "ldap-host",
    "ldap-port",
    "ldap-ssl",
    "ldap-starttls",
    "ldap-user-query",
    "login-lockout-max-attempts",
    "login-lockout-window",
    "management-api-key",
    "media-directory",
    "media-max-file-size",
    "media-processing-service-timeout",
    "media-processing-service-uri",
    "media-processor-shared-key",
    "media-uri",
    "netty-io-threads",
    "nexus-shared-key",
    "nrepl-host",
    "nrepl-port",
    "oidc-auth-uri",
    "oidc-base-uri",
    "oidc-client-id",
    "oidc-client-secret",
    "oidc-email-attr",
    "oidc-jwks-uri",
    "oidc-name-attr",
    "oidc-roles",
    "oidc-roles-attr",
    "oidc-scopes",
    "oidc-token-uri",
    "oidc-user-info-source",
    "oidc-user-uri",
    "prepl-host",
    "prepl-port",
    "profile-bounce-max-age",
    "profile-bounce-threshold",
    "profile-complaint-max-age",
    "profile-complaint-threshold",
    "profile-props-max-size",
    "quotes-access-tokens-per-profile",
    "quotes-comment-threads-per-file",
    "quotes-comments-per-file",
    "quotes-files-per-project",
    "quotes-files-per-team",
    "quotes-font-variants-per-team",
    "quotes-invitations-per-team",
    "quotes-media-storage-bytes-per-team",
    "quotes-profiles-per-team",
    "quotes-projects-per-team",
    "quotes-snapshots-per-file",
    "quotes-snapshots-per-team",
    "quotes-team-access-requests-per-requester",
    "quotes-team-access-requests-per-team",
    "quotes-teams-per-profile",
    "quotes-upload-chunks-per-session",
    "quotes-upload-sessions-per-profile",
    "registration-domain-whitelist",
    "rpc-climit-config",
    "rpc-rlimit-config",
    "scheduled-executor-parallelism",
    "smtp-default-from",
    "smtp-default-reply-to",
    "smtp-host",
    "smtp-password",
    "smtp-port",
    "smtp-ssl",
    "smtp-tls",
    "smtp-username",
    "ssrf-allowed-hosts",
    "ssrf-extra-blocked-cidrs",
    "storage-assets-fs-directory",
    "storage-assets-s3-bucket",
    "storage-assets-s3-endpoint",
    "storage-assets-s3-region",
    "storage-metadata-as-json",
    "telemetry-uri",
    "telemetry-with-taiga",
    "upload-max-chunk-size",
    "urepl-host",
    "urepl-port",
    "user-feedback-destination",
];

/// How a `PENPOT_*` key name relates to this crate.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum KeyStatus {
    /// Decoded into [`crate::ConfigValue`].
    Implemented,
    /// Defined by `schema:config`, but not decoded yet.
    Pending,
    /// Not defined by `schema:config` either; likely a typo or a future key.
    Unrecognized,
}

/// Classify a normalized key name (lowercase, `_` already turned into `-`).
#[must_use]
pub fn key_status(name: &str) -> KeyStatus {
    if crate::KNOWN_KEYS.iter().any(|spec| spec.name == name) {
        KeyStatus::Implemented
    } else if PENDING_KEYS.binary_search(&name).is_ok() {
        KeyStatus::Pending
    } else {
        KeyStatus::Unrecognized
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pending_table_is_sorted_and_disjoint_from_known_keys() {
        assert!(PENDING_KEYS.windows(2).all(|pair| pair[0] < pair[1]));
        for name in PENDING_KEYS {
            assert!(
                !crate::KNOWN_KEYS.iter().any(|spec| spec.name == *name),
                "`{name}` is both implemented and pending"
            );
        }
    }

    #[test]
    fn key_status_separates_the_three_cases() {
        assert_eq!(key_status("tenant"), KeyStatus::Implemented);
        assert_eq!(key_status("database-uri"), KeyStatus::Pending);
        assert_eq!(key_status("not-a-real-key"), KeyStatus::Unrecognized);
    }
}
