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
    pub host: IpAddr,
    pub port: u16,
    pub cors_allowed_origins: Vec<HeaderValue>,
    pub request_timeout_secs: u64,
    /// Trust `X-Forwarded-For` for the client IP (only behind a proxy that sets it).
    pub trust_proxy_headers: bool,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("{name} has an invalid value {value:?}")]
    Invalid { name: &'static str, value: String },
}

impl Default for Config {
    fn default() -> Self {
        Self {
            host: IpAddr::V4(Ipv4Addr::LOCALHOST),
            port: 8080,
            cors_allowed_origins: DEFAULT_CORS_ORIGINS
                .iter()
                .map(|o| HeaderValue::from_static(o))
                .collect(),
            request_timeout_secs: 30,
            trust_proxy_headers: false,
        }
    }
}

/// Vite dev server and Expo web dev server.
const DEFAULT_CORS_ORIGINS: &[&str] = &["http://localhost:5173", "http://localhost:8081"];

impl Config {
    pub fn from_env() -> Result<Self, ConfigError> {
        let defaults = Self::default();
        Ok(Self {
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
        })
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
            .map_err(|_| ConfigError::Invalid { name, value }),
        Err(_) => Ok(None),
    }
}

fn parse_origins(raw: &str) -> Result<Vec<HeaderValue>, ConfigError> {
    raw.split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(|origin| {
            HeaderValue::from_str(origin).map_err(|_| ConfigError::Invalid {
                name: "CORS_ALLOWED_ORIGINS",
                value: origin.to_owned(),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_comma_separated_origins() {
        let origins = parse_origins("http://a.test, http://b.test,,").unwrap();
        assert_eq!(origins, vec!["http://a.test", "http://b.test"]);
    }
}
