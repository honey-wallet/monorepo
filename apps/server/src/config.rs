use std::{
    env,
    net::{IpAddr, Ipv4Addr, SocketAddr},
};

use axum::http::HeaderValue;

/// Runtime configuration, read from environment variables.
///
/// See `apps/server/.env.example` for the full list.
#[derive(Debug, Clone)]
pub struct Config {
    pub server_role: ServerRole,
    pub host: IpAddr,
    pub port: u16,
    pub cors_allowed_origins: Vec<HeaderValue>,
    pub request_timeout_secs: u64,
    /// Trust `X-Forwarded-For` for the client IP (only behind a proxy that sets it).
    pub trust_proxy_headers: bool,
    /// Network ranges allowed to supply X-Forwarded-For when proxy trust is enabled.
    pub trusted_proxy_cidrs: Vec<TrustedProxyCidr>,
    pub max_in_flight_requests: usize,
    pub max_request_body_bytes: usize,
    /// Require both durable and ephemeral infrastructure before serving.
    pub require_infrastructure: bool,
    pub database_url: Option<SecretUrl>,
    pub redis_url: Option<SecretUrl>,
    pub redis_namespace: String,
    pub database_max_connections: u32,
    pub database_statement_timeout_ms: u64,
    pub dependency_timeout_ms: u64,
    pub shutdown_timeout_secs: u64,
    /// Explicit relying-party origin and chain. Absent means auth is disabled.
    pub auth: Option<AuthConfig>,
    pub metrics_addr: Option<SocketAddr>,
    pub otlp_traces_endpoint: Option<SecretUrl>,
    pub trace_sample_per_mille: u16,
    pub prices_enabled: bool,
    pub aave_execution_config_file: Option<String>,
    pub morpho_execution_config_file: Option<String>,
    pub uniswap_quote_config_file: Option<String>,
    pub uniswap_execution_config_file: Option<String>,
    pub bridge_status_config_file: Option<String>,
    pub across_quote_config_file: Option<String>,
    pub across_execution_config_file: Option<String>,
    pub earn_read_targets: Vec<crate::earn_catalog::ReadProductConfig>,
    pub price_max_connections: usize,
    pub price_max_connections_per_ip: usize,
}

/// Process responsibilities. Split roles share Redis and durable provider state.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ServerRole {
    #[default]
    Combined,
    Api,
    Worker,
}

impl ServerRole {
    pub fn serves_api(self) -> bool {
        matches!(self, Self::Combined | Self::Api)
    }

    pub fn runs_workers(self) -> bool {
        matches!(self, Self::Combined | Self::Worker)
    }
}

impl std::str::FromStr for ServerRole {
    type Err = ConfigError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "combined" => Ok(Self::Combined),
            "api" => Ok(Self::Api),
            "worker" => Ok(Self::Worker),
            _ => Err(ConfigError::Invalid {
                name: "SERVER_ROLE",
            }),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TrustedProxyCidr {
    network: IpAddr,
    prefix: u8,
}

impl TrustedProxyCidr {
    pub fn parse(raw: &str) -> Option<Self> {
        let (address, prefix) = match raw.split_once('/') {
            Some((address, prefix)) if !prefix.is_empty() => {
                (address.parse::<IpAddr>().ok()?, prefix.parse::<u8>().ok()?)
            }
            Some(_) => return None,
            None => {
                let network = raw.parse::<IpAddr>().ok()?;
                let prefix = if network.is_ipv4() { 32 } else { 128 };
                (raw.parse().ok()?, prefix)
            }
        };
        let max = if address.is_ipv4() { 32 } else { 128 };
        (prefix <= max).then_some(Self {
            network: address,
            prefix,
        })
    }

    pub fn contains(&self, peer: IpAddr) -> bool {
        match (self.network, peer.to_canonical()) {
            (IpAddr::V4(network), IpAddr::V4(peer)) => {
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u32::MAX << (32 - self.prefix)
                };
                u32::from(network) & mask == u32::from(peer) & mask
            }
            (IpAddr::V6(network), IpAddr::V6(peer)) => {
                let network = u128::from(network);
                let peer = u128::from(peer);
                let mask = if self.prefix == 0 {
                    0
                } else {
                    u128::MAX << (128 - self.prefix)
                };
                network & mask == peer & mask
            }
            _ => false,
        }
    }
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    /// Primary SIWE origin for originless native clients and legacy deployments.
    pub origin: String,
    /// Additional exact browser origins; CORS remains a separate allowlist.
    pub additional_origins: Vec<String>,
    pub chain_id: i64,
}

impl AuthConfig {
    pub fn domain(&self) -> Result<String, ConfigError> {
        let primary_domain = Self::validate_origin(&self.origin)?;
        if self.additional_origins.len() > 7 {
            return Err(ConfigError::Invalid {
                name: "AUTH_ADDITIONAL_ORIGINS",
            });
        }
        let mut seen = std::collections::HashSet::from([self.origin.as_str()]);
        for origin in &self.additional_origins {
            if !seen.insert(origin.as_str()) {
                return Err(ConfigError::Invalid {
                    name: "AUTH_ADDITIONAL_ORIGINS",
                });
            }
            Self::validate_origin(origin)?;
        }
        if self.chain_id <= 0 {
            return Err(ConfigError::Invalid {
                name: "AUTH_CHAIN_ID",
            });
        }
        Ok(primary_domain)
    }

    fn validate_origin(origin: &str) -> Result<String, ConfigError> {
        let invalid = || ConfigError::Invalid {
            name: "AUTH_ORIGIN/AUTH_ADDITIONAL_ORIGINS",
        };
        let uri: axum::http::Uri = origin.parse().map_err(|_| invalid())?;
        let authority = uri.authority().ok_or_else(invalid)?;
        let local = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"));
        let extension = uri.scheme_str() == Some("chrome-extension")
            && uri.host().is_some_and(|host| {
                host.len() == 32 && host.bytes().all(|c| (b'a'..=b'p').contains(&c))
            });
        if !(uri.scheme_str() == Some("https")
            || (local && uri.scheme_str() == Some("http"))
            || extension)
            || authority.as_str().contains('@')
            || origin.contains('#')
            || uri.path() != "/"
            || uri.query().is_some()
            || origin.ends_with('/')
            || origin.len() > 256
        {
            return Err(invalid());
        }
        Ok(authority.as_str().to_owned())
    }

    pub fn allows_origin(&self, origin: &str) -> bool {
        self.origin == origin || self.additional_origins.iter().any(|value| value == origin)
    }

    pub fn domain_for_origin(&self, origin: &str) -> Result<String, ConfigError> {
        if !self.allows_origin(origin) {
            return Err(ConfigError::Invalid {
                name: "AUTH_ORIGIN/AUTH_ADDITIONAL_ORIGINS",
            });
        }
        Self::validate_origin(origin)
    }
}

/// Connection strings contain credentials; never derive Debug over their contents.
#[derive(Clone)]
pub struct SecretUrl(String);

impl SecretUrl {
    pub fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl std::fmt::Debug for SecretUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("[REDACTED]")
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{name} has an invalid or out-of-range value")]
    Invalid { name: &'static str },
    #[error("{name} is required when REQUIRE_INFRASTRUCTURE=true")]
    Missing { name: &'static str },
}

impl Default for Config {
    fn default() -> Self {
        Self {
            server_role: ServerRole::Combined,
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 8080,
            cors_allowed_origins: DEFAULT_CORS_ORIGINS
                .iter()
                .map(|o| HeaderValue::from_static(o))
                .collect(),
            request_timeout_secs: 30,
            trust_proxy_headers: false,
            trusted_proxy_cidrs: vec![],
            max_in_flight_requests: 256,
            max_request_body_bytes: 64 * 1024,
            require_infrastructure: false,
            database_url: None,
            redis_url: None,
            redis_namespace: "honey:v1".into(),
            database_max_connections: 20,
            database_statement_timeout_ms: 5000,
            dependency_timeout_ms: 1_000,
            shutdown_timeout_secs: 15,
            auth: None,
            metrics_addr: None,
            otlp_traces_endpoint: None,
            trace_sample_per_mille: 100,
            prices_enabled: false,
            aave_execution_config_file: None,
            morpho_execution_config_file: None,
            uniswap_quote_config_file: None,
            uniswap_execution_config_file: None,
            bridge_status_config_file: None,
            across_quote_config_file: None,
            across_execution_config_file: None,
            earn_read_targets: vec![],
            price_max_connections: 10_000,
            price_max_connections_per_ip: 64,
        }
    }
}

/// Vite dev server and Expo web dev server.
const DEFAULT_CORS_ORIGINS: &[&str] = &["http://localhost:5173", "http://localhost:8081"];

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let defaults = Self::default();
        let additional_auth_origins = match env::var("AUTH_ADDITIONAL_ORIGINS") {
            Ok(raw) if raw.trim().is_empty() => vec![],
            Ok(raw) => raw.split(',').map(str::trim).map(str::to_owned).collect(),
            Err(env::VarError::NotPresent) => vec![],
            Err(_) => {
                return Err(ConfigError::Invalid {
                    name: "AUTH_ADDITIONAL_ORIGINS",
                });
            }
        };
        let config = Self {
            server_role: parse_var("SERVER_ROLE")?.unwrap_or(defaults.server_role),
            aave_execution_config_file: env::var("AAVE_EXECUTION_CONFIG_FILE").ok(),
            morpho_execution_config_file: env::var("MORPHO_EXECUTION_CONFIG_FILE").ok(),
            uniswap_quote_config_file: env::var("UNISWAP_QUOTE_CONFIG_FILE").ok(),
            uniswap_execution_config_file: env::var("UNISWAP_EXECUTION_CONFIG_FILE").ok(),
            bridge_status_config_file: env::var("BRIDGE_STATUS_CONFIG_FILE").ok(),
            across_quote_config_file: env::var("ACROSS_QUOTE_CONFIG_FILE").ok(),
            across_execution_config_file: env::var("ACROSS_EXECUTION_CONFIG_FILE").ok(),
            host: parse_var("HOST")?.unwrap_or(defaults.host),
            port: parse_var("PORT")?.unwrap_or(defaults.port),
            cors_allowed_origins: match env::var("CORS_ALLOWED_ORIGINS") {
                Ok(raw) => parse_origins(&raw)?,
                Err(_) => defaults.cors_allowed_origins,
            },
            request_timeout_secs: parse_var("REQUEST_TIMEOUT_SECS")?
                .unwrap_or(defaults.request_timeout_secs),
            trust_proxy_headers: parse_var("TRUST_PROXY_HEADERS")?
                .unwrap_or(defaults.trust_proxy_headers),
            trusted_proxy_cidrs: match env::var("TRUSTED_PROXY_CIDRS") {
                Ok(raw) => parse_trusted_proxy_cidrs(&raw)?,
                Err(env::VarError::NotPresent) => vec![],
                Err(_) => {
                    return Err(ConfigError::Invalid {
                        name: "TRUSTED_PROXY_CIDRS",
                    });
                }
            },
            max_in_flight_requests: parse_var("MAX_IN_FLIGHT_REQUESTS")?
                .unwrap_or(defaults.max_in_flight_requests),
            max_request_body_bytes: parse_var("MAX_REQUEST_BODY_BYTES")?
                .unwrap_or(defaults.max_request_body_bytes),
            require_infrastructure: parse_var("REQUIRE_INFRASTRUCTURE")?.unwrap_or(false),
            database_url: secret_var("DATABASE_URL")?,
            redis_url: secret_var("REDIS_URL")?,
            redis_namespace: env::var("REDIS_NAMESPACE").unwrap_or(defaults.redis_namespace),
            database_max_connections: parse_var("DATABASE_MAX_CONNECTIONS")?
                .unwrap_or(defaults.database_max_connections),
            database_statement_timeout_ms: parse_var("DATABASE_STATEMENT_TIMEOUT_MS")?
                .unwrap_or(defaults.database_statement_timeout_ms),
            dependency_timeout_ms: parse_var("DEPENDENCY_TIMEOUT_MS")?
                .unwrap_or(defaults.dependency_timeout_ms),
            shutdown_timeout_secs: parse_var("SHUTDOWN_TIMEOUT_SECS")?
                .unwrap_or(defaults.shutdown_timeout_secs),
            auth: match (env::var("AUTH_ORIGIN"), parse_var("AUTH_CHAIN_ID")?) {
                (Err(env::VarError::NotPresent), None) if additional_auth_origins.is_empty() => {
                    None
                }
                (Ok(origin), Some(chain_id)) => Some(AuthConfig {
                    origin,
                    additional_origins: additional_auth_origins,
                    chain_id,
                }),
                _ => {
                    return Err(ConfigError::Invalid {
                        name: "AUTH_ORIGIN/AUTH_ADDITIONAL_ORIGINS/AUTH_CHAIN_ID",
                    });
                }
            },
            metrics_addr: parse_var("METRICS_ADDR")?,
            otlp_traces_endpoint: secret_var("HONEY_OTLP_TRACES_ENDPOINT")?,
            trace_sample_per_mille: parse_var("TRACE_SAMPLE_PER_MILLE")?
                .unwrap_or(defaults.trace_sample_per_mille),
            earn_read_targets: match env::var("EARN_READ_TARGETS") {
                Ok(raw) => {
                    crate::earn_catalog::parse_registry(&raw).map_err(|_| ConfigError::Invalid {
                        name: "EARN_READ_TARGETS",
                    })?
                }
                Err(env::VarError::NotPresent) => vec![],
                Err(_) => {
                    return Err(ConfigError::Invalid {
                        name: "EARN_READ_TARGETS",
                    });
                }
            },
            prices_enabled: parse_var("PRICES_ENABLED")?.unwrap_or(false),
            price_max_connections: parse_var("PRICE_MAX_CONNECTIONS")?
                .unwrap_or(defaults.price_max_connections),
            price_max_connections_per_ip: parse_var("PRICE_MAX_CONNECTIONS_PER_IP")?
                .unwrap_or(defaults.price_max_connections_per_ip),
        };
        config.validate()?;
        Ok(config)
    }

    pub fn validate(&self) -> Result<(), ConfigError> {
        // Split deployments must never fall back to process-local pairing state.
        // PostgreSQL remains feature-dependent (e.g. public price-only workers).
        if self.server_role != ServerRole::Combined && self.redis_url.is_none() {
            return Err(ConfigError::Invalid {
                name: "SERVER_ROLE/REDIS_URL",
            });
        }

        if (self.trust_proxy_headers && self.trusted_proxy_cidrs.is_empty())
            || self.trusted_proxy_cidrs.len() > 32
        {
            return Err(ConfigError::Invalid {
                name: "TRUST_PROXY_HEADERS/TRUSTED_PROXY_CIDRS",
            });
        }
        // Retired provider settings fail visibly rather than silently enabling legacy execution.
        if self.across_execution_config_file.is_some() || self.across_quote_config_file.is_some() {
            return Err(ConfigError::Invalid {
                name: "Across is retired; use NEAR_INTENTS_API_KEY for previews",
            });
        }
        if self.bridge_status_config_file.is_some()
            && (self.database_url.is_none() || self.redis_url.is_none() || self.auth.is_none())
        {
            return Err(ConfigError::Invalid {
                name: "BRIDGE_STATUS_CONFIG_FILE",
            });
        }
        if self.uniswap_quote_config_file.is_some()
            && (self.database_url.is_none() || self.redis_url.is_none() || self.auth.is_none())
        {
            return Err(ConfigError::Invalid {
                name: "UNISWAP_QUOTE_CONFIG_FILE",
            });
        }
        if self.uniswap_execution_config_file.is_some()
            && (self.database_url.is_none()
                || self.redis_url.is_none()
                || !self.host.is_loopback()
                || self.auth.as_ref().is_none_or(|a| a.chain_id != 31337)
                || self.uniswap_quote_config_file.is_some()
                || self.max_request_body_bytes < 192 * 1024)
        {
            return Err(ConfigError::Invalid {
                name: "UNISWAP_EXECUTION_CONFIG_FILE",
            });
        }
        if self.aave_execution_config_file.is_some()
            && (self.database_url.is_none()
                || self.redis_url.is_none()
                || !self.host.is_loopback()
                || self.auth.as_ref().is_none_or(|a| a.chain_id != 31337))
        {
            return Err(ConfigError::Invalid {
                name: "AAVE_EXECUTION_CONFIG_FILE",
            });
        }
        if self.morpho_execution_config_file.is_some()
            && (self.database_url.is_none()
                || self.redis_url.is_none()
                || !self.host.is_loopback()
                || self.auth.as_ref().is_none_or(|a| a.chain_id != 31337))
        {
            return Err(ConfigError::Invalid {
                name: "MORPHO_EXECUTION_CONFIG_FILE",
            });
        }

        if self.trace_sample_per_mille > 1000 {
            return Err(ConfigError::Invalid {
                name: "TRACE_SAMPLE_PER_MILLE",
            });
        }
        if self.metrics_addr.is_some_and(|addr| {
            addr.port() == 0 || addr == self.socket_addr() || !addr.ip().is_loopback()
        }) {
            return Err(ConfigError::Invalid {
                name: "METRICS_ADDR",
            });
        }
        if let Some(endpoint) = &self.otlp_traces_endpoint {
            let bad = || ConfigError::Invalid {
                name: "HONEY_OTLP_TRACES_ENDPOINT",
            };
            let uri: axum::http::Uri = endpoint.expose().parse().map_err(|_| bad())?;
            let local = matches!(uri.host(), Some("localhost" | "127.0.0.1" | "[::1]"));
            if endpoint.expose().len() > 2048
                || endpoint.expose().contains(['@', '#'])
                || uri.query().is_some()
                || uri.host().is_none()
                || uri.path() != "/v1/traces"
                || !(uri.scheme_str() == Some("https")
                    || (local && uri.scheme_str() == Some("http")))
            {
                return Err(bad());
            }
        }
        if !crate::earn_catalog::validate_registry(&self.earn_read_targets) {
            return Err(ConfigError::Invalid {
                name: "EARN_READ_TARGETS",
            });
        }
        if (self.prices_enabled || !self.earn_read_targets.is_empty()) && self.redis_url.is_none() {
            return Err(ConfigError::Invalid { name: "REDIS_URL" });
        }
        if !(1..=50_000).contains(&self.price_max_connections)
            || !(1..=50_000).contains(&self.price_max_connections_per_ip)
        {
            return Err(ConfigError::Invalid {
                name: "PRICE_MAX_CONNECTIONS/PRICE_MAX_CONNECTIONS_PER_IP",
            });
        }
        if self.redis_namespace.is_empty()
            || self.redis_namespace.len() > 48
            || !self
                .redis_namespace
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b":_-".contains(&b))
        {
            return Err(ConfigError::Invalid {
                name: "REDIS_NAMESPACE",
            });
        }
        if let Some(auth) = &self.auth {
            auth.domain()?;
            if self.database_url.is_none() {
                return Err(ConfigError::Invalid {
                    name: "DATABASE_URL",
                });
            }
            if !self.host.is_loopback() && self.redis_url.is_none() {
                return Err(ConfigError::Invalid { name: "REDIS_URL" });
            }
            if !auth.additional_origins.is_empty()
                && auth
                    .additional_origins
                    .iter()
                    .chain(std::iter::once(&auth.origin))
                    .any(|origin| {
                        !self
                            .cors_allowed_origins
                            .iter()
                            .any(|allowed| allowed.to_str().ok() == Some(origin.as_str()))
                    })
            {
                return Err(ConfigError::Invalid {
                    name: "CORS_ALLOWED_ORIGINS",
                });
            }
        }
        for (name, valid) in [
            (
                "REQUEST_TIMEOUT_SECS",
                (1..=120).contains(&self.request_timeout_secs),
            ),
            (
                "MAX_IN_FLIGHT_REQUESTS",
                (1..=10_000).contains(&self.max_in_flight_requests),
            ),
            (
                "MAX_REQUEST_BODY_BYTES",
                (1024..=1024 * 1024).contains(&self.max_request_body_bytes),
            ),
            (
                "DATABASE_MAX_CONNECTIONS",
                (1..=100).contains(&self.database_max_connections),
            ),
            (
                "DATABASE_STATEMENT_TIMEOUT_MS",
                (100..=60_000).contains(&self.database_statement_timeout_ms),
            ),
            (
                "DEPENDENCY_TIMEOUT_MS",
                (50..=10_000).contains(&self.dependency_timeout_ms),
            ),
            (
                "SHUTDOWN_TIMEOUT_SECS",
                (1..=120).contains(&self.shutdown_timeout_secs),
            ),
        ] {
            if !valid {
                return Err(ConfigError::Invalid { name });
            }
        }
        if self.require_infrastructure {
            for (name, value) in [
                ("DATABASE_URL", &self.database_url),
                ("REDIS_URL", &self.redis_url),
            ] {
                if value.is_none() {
                    return Err(ConfigError::Missing { name });
                }
            }
        }
        Ok(())
    }

    pub fn socket_addr(&self) -> SocketAddr {
        SocketAddr::new(self.host, self.port)
    }
}

fn parse_var<T: std::str::FromStr>(name: &'static str) -> Result<Option<T>, ConfigError> {
    match env::var(name) {
        Ok(value) => value
            .parse()
            .map(Some)
            .map_err(|_| ConfigError::Invalid { name }),
        Err(env::VarError::NotPresent) => Ok(None),
        Err(_) => Err(ConfigError::Invalid { name }),
    }
}

fn secret_var(name: &'static str) -> Result<Option<SecretUrl>, ConfigError> {
    match env::var(name) {
        Ok(value) if !value.trim().is_empty() => Ok(Some(SecretUrl::new(value))),
        Err(env::VarError::NotPresent) => Ok(None),
        _ => Err(ConfigError::Invalid { name }),
    }
}

fn parse_origins(raw: &str) -> Result<Vec<HeaderValue>, ConfigError> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|origin| {
            HeaderValue::from_str(origin).map_err(|_| ConfigError::Invalid {
                name: "CORS_ALLOWED_ORIGINS",
            })
        })
        .collect()
}

fn parse_trusted_proxy_cidrs(raw: &str) -> Result<Vec<TrustedProxyCidr>, ConfigError> {
    if raw.len() > 2048 {
        return Err(ConfigError::Invalid {
            name: "TRUSTED_PROXY_CIDRS",
        });
    }
    let values = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(TrustedProxyCidr::parse)
        .collect::<Option<Vec<_>>>()
        .ok_or(ConfigError::Invalid {
            name: "TRUSTED_PROXY_CIDRS",
        })?;
    if values.len() > 32 {
        return Err(ConfigError::Invalid {
            name: "TRUSTED_PROXY_CIDRS",
        });
    }
    Ok(values)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn telemetry_requires_bounded_sampling_and_an_explicit_safe_collector_endpoint() {
        for url in [
            "http://external.example/v1/traces",
            "https://user:secret@example.com/v1/traces",
            "https://example.com/v1/traces?token=secret",
            "https://example.com/v1/traces#fragment",
            "https://example.com/other",
        ] {
            assert!(
                Config {
                    otlp_traces_endpoint: Some(SecretUrl::new(url.into())),
                    ..Config::default()
                }
                .validate()
                .is_err()
            );
        }
        for url in [
            "http://127.0.0.1:4318/v1/traces",
            "https://collector.example.com/v1/traces",
        ] {
            assert!(
                Config {
                    otlp_traces_endpoint: Some(SecretUrl::new(url.into())),
                    ..Config::default()
                }
                .validate()
                .is_ok()
            );
        }
        assert!(
            Config {
                trace_sample_per_mille: 1001,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Config {
                metrics_addr: Some("127.0.0.1:8080".parse().unwrap()),
                ..Config::default()
            }
            .validate()
            .is_err()
        );
        for address in ["0.0.0.0:29090", "192.168.1.5:29090", "[::]:29090"] {
            assert!(
                Config {
                    metrics_addr: Some(address.parse().unwrap()),
                    ..Config::default()
                }
                .validate()
                .is_err(),
                "metrics listener must reject externally reachable address {address}"
            );
        }
        assert!(
            Config {
                metrics_addr: Some("127.0.0.1:29090".parse().unwrap()),
                ..Config::default()
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn parses_comma_separated_origins() {
        let origins = parse_origins("http://a.test, http://b.test,,").unwrap();
        assert_eq!(origins, vec!["http://a.test", "http://b.test"]);
    }

    #[test]
    fn trusted_proxy_ranges_parse_and_match_only_the_configured_network() {
        let ranges = parse_trusted_proxy_cidrs("10.20.0.0/16, 127.0.0.1").unwrap();
        assert!(ranges[0].contains("10.20.12.4".parse().unwrap()));
        assert!(!ranges[0].contains("10.21.12.4".parse().unwrap()));
        assert!(ranges[1].contains("127.0.0.1".parse().unwrap()));
        assert!(!ranges[1].contains("127.0.0.2".parse().unwrap()));
        assert!(
            parse_trusted_proxy_cidrs("2001:db8:1234::/48").unwrap()[0]
                .contains("2001:db8:1234:ffff::1".parse().unwrap())
        );
        assert!(parse_trusted_proxy_cidrs("10.0.0.0/33").is_err());
        assert!(parse_trusted_proxy_cidrs("not-an-ip").is_err());
    }

    #[test]
    fn forwarded_header_trust_requires_explicit_proxy_networks() {
        assert!(
            Config {
                trust_proxy_headers: true,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Config {
                trust_proxy_headers: true,
                trusted_proxy_cidrs: parse_trusted_proxy_cidrs("127.0.0.1/32").unwrap(),
                ..Config::default()
            }
            .validate()
            .is_ok()
        );
        assert!(
            Config {
                trust_proxy_headers: false,
                trusted_proxy_cidrs: parse_trusted_proxy_cidrs("127.0.0.1/32").unwrap(),
                ..Config::default()
            }
            .validate()
            .is_ok()
        );
    }

    #[test]
    fn rejects_unbounded_or_disabled_runtime_limits() {
        assert!(
            Config {
                max_in_flight_requests: 0,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Config {
                request_timeout_secs: 0,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Config {
                database_max_connections: 101,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
        assert!(
            Config {
                require_infrastructure: true,
                ..Config::default()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn bridge_observation_requires_identity_and_shared_dependencies() {
        let base = Config {
            bridge_status_config_file: Some("status.json".into()),
            database_url: Some(SecretUrl::new("postgres://localhost/test".into())),
            redis_url: Some(SecretUrl::new("redis://localhost".into())),
            auth: Some(AuthConfig {
                origin: "http://localhost:5173".into(),
                additional_origins: vec![],
                chain_id: 1,
            }),
            ..Config::default()
        };
        assert!(base.validate().is_ok());
        for missing in 0..3 {
            let mut config = base.clone();
            match missing {
                0 => config.database_url = None,
                1 => config.redis_url = None,
                _ => config.auth = None,
            };
            assert!(config.validate().is_err());
        }
    }

    #[test]
    fn retired_across_configuration_is_rejected() {
        for execution in [false, true] {
            let mut config = Config::default();
            if execution {
                config.across_execution_config_file = Some("retired.json".into());
            } else {
                config.across_quote_config_file = Some("retired.json".into());
            }
            assert!(config.validate().is_err());
        }
    }

    #[test]
    fn swap_execution_is_explicit_local_and_has_room_for_bounded_signed_calldata() {
        let base = Config {
            uniswap_execution_config_file: Some("local.json".into()),
            database_url: Some(SecretUrl::new("postgres://localhost/test".into())),
            redis_url: Some(SecretUrl::new("redis://localhost".into())),
            auth: Some(AuthConfig {
                origin: "http://localhost:5173".into(),
                additional_origins: vec![],
                chain_id: 31337,
            }),
            max_request_body_bytes: 192 * 1024,
            ..Config::default()
        };
        assert!(base.validate().is_ok());
        for fault in 0..5 {
            let mut c = base.clone();
            match fault {
                0 => c.host = "0.0.0.0".parse().unwrap(),
                1 => c.auth.as_mut().unwrap().chain_id = 1,
                2 => c.uniswap_quote_config_file = Some("production.json".into()),
                3 => c.max_request_body_bytes = 64 * 1024,
                4 => c.redis_url = None,
                _ => unreachable!(),
            };
            assert!(c.validate().is_err(), "{fault}");
        }
    }

    #[test]
    fn configuration_debug_redacts_connection_credentials() {
        let config = Config {
            database_url: Some(SecretUrl::new(
                "postgres://private-user:private-password@localhost/db".into(),
            )),
            redis_url: Some(SecretUrl::new("redis://:private-password@localhost".into())),
            ..Config::default()
        };
        let rendered = format!("{config:?}");
        assert!(!rendered.contains("private-password"));
        assert!(!rendered.contains("private-user"));
    }

    #[test]
    fn authentication_requires_an_explicit_secure_origin_and_database() {
        for origin in [
            "https://wallet.example",
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop",
        ] {
            assert!(
                AuthConfig {
                    origin: origin.into(),
                    additional_origins: vec![],
                    chain_id: 1
                }
                .domain()
                .is_ok()
            );
        }
        for origin in [
            "http://wallet.example",
            "https://wallet.example/",
            "https://wallet.example/path",
            "https://user:password@wallet.example",
            "https://wallet.example?query",
            "https://wallet.example#fragment",
            "wallet.example",
            "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaz",
            "chrome-extension://abcdefghijklmnopabcdefghijklmnop/path",
        ] {
            assert!(
                AuthConfig {
                    origin: origin.into(),
                    additional_origins: vec![],
                    chain_id: 1
                }
                .domain()
                .is_err(),
                "{origin}"
            );
        }
        assert!(
            AuthConfig {
                origin: "https://wallet.example".into(),
                additional_origins: vec![],
                chain_id: 0
            }
            .domain()
            .is_err()
        );
        let public_without_redis = Config {
            host: "0.0.0.0".parse().unwrap(),
            database_url: Some(SecretUrl::new("postgres://localhost/test".into())),
            auth: Some(AuthConfig {
                origin: "https://wallet.example".into(),
                additional_origins: vec![],
                chain_id: 1,
            }),
            ..Config::default()
        };
        assert!(public_without_redis.validate().is_err());

        let local_fixture_without_redis = Config {
            database_url: Some(SecretUrl::new("postgres://localhost/test".into())),
            auth: Some(AuthConfig {
                origin: "http://localhost:5173".into(),
                additional_origins: vec![],
                chain_id: 1,
            }),
            ..Config::default()
        };
        assert!(local_fixture_without_redis.validate().is_ok());
        assert!(
            Config {
                auth: Some(AuthConfig {
                    origin: "https://wallet.example".into(),
                    additional_origins: vec![],
                    chain_id: 1
                }),
                ..Config::default()
            }
            .validate()
            .is_err()
        );
    }

    #[test]
    fn additional_auth_origins_are_exact_unique_bounded_and_cors_allowed() {
        let extension = format!("chrome-extension://{}", "a".repeat(32));
        let policy = AuthConfig {
            origin: "https://wallet.example".into(),
            additional_origins: vec![extension.clone()],
            chain_id: 1,
        };
        assert!(policy.domain().is_ok());
        assert!(policy.allows_origin(&extension));
        assert_eq!(
            policy.domain_for_origin(&extension).unwrap(),
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        );
        assert!(
            policy
                .domain_for_origin("https://unlisted.example")
                .is_err()
        );
        assert!(
            AuthConfig {
                additional_origins: vec![extension.clone(), extension.clone()],
                ..policy.clone()
            }
            .domain()
            .is_err()
        );
        assert!(
            AuthConfig {
                additional_origins: (0..8)
                    .map(|index| format!("https://extra-{index}.example"))
                    .collect(),
                ..policy.clone()
            }
            .domain()
            .is_err()
        );
        assert!(
            AuthConfig {
                additional_origins: vec!["http://wallet.example".into()],
                ..policy.clone()
            }
            .domain()
            .is_err()
        );

        let database = Some(SecretUrl::new("postgres://localhost/test".into()));
        assert!(
            Config {
                auth: Some(policy.clone()),
                database_url: database.clone(),
                ..Config::default()
            }
            .validate()
            .is_err(),
            "all auth origins must also pass the browser CORS boundary"
        );
        assert!(
            Config {
                auth: Some(policy),
                database_url: database,
                cors_allowed_origins: vec![
                    "https://wallet.example".parse().unwrap(),
                    extension.parse().unwrap(),
                ],
                ..Config::default()
            }
            .validate()
            .is_ok()
        );
    }
}

#[cfg(test)]
mod role_tests {
    use super::*;

    #[test]
    fn roles_parse_exactly_and_select_responsibilities() {
        assert_eq!(Config::default().server_role, ServerRole::Combined);
        for (raw, role, api, workers) in [
            ("combined", ServerRole::Combined, true, true),
            ("api", ServerRole::Api, true, false),
            ("worker", ServerRole::Worker, false, true),
        ] {
            assert_eq!(raw.parse::<ServerRole>().unwrap(), role);
            assert_eq!(role.serves_api(), api);
            assert_eq!(role.runs_workers(), workers);
        }
        for raw in ["", "API", " worker", "stream", "all"] {
            assert!(raw.parse::<ServerRole>().is_err());
        }
    }

    #[test]
    fn split_roles_require_shared_redis_even_without_identity() {
        assert!(Config::default().validate().is_ok());
        for server_role in [ServerRole::Api, ServerRole::Worker] {
            let mut config = Config {
                server_role,
                ..Config::default()
            };
            assert!(config.validate().is_err());
            config.redis_url = Some(SecretUrl::new("redis://127.0.0.1:6379".into()));
            assert!(config.validate().is_ok());
        }
    }
}
