//! URL and address checks that mirror `app.util.ssrf`.
//!
//! A webhook URI is user input, so the server must not connect to loopback,
//! private, link-local, multicast, cloud-metadata or transition ranges. The
//! check is all-or-nothing per host: if any resolved address is blocked, the
//! request is rejected.
//!
//! Two deliberate differences from the JVM version:
//!
//! * an IPv4-mapped IPv6 address is checked through its embedded IPv4
//!   address, so `::ffff:10.0.0.1` is blocked like `10.0.0.1`;
//! * the validated addresses are returned so the transport can pin them
//!   instead of resolving the name a second time.

use std::collections::BTreeSet;
use std::net::{IpAddr, Ipv4Addr, Ipv6Addr, SocketAddr};

use url::{Host, Url};

/// A refused outbound URI.
///
/// `hint` keeps the Clojure wording because `interpret-exception` embeds it in
/// the delivery error code (`blocked-request:<hint>`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SsrfBlocked {
    hint: &'static str,
}

impl SsrfBlocked {
    const fn new(hint: &'static str) -> Self {
        Self { hint }
    }

    /// The reason, without any resolved address (which would leak network
    /// topology into a delivery record).
    #[must_use]
    pub fn hint(&self) -> &'static str {
        self.hint
    }
}

impl std::fmt::Display for SsrfBlocked {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(self.hint)
    }
}

impl std::error::Error for SsrfBlocked {}

/// Blocklist plus the operator allowlist from `PENPOT_SSRF_ALLOWED_HOSTS`.
#[derive(Debug, Clone, Default)]
pub struct SsrfPolicy {
    allowed_hosts: BTreeSet<String>,
    extra_blocked_cidrs: Vec<Cidr4>,
}

impl SsrfPolicy {
    /// Build a policy from the two configuration sets.
    ///
    /// Invalid CIDRs are ignored, the same way `parse-cidr` logs and drops
    /// them at startup.
    #[must_use]
    pub fn new(allowed_hosts: BTreeSet<String>, extra_blocked_cidrs: &BTreeSet<String>) -> Self {
        Self {
            allowed_hosts: allowed_hosts
                .into_iter()
                .map(|host| host.to_ascii_lowercase())
                .collect(),
            extra_blocked_cidrs: extra_blocked_cidrs
                .iter()
                .filter_map(|cidr| Cidr4::parse(cidr))
                .collect(),
        }
    }

    /// Read `ssrf-allowed-hosts` and `ssrf-extra-blocked-cidrs`.
    #[must_use]
    pub fn from_config(config: &config::Config) -> Self {
        let allowed = config
            .set("ssrf-allowed-hosts")
            .cloned()
            .unwrap_or_default();
        let extra = config
            .set("ssrf-extra-blocked-cidrs")
            .cloned()
            .unwrap_or_default();
        Self::new(allowed, &extra)
    }

    /// Whether the host bypasses the address check.
    #[must_use]
    pub fn allows_host(&self, host: &str) -> bool {
        self.allowed_hosts.contains(&host.to_ascii_lowercase())
    }

    /// Validate `url` and return the addresses the caller should connect to.
    ///
    /// An allowlisted host returns an empty list: the operator vouched for the
    /// name, so the transport may resolve it normally.
    ///
    /// # Errors
    ///
    /// Returns the refusal reason for a bad scheme, a missing host, a host
    /// that does not resolve, or any blocked address.
    pub async fn resolve(&self, url: &Url) -> Result<Vec<SocketAddr>, SsrfBlocked> {
        if !matches!(url.scheme(), "http" | "https") {
            return Err(SsrfBlocked::new("url scheme is not allowed"));
        }
        let Some(host) = url.host() else {
            return Err(SsrfBlocked::new("url host is missing"));
        };
        let host_text = url
            .host_str()
            .ok_or_else(|| SsrfBlocked::new("url host is missing"))?;
        if self.allows_host(host_text) {
            return Ok(Vec::new());
        }

        let port = url.port_or_known_default().unwrap_or(80);
        let addresses = match host {
            Host::Ipv4(ip) => vec![SocketAddr::new(IpAddr::V4(ip), port)],
            Host::Ipv6(ip) => vec![SocketAddr::new(IpAddr::V6(ip), port)],
            Host::Domain(name) => {
                let resolved: Vec<SocketAddr> = tokio::net::lookup_host((name, port))
                    .await
                    .map_err(|_| SsrfBlocked::new("uri host could not be resolved"))?
                    .collect();
                if resolved.is_empty() {
                    return Err(SsrfBlocked::new("uri host could not be resolved"));
                }
                resolved
            }
        };

        if addresses.iter().any(|address| self.blocks(address.ip())) {
            return Err(SsrfBlocked::new("uri target is not allowed"));
        }
        Ok(addresses)
    }

    /// Whether one address is on the blocklist.
    #[must_use]
    pub fn blocks(&self, ip: IpAddr) -> bool {
        match ip {
            IpAddr::V4(ip) => {
                blocks_v4(ip)
                    || self
                        .extra_blocked_cidrs
                        .iter()
                        .any(|cidr| cidr.contains(ip))
            }
            IpAddr::V6(ip) => {
                if let Some(mapped) = ip.to_ipv4_mapped() {
                    return self.blocks(IpAddr::V4(mapped));
                }
                blocks_v6(ip)
            }
        }
    }
}

/// Whether `ip` is blocked by the fixed ranges alone.
#[must_use]
pub fn blocks(ip: IpAddr) -> bool {
    SsrfPolicy::default().blocks(ip)
}

fn blocks_v4(ip: Ipv4Addr) -> bool {
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_link_local()
        || ip.is_private()
        || ip.is_broadcast()
        || ip.is_documentation()
        || ip.is_multicast()
        // Carrier-grade NAT.
        || in_range(ip, [100, 64, 0, 0], 10)
        // IETF protocol assignments; `is_documentation` covers 192.0.2/24.
        || in_range(ip, [192, 0, 0, 0], 24)
        // Benchmarking.
        || in_range(ip, [198, 18, 0, 0], 15)
        // Reserved / future use.
        || in_range(ip, [240, 0, 0, 0], 4)
}

fn blocks_v6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    ip.is_unspecified()
        || ip.is_loopback()
        || ip.is_unique_local()
        || ip.is_unicast_link_local()
        || ip.is_multicast()
        // NAT64 64:ff9b::/96.
        || (segments[0] == 0x0064 && segments[1] == 0xff9b)
        // 6to4 2002::/16.
        || segments[0] == 0x2002
        // Teredo 2001:0000::/32.
        || (segments[0] == 0x2001 && segments[1] == 0x0000)
}

fn in_range(ip: Ipv4Addr, base: [u8; 4], prefix: u32) -> bool {
    Cidr4::new(Ipv4Addr::from(base), prefix).contains(ip)
}

/// An IPv4 CIDR range from `PENPOT_SSRF_EXTRA_BLOCKED_CIDRS`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Cidr4 {
    base: u32,
    mask: u32,
}

impl Cidr4 {
    fn new(address: Ipv4Addr, prefix: u32) -> Self {
        let mask = if prefix == 0 {
            0
        } else {
            u32::MAX << (32 - prefix)
        };
        Self {
            base: u32::from(address) & mask,
            mask,
        }
    }

    fn parse(text: &str) -> Option<Self> {
        let (address, prefix) = text.split_once('/')?;
        let address: Ipv4Addr = address.trim().parse().ok()?;
        let prefix: u32 = prefix.trim().parse().ok()?;
        if prefix > 32 {
            return None;
        }
        Some(Self::new(address, prefix))
    }

    fn contains(self, ip: Ipv4Addr) -> bool {
        u32::from(ip) & self.mask == self.base
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy() -> SsrfPolicy {
        SsrfPolicy::default()
    }

    #[test]
    fn fixed_ranges_are_blocked() {
        for text in [
            "127.0.0.1",
            "10.1.2.3",
            "172.16.0.1",
            "192.168.1.1",
            "169.254.169.254",
            "100.64.0.1",
            "192.0.0.5",
            "198.18.0.1",
            "240.0.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
            "64:ff9b::1",
            "2002::1",
            "2001:0::1",
            "::ffff:127.0.0.1",
            "::ffff:10.0.0.1",
        ] {
            let ip: IpAddr = text.parse().expect("ip");
            assert!(policy().blocks(ip), "{text} should be blocked");
        }
    }

    #[test]
    fn public_addresses_are_allowed() {
        for text in ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"] {
            let ip: IpAddr = text.parse().expect("ip");
            assert!(!policy().blocks(ip), "{text} should be allowed");
        }
    }

    #[test]
    fn operator_cidrs_add_to_the_blocklist() {
        let extra = BTreeSet::from(["1.0.0.0/8".to_owned()]);
        let policy = SsrfPolicy::new(BTreeSet::new(), &extra);
        assert!(policy.blocks("1.2.3.4".parse().expect("ip")));
        assert!(!policy.blocks("2.2.3.4".parse().expect("ip")));
    }

    #[test]
    fn invalid_cidrs_are_ignored() {
        let extra = BTreeSet::from(["not-a-cidr".to_owned(), "1.0.0.0/33".to_owned()]);
        let policy = SsrfPolicy::new(BTreeSet::new(), &extra);
        assert!(!policy.blocks("1.2.3.4".parse().expect("ip")));
    }

    #[tokio::test]
    async fn schemes_other_than_http_are_refused() {
        let url = Url::parse("ftp://example.com/file").expect("url");
        let error = policy().resolve(&url).await.expect_err("scheme");
        assert_eq!(error.hint(), "url scheme is not allowed");
    }

    #[tokio::test]
    async fn loopback_is_refused_without_the_allowlist() {
        let url = Url::parse("http://127.0.0.1/hook").expect("url");
        let error = policy().resolve(&url).await.expect_err("loopback");
        assert_eq!(error.hint(), "uri target is not allowed");
    }

    #[tokio::test]
    async fn the_allowlist_bypasses_the_address_check() {
        let allowed = BTreeSet::from(["127.0.0.1".to_owned()]);
        let policy = SsrfPolicy::new(allowed, &BTreeSet::new());
        let url = Url::parse("http://127.0.0.1/hook").expect("url");
        assert!(policy.resolve(&url).await.expect("allowed").is_empty());
    }

    #[tokio::test]
    async fn localhost_resolves_to_a_blocked_address() {
        let url = Url::parse("http://localhost/hook").expect("url");
        let error = policy().resolve(&url).await.expect_err("localhost");
        assert_eq!(error.hint(), "uri target is not allowed");
    }
}
