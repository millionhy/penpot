//! Feature flags, mirroring `common/src/app/common/flags.cljc`.
//!
//! The CLJC parser applies `enable-*` and `disable-*` tokens in order:
//! defaults first, then derived flags, then `PENPOT_FLAGS`. Unknown tokens keep
//! the backend's permissive behaviour (any `enable-x` produces `:x`), but names
//! that are not in [`ALL_FLAGS`] are visible through [`FlagSet::not_in_all_flags`].

use std::collections::BTreeSet;

/// Every flag named in the `login`, `email`, and `varia` sets of
/// `common/src/app/common/flags.cljc` (sorted).
pub const ALL_FLAGS: &[&str] = &[
    "access-tokens",
    "account-lockout",
    "admin-console",
    "admin-console-bulk-create-profiles",
    "audit-log",
    "audit-log-logger",
    "auto-file-snapshot",
    "available-viewer-wasm",
    "backend-api-doc",
    "backend-openapi-doc",
    "backend-svgo",
    "backend-worker",
    "background-blur",
    "client-header-check-middleware",
    "component-thumbnails",
    "cors",
    "custom-shortcuts",
    "dashboard-templates-section",
    "demo-users",
    "demo-warning",
    "email-blacklist",
    "email-verification",
    "email-whitelist",
    "export-link-later",
    "exporter-svgo",
    "file-schema-validation",
    "file-validation",
    "frontend-svgo",
    "google-fonts-provider",
    "graph",
    "hide-release-modal",
    "inspect-styles",
    "link-preview",
    "log-emails",
    "log-invitation-tokens",
    "login",
    "login-with-custom-sso",
    "login-with-github",
    "login-with-gitlab",
    "login-with-google",
    "login-with-ldap",
    "login-with-oidc",
    "login-with-password",
    "mcp",
    "nexus",
    "nrepl-server",
    "oidc-registration",
    "onboarding",
    "perf-logs",
    "prepl-server",
    "quotes",
    "redis-cache",
    "registration",
    "remote-media-processing",
    "render-switch",
    "render-wasm-dpr",
    "render-wasm-info",
    "rpc-climit",
    "rpc-rlimit",
    "sec-fetch-metadata-middleware",
    "secure-session-cookies",
    "smtp",
    "smtp-debug",
    "soft-file-schema-validation",
    "soft-file-validation",
    "soft-quotes",
    "soft-rpc-rlimit",
    "strict-session-cookies",
    "stroke-path",
    "stroke-per-side",
    "subscriptions",
    "telemetry",
    "terms-and-privacy-checkbox",
    "tiered-file-data-storage",
    "token-base-font-size",
    "token-color",
    "token-combobox",
    "token-import-from-library",
    "token-lib-sync",
    "token-shadow",
    "token-tokenscript",
    "token-typography-row",
    "transit-readable-response",
    "urepl-server",
    "user-feedback",
    "v2-migration",
    "webhooks",
];

/// Enabled flags from the `default` vector of `flags.cljc`, with the
/// `enable-` prefix removed (sorted).
pub const DEFAULT_FLAGS: &[&str] = &[
    "available-viewer-wasm",
    "backend-api-doc",
    "backend-openapi-doc",
    "backend-svgo",
    "backend-worker",
    "background-blur",
    "component-thumbnails",
    "custom-shortcuts",
    "dashboard-templates-section",
    "email-verification",
    "export-file-v3",
    "exporter-svgo",
    "feature-fdata-objects-map",
    "feature-render-wasm",
    "frontend-svgo",
    "google-fonts-provider",
    "inspect-styles",
    "link-unfurl",
    "login-with-password",
    "onboarding",
    "registration",
    "render-switch",
    "render-wasm-dpr",
    "render-wasm-info",
    "secure-session-cookies",
    "stroke-path",
    "stroke-per-side",
    "token-color",
    "token-combobox",
    "token-import-from-library",
    "token-lib-sync",
    "token-shadow",
    "token-typography-row",
];

/// An enabled flag set.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FlagSet {
    names: BTreeSet<String>,
}

impl FlagSet {
    /// A set with every flag from [`DEFAULT_FLAGS`] enabled.
    #[must_use]
    pub fn with_defaults() -> Self {
        Self {
            names: DEFAULT_FLAGS
                .iter()
                .map(|name| (*name).to_owned())
                .collect(),
        }
    }

    /// Apply one token. `enable-x` inserts `x`, `disable-x` removes it, and
    /// any other token is ignored, matching `flags/parse`.
    pub fn apply(&mut self, token: &str) {
        let token = token.trim().trim_start_matches(':');
        if let Some(name) = token.strip_prefix("enable-") {
            if !name.is_empty() {
                self.names.insert(name.to_owned());
            }
        } else if let Some(name) = token.strip_prefix("disable-") {
            if !name.is_empty() {
                self.names.remove(name);
            }
        }
    }

    /// Apply tokens in order.
    pub fn apply_all<'a, I>(&mut self, tokens: I)
    where
        I: IntoIterator<Item = &'a str>,
    {
        for token in tokens {
            self.apply(token);
        }
    }

    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.names.contains(name)
    }

    pub fn insert(&mut self, name: impl Into<String>) {
        self.names.insert(name.into());
    }

    pub fn remove(&mut self, name: &str) {
        self.names.remove(name);
    }

    pub fn iter(&self) -> impl Iterator<Item = &str> {
        self.names.iter().map(String::as_str)
    }

    #[must_use]
    pub fn len(&self) -> usize {
        self.names.len()
    }

    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.names.is_empty()
    }

    #[must_use]
    pub fn as_set(&self) -> &BTreeSet<String> {
        &self.names
    }

    /// Enabled names that are not listed in [`ALL_FLAGS`]. The CLJC source has
    /// a few default-only names (`export-file-v3`, `link-unfurl`, …); this
    /// method makes that difference visible rather than dropping it.
    pub fn not_in_all_flags(&self) -> impl Iterator<Item = &str> {
        self.names
            .iter()
            .map(String::as_str)
            .filter(|name| ALL_FLAGS.binary_search(name).is_err())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tables_are_sorted_and_unique() {
        assert!(ALL_FLAGS.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(DEFAULT_FLAGS.windows(2).all(|pair| pair[0] < pair[1]));
    }

    #[test]
    fn enable_and_disable_apply_in_order() {
        let mut flags = FlagSet::with_defaults();
        flags.apply_all(["enable-mcp", "disable-login-with-password"]);
        assert!(flags.contains("mcp"));
        assert!(!flags.contains("login-with-password"));

        flags.apply("enable-login-with-password");
        assert!(flags.contains("login-with-password"));

        flags.apply("disable-mcp");
        assert!(!flags.contains("mcp"));
    }

    #[test]
    fn unknown_flag_names_are_kept_and_reported() {
        let mut flags = FlagSet::default();
        flags.apply("enable-not-a-real-flag");
        assert!(flags.contains("not-a-real-flag"));
        assert_eq!(
            flags.not_in_all_flags().collect::<Vec<_>>(),
            vec!["not-a-real-flag"]
        );
    }

    #[test]
    fn noise_tokens_are_ignored() {
        let mut flags = FlagSet::default();
        flags.apply_all(["", ":enable-x", "enable-", "nonsense", "disable-y"]);
        assert!(flags.contains("x"));
        assert_eq!(flags.len(), 1);
    }
}
