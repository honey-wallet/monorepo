//! Per-runtime OpenMetrics registry. Labels are fixed enums or server route templates.
use prometheus_client::{
    encoding::{EncodeLabelSet, text::encode},
    metrics::{counter::Counter, family::Family, gauge::Gauge, histogram::Histogram},
    registry::Registry,
};
use std::{sync::Arc, time::Instant};

#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct RouteLabels {
    route: String,
    method: &'static str,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct RequestLabels {
    route: String,
    method: &'static str,
    status_class: &'static str,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct OutcomeLabels {
    outcome: &'static str,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct ProviderOperationLabels {
    provider: &'static str,
    operation: &'static str,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct ProviderLabels {
    provider: &'static str,
    operation: &'static str,
    outcome: &'static str,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct MarketRedisLabels {
    operation: &'static str,
    outcome: &'static str,
}
#[derive(Clone, Debug, Hash, PartialEq, Eq, EncodeLabelSet)]
struct QueueLabels {
    state: &'static str,
}
fn latency() -> Histogram {
    Histogram::new([
        0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0,
    ])
}

pub struct Metrics {
    registry: Registry,
    requests: Family<RequestLabels, Counter>,
    request_latency: Family<RouteLabels, Histogram, fn() -> Histogram>,
    pub http_active: Gauge,
    redis: Family<OutcomeLabels, Counter>,
    redis_latency: Histogram,
    providers: Family<ProviderLabels, Counter>,
    market_redis: Family<MarketRedisLabels, Counter>,
    provider_latency: Family<ProviderOperationLabels, Histogram, fn() -> Histogram>,
    pub ws_active: Gauge,
    pub ws_frames: Counter,
    ws_send_latency: Histogram,
    ws_closed: Family<OutcomeLabels, Counter>,
    ws_handshake_rejections: Family<OutcomeLabels, Counter>,
    http_admission_rejections: Family<OutcomeLabels, Counter>,
    trace_exports: Family<OutcomeLabels, Counter>,
    background_failures: Family<OutcomeLabels, Counter>,
    pub price_sample_ms: Gauge,
    pub price_stale: Gauge,
    pub database_connections: Gauge,
    pub database_idle: Gauge,
    queue_jobs: Family<QueueLabels, Gauge>,
    queue_oldest_age_seconds: Family<QueueLabels, Gauge>,
    queue_refreshes: Family<OutcomeLabels, Counter>,
    pub queue_snapshot_timestamp_seconds: Gauge,
    auth_cleanup: Family<OutcomeLabels, Counter>,
    pub auth_cleanup_success_timestamp_seconds: Gauge,
    pub postgres_up: Gauge,
    pub redis_up: Gauge,
    pub draining: Gauge,
}
impl Default for Metrics {
    fn default() -> Self {
        let mut registry = Registry::with_prefix("honey");
        let requests = Family::default();
        let request_latency = Family::new_with_constructor(latency as fn() -> Histogram);
        let http_active = Gauge::default();
        let redis = Family::default();
        let redis_latency = latency();
        let providers = Family::default();
        let market_redis = Family::default();
        let provider_latency = Family::new_with_constructor(latency as fn() -> Histogram);
        let ws_active = Gauge::default();
        let ws_frames = Counter::default();
        let ws_send_latency = latency();
        let ws_closed = Family::default();
        let ws_handshake_rejections = Family::default();
        let http_admission_rejections = Family::default();
        let trace_exports = Family::default();
        let background_failures = Family::default();
        let price_sample_ms = Gauge::default();
        let price_stale = Gauge::default();
        price_stale.set(1);
        let database_connections = Gauge::default();
        let database_idle = Gauge::default();
        let queue_jobs = Family::default();
        let queue_oldest_age_seconds = Family::default();
        let queue_refreshes = Family::default();
        let queue_snapshot_timestamp_seconds = Gauge::default();
        let auth_cleanup = Family::default();
        let auth_cleanup_success_timestamp_seconds = Gauge::default();
        let postgres_up = Gauge::default();
        let redis_up = Gauge::default();
        let draining = Gauge::default();
        registry.register(
            "http_requests",
            "HTTP handler responses by route template, normalized method and status class",
            requests.clone(),
        );
        registry.register(
            "http_request_duration_seconds",
            "Time through handler response creation, including admission and body read",
            request_latency.clone(),
        );
        registry.register(
            "http_active",
            "HTTP handlers currently active; excludes upgraded sockets",
            http_active.clone(),
        );
        registry.register(
            "redis_commands",
            "Redis application commands by bounded outcome",
            redis.clone(),
        );
        registry.register(
            "redis_command_duration_seconds",
            "Redis command wall time including admission and connection",
            redis_latency.clone(),
        );
        registry.register(
            "provider_requests",
            "Provider calls by fixed provider, operation and classified outcome",
            providers.clone(),
        );
        registry.register(
            "price_redis_operations",
            "Price ingestion and mirror Redis outcomes by fixed operation and outcome",
            market_redis.clone(),
        );
        registry.register(
            "provider_request_duration_seconds",
            "Provider request wall time including bounded body read",
            provider_latency.clone(),
        );
        registry.register(
            "price_sockets_active",
            "Active price sockets on this process",
            ws_active.clone(),
        );
        registry.register(
            "price_socket_frames",
            "Complete price snapshots sent to sockets",
            ws_frames.clone(),
        );
        registry.register(
            "price_socket_send_duration_seconds",
            "Time spent writing a complete price snapshot to an individual socket",
            ws_send_latency.clone(),
        );
        registry.register(
            "price_socket_closes",
            "Socket closes by bounded reason",
            ws_closed.clone(),
        );
        registry.register(
            "price_socket_handshake_rejections",
            "Price WebSocket handshake rejections by fixed server-side reason",
            ws_handshake_rejections.clone(),
        );
        registry.register(
            "http_admission_rejections",
            "HTTP requests rejected by bounded global admission reason",
            http_admission_rejections.clone(),
        );
        registry.register(
            "background_failures",
            "Unexpected required background task exits",
            background_failures.clone(),
        );
        registry.register(
            "trace_exports",
            "OTLP HTTP export attempts by outcome",
            trace_exports.clone(),
        );
        registry.register(
            "price_sample_timestamp_milliseconds",
            "Redis clock at last installed provider sample",
            price_sample_ms.clone(),
        );
        registry.register(
            "price_stale",
            "Latest price sample is stale or absent (1), fresh (0)",
            price_stale.clone(),
        );
        registry.register(
            "database_connections",
            "PostgreSQL pool size at last background probe",
            database_connections.clone(),
        );
        registry.register(
            "database_idle_connections",
            "Idle PostgreSQL connections at last background probe",
            database_idle.clone(),
        );
        registry.register(
            "work_queue_jobs",
            "Bounded count of durable jobs by fixed state; 10001 means at least 10001",
            queue_jobs.clone(),
        );
        registry.register(
            "work_queue_oldest_age_seconds",
            "Age of oldest due ready or dead job; state labels are fixed",
            queue_oldest_age_seconds.clone(),
        );
        registry.register(
            "work_queue_metrics_refreshes",
            "Bounded durable queue metric refresh outcomes",
            queue_refreshes.clone(),
        );
        registry.register(
            "work_queue_metrics_snapshot_timestamp_seconds",
            "Unix timestamp of last successful durable queue metric snapshot",
            queue_snapshot_timestamp_seconds.clone(),
        );
        registry.register(
            "auth_cleanup",
            "Scheduled authentication retention cleanup attempts by fixed outcome",
            auth_cleanup.clone(),
        );
        registry.register(
            "auth_cleanup_success_timestamp_seconds",
            "Unix timestamp of the last successful authentication retention cleanup",
            auth_cleanup_success_timestamp_seconds.clone(),
        );
        registry.register(
            "postgres_up",
            "Last PostgreSQL dependency probe succeeded",
            postgres_up.clone(),
        );
        registry.register(
            "redis_up",
            "Last Redis dependency probe succeeded",
            redis_up.clone(),
        );
        registry.register("draining", "Server is draining", draining.clone());
        Self {
            registry,
            requests,
            request_latency,
            http_active,
            redis,
            redis_latency,
            providers,
            market_redis,
            provider_latency,
            ws_active,
            ws_frames,
            ws_send_latency,
            ws_closed,
            ws_handshake_rejections,
            http_admission_rejections,
            trace_exports,
            background_failures,
            price_sample_ms,
            price_stale,
            database_connections,
            database_idle,
            queue_jobs,
            queue_oldest_age_seconds,
            queue_refreshes,
            queue_snapshot_timestamp_seconds,
            auth_cleanup,
            auth_cleanup_success_timestamp_seconds,
            postgres_up,
            redis_up,
            draining,
        }
    }
}
impl Metrics {
    pub fn price_socket_send(&self, elapsed_seconds: f64) {
        self.ws_send_latency.observe(elapsed_seconds.max(0.0));
    }
    pub fn work_queue_state(&self, state: &str, count: i64, oldest_age_seconds: Option<i64>) {
        let state = match state {
            "ready" => "ready",
            "leased" => "leased",
            "expired_lease" => "expired_lease",
            "dead" => "dead",
            _ => return,
        };
        self.queue_jobs
            .get_or_create(&QueueLabels { state })
            .set(count.clamp(0, 10_001));
        self.queue_oldest_age_seconds
            .get_or_create(&QueueLabels { state })
            .set(oldest_age_seconds.unwrap_or(0).max(0));
    }

    pub fn work_queue_refresh(&self, ok: bool, timestamp_seconds: Option<i64>) {
        self.queue_refreshes
            .get_or_create(&OutcomeLabels {
                outcome: if ok { "ok" } else { "error" },
            })
            .inc();
        if let Some(timestamp) = timestamp_seconds {
            self.queue_snapshot_timestamp_seconds.set(timestamp.max(0));
        }
    }

    pub fn auth_cleanup(&self, ok: bool, timestamp_seconds: Option<i64>) {
        self.auth_cleanup
            .get_or_create(&OutcomeLabels {
                outcome: if ok { "ok" } else { "error" },
            })
            .inc();
        if ok && let Some(timestamp) = timestamp_seconds {
            self.auth_cleanup_success_timestamp_seconds
                .set(timestamp.max(0));
        }
    }

    pub fn encode(&self) -> Result<String, std::fmt::Error> {
        let mut text = String::new();
        encode(&mut text, &self.registry)?;
        Ok(text)
    }
    pub fn http(&self, route: &str, method: &str, status: u16, elapsed: f64) {
        let method = http_method(method);
        let status_class = match status {
            100..=199 => "1xx",
            200..=299 => "2xx",
            300..=399 => "3xx",
            400..=499 => "4xx",
            _ => "5xx",
        };
        self.requests
            .get_or_create(&RequestLabels {
                route: route.into(),
                method,
                status_class,
            })
            .inc();
        self.request_latency
            .get_or_create(&RouteLabels {
                route: route.into(),
                method,
            })
            .observe(elapsed);
    }
    pub fn redis(&self, outcome: RedisOutcome, elapsed: f64) {
        let outcome = match outcome {
            RedisOutcome::Ok => "ok",
            RedisOutcome::Busy => "busy",
            RedisOutcome::Timeout => "timeout",
            RedisOutcome::Unavailable => "unavailable",
        };
        self.redis.get_or_create(&OutcomeLabels { outcome }).inc();
        self.redis_latency.observe(elapsed);
    }
    pub fn market_fetch(&self, ok: bool, elapsed: f64) {
        self.providers
            .get_or_create(&ProviderLabels {
                provider: "hyperliquid",
                operation: "all_mids",
                outcome: if ok { "ok" } else { "failed" },
            })
            .inc();
        self.provider_latency
            .get_or_create(&ProviderOperationLabels {
                provider: "hyperliquid",
                operation: "all_mids",
            })
            .observe(elapsed);
    }
    pub fn market_redis(&self, operation: &'static str, outcome: &'static str) {
        let operation = match operation {
            "poll" => "poll",
            "publish" => "publish",
            "read" => "read",
            _ => "unknown",
        };
        let outcome = match outcome {
            "ok" => "ok",
            "empty" => "empty",
            "unavailable" => "unavailable",
            "fenced" => "fenced",
            "invalid" => "invalid",
            _ => "unknown",
        };
        self.market_redis
            .get_or_create(&MarketRedisLabels { operation, outcome })
            .inc();
    }
    pub fn earn_read(&self, provider: &str, outcome: &str, elapsed: f64) {
        let provider = match provider {
            "morpho" => "morpho",
            "aave" => "aave",
            _ => "unknown",
        };
        let outcome = match outcome {
            "ok" => "ok",
            "busy" => "busy",
            "cooldown" => "cooldown",
            "timeout" => "timeout",
            "unavailable" => "unavailable",
            "rejected" => "rejected",
            "not_found" => "not_found",
            _ => "invalid_response",
        };
        self.providers
            .get_or_create(&ProviderLabels {
                provider,
                operation: "earn_read",
                outcome,
            })
            .inc();
        self.provider_latency
            .get_or_create(&ProviderOperationLabels {
                provider,
                operation: "earn_read",
            })
            .observe(elapsed);
    }
    pub fn swap_quote(&self, outcome: &str, elapsed: f64) {
        self.swap_request("quote", outcome, elapsed);
    }
    pub fn swap_build(&self, outcome: &str, elapsed: f64) {
        self.swap_request("build", outcome, elapsed);
    }
    fn swap_request(&self, operation: &'static str, outcome: &str, elapsed: f64) {
        let outcome = match outcome {
            "ok" => "ok",
            "invalid_request" => "invalid_request",
            "busy" => "busy",
            "no_route" => "no_route",
            "unavailable" => "unavailable",
            _ => "invalid_response",
        };
        self.providers
            .get_or_create(&ProviderLabels {
                provider: "uniswap",
                operation,
                outcome,
            })
            .inc();
        self.provider_latency
            .get_or_create(&ProviderOperationLabels {
                provider: "uniswap",
                operation,
            })
            .observe(elapsed);
    }
    pub fn bridge_status(
        &self,
        provider: crate::providers::bridge_status::BridgeProvider,
        error: Option<crate::providers::bridge_status::StatusError>,
        elapsed: f64,
    ) {
        let provider = provider.name();
        self.providers
            .get_or_create(&ProviderLabels {
                provider,
                operation: "bridge_status",
                outcome: error.map_or("ok", |e| e.code()),
            })
            .inc();
        self.provider_latency
            .get_or_create(&ProviderOperationLabels {
                provider,
                operation: "bridge_status",
            })
            .observe(elapsed);
    }
    pub fn across_quote(
        &self,
        error: Option<crate::providers::across_quotes::QuoteError>,
        elapsed: f64,
    ) {
        self.providers
            .get_or_create(&ProviderLabels {
                provider: "across",
                operation: "quote",
                outcome: error.map_or("ok", |e| e.code()),
            })
            .inc();
        self.provider_latency
            .get_or_create(&ProviderOperationLabels {
                provider: "across",
                operation: "quote",
            })
            .observe(elapsed);
    }
    pub fn evm_rpc(
        &self,
        method: &str,
        error: Option<crate::providers::evm_rpc::RpcError>,
        elapsed: f64,
    ) {
        use crate::providers::evm_rpc::RpcError;
        let operation = match method {
            "eth_simulateV1" => "simulate",
            "eth_sendRawTransaction" => "broadcast",
            "eth_getTransactionReceipt" => "receipt",
            "eth_getTransactionByHash" => "transaction",
            _ => "read",
        };
        let outcome = match error {
            None => "ok",
            Some(RpcError::Busy) => "busy",
            Some(RpcError::CoolingDown) => "cooldown",
            Some(RpcError::Configuration) => "configuration",
            Some(RpcError::Unavailable) => "unavailable",
            Some(RpcError::InvalidResponse) => "invalid_response",
            Some(RpcError::Rejected) => "rejected",
        };
        self.providers
            .get_or_create(&ProviderLabels {
                provider: "evm_rpc",
                operation,
                outcome,
            })
            .inc();
        self.provider_latency
            .get_or_create(&ProviderOperationLabels {
                provider: "evm_rpc",
                operation,
            })
            .observe(elapsed);
    }
    pub fn background_failure(&self, reason: &str) {
        let outcome = match reason {
            "panic" => "panic",
            "cancelled" => "cancelled",
            _ => "exited",
        };
        self.background_failures
            .get_or_create(&OutcomeLabels { outcome })
            .inc();
    }
    pub fn trace_export(&self, ok: bool) {
        self.trace_exports
            .get_or_create(&OutcomeLabels {
                outcome: if ok { "ok" } else { "failed" },
            })
            .inc();
    }
    pub fn socket_closed(&self, reason: &str) {
        let outcome = match reason {
            "server draining" => "drain",
            "heartbeat expired" => "heartbeat",
            "send deadline" => "send_deadline",
            "connection lease unavailable" => "lease_unavailable",
            "peer closed" => "peer",
            "message rate exceeded" => "rate_limit",
            "fixed price feed accepts no client commands" => "protocol",
            "feed stopped" => "feed_stopped",
            _ => "other",
        };
        self.ws_closed
            .get_or_create(&OutcomeLabels { outcome })
            .inc();
    }
    pub fn socket_handshake_rejected(&self, reason: &str) {
        let reason = match reason {
            "origin" => "origin",
            "feed_unavailable" => "feed_unavailable",
            "draining" => "draining",
            "snapshot_missing" => "snapshot_missing",
            "local_limit" => "local_limit",
            "client_ip_missing" => "client_ip_missing",
            "redis_busy" => "redis_busy",
            "lease_limit" => "lease_limit",
            _ => "other",
        };
        self.ws_handshake_rejections
            .get_or_create(&OutcomeLabels { outcome: reason })
            .inc();
    }
    pub fn http_admission_rejected(&self, reason: &str) {
        let reason = match reason {
            "capacity" => "capacity",
            "draining" => "draining",
            _ => "other",
        };
        self.http_admission_rejections
            .get_or_create(&OutcomeLabels { outcome: reason })
            .inc();
    }
    pub fn active_http(self: &Arc<Self>) -> ActiveGauge {
        ActiveGauge::new(self.http_active.clone())
    }
}
pub enum RedisOutcome {
    Ok,
    Busy,
    Timeout,
    Unavailable,
}
/// Drop covers cancellation, panic and early return without leaving a phantom gauge.
pub struct ActiveGauge {
    gauge: Gauge,
}
impl ActiveGauge {
    pub fn new(gauge: Gauge) -> Self {
        gauge.inc();
        Self { gauge }
    }
}
impl Drop for ActiveGauge {
    fn drop(&mut self) {
        self.gauge.dec();
    }
}

#[derive(Clone)]
struct ScrapeState {
    metrics: Arc<Metrics>,
    permits: Arc<tokio::sync::Semaphore>,
}
/// Separate internal listener. Never merge into the public API router.
pub fn router(metrics: Arc<Metrics>) -> axum::Router {
    use axum::{extract::State, response::IntoResponse};
    axum::Router::new()
        .route(
            "/metrics",
            axum::routing::get(|State(state): State<ScrapeState>| async move {
                let Ok(_permit) = state.permits.try_acquire() else {
                    return axum::http::StatusCode::SERVICE_UNAVAILABLE.into_response();
                };
                let started = Instant::now();
                match state.metrics.encode() {
                    Ok(text) => {
                        tracing::debug!(
                            duration_ms = started.elapsed().as_millis() as u64,
                            "metrics encoded"
                        );
                        (
                            [
                                (
                                    axum::http::header::CONTENT_TYPE,
                                    "application/openmetrics-text; version=1.0.0; charset=utf-8",
                                ),
                                (axum::http::header::CACHE_CONTROL, "no-store"),
                            ],
                            text,
                        )
                            .into_response()
                    }
                    Err(_) => axum::http::StatusCode::INTERNAL_SERVER_ERROR.into_response(),
                }
            }),
        )
        .with_state(ScrapeState {
            metrics,
            permits: Arc::new(tokio::sync::Semaphore::new(2)),
        })
}

pub fn http_method(method: &str) -> &'static str {
    match method {
        "GET" => "GET",
        "POST" => "POST",
        "PUT" => "PUT",
        "PATCH" => "PATCH",
        "DELETE" => "DELETE",
        "HEAD" => "HEAD",
        "OPTIONS" => "OPTIONS",
        _ => "OTHER",
    }
}

#[cfg(test)]
mod tests {
    use super::Metrics;

    #[test]
    fn auth_cleanup_metrics_keep_fixed_outcomes_and_last_success() {
        let metrics = Metrics::default();
        metrics.auth_cleanup(true, Some(1_800_000_000));
        metrics.auth_cleanup(false, None);

        let exposition = metrics.encode().unwrap();
        assert!(exposition.contains("honey_auth_cleanup_total{outcome=\"ok\"} 1"));
        assert!(exposition.contains("honey_auth_cleanup_total{outcome=\"error\"} 1"));
        assert!(exposition.contains("honey_auth_cleanup_success_timestamp_seconds 1800000000"));
    }
}
