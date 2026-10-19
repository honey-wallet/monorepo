//! A bounded HTTP envelope with server-owned, privacy-safe correlation.

use std::{
    sync::Arc,
    time::{Duration, Instant},
};

use axum::{
    body::Body,
    extract::{MatchedPath, Request, State},
    http::{HeaderValue, header},
    middleware::Next,
    response::{IntoResponse, Response},
};
use http_body_util::BodyExt;
use tokio::sync::Semaphore;
use tracing::Instrument;

use crate::{Config, error::AppError, runtime::RuntimeHealth};

// Bound aggregate buffered request payload independently of request count. This
// is deliberately conservative; it limits payload bytes, with allocator and
// frame overhead remaining additional process memory.
const BODY_MEMORY_BUDGET_BYTES: usize = 16 * 1024 * 1024;
const BODY_MEMORY_QUANTUM_BYTES: usize = 1024;

#[derive(Clone)]
pub struct HttpRuntime {
    permits: Arc<Semaphore>,
    body_memory: Arc<Semaphore>,
    timeout: Duration,
    body_limit: usize,
    health: RuntimeHealth,
    metrics: Arc<crate::metrics::Metrics>,
}

impl HttpRuntime {
    pub fn new(config: &Config, health: RuntimeHealth) -> Self {
        Self::with_metrics(config, health, Arc::new(crate::metrics::Metrics::default()))
    }

    pub fn with_metrics(
        config: &Config,
        health: RuntimeHealth,
        metrics: Arc<crate::metrics::Metrics>,
    ) -> Self {
        Self::with_body_memory_budget(config, health, metrics, BODY_MEMORY_BUDGET_BYTES)
    }

    fn with_body_memory_budget(
        config: &Config,
        health: RuntimeHealth,
        metrics: Arc<crate::metrics::Metrics>,
        budget_bytes: usize,
    ) -> Self {
        Self {
            metrics,
            permits: Arc::new(Semaphore::new(config.max_in_flight_requests)),
            body_memory: Arc::new(Semaphore::new(budget_bytes / BODY_MEMORY_QUANTUM_BYTES)),
            timeout: Duration::from_secs(config.request_timeout_secs),
            body_limit: config.max_request_body_bytes,
            health,
        }
    }
}

pub async fn envelope(
    State(runtime): State<HttpRuntime>,
    mut request: Request,
    next: Next,
) -> Response {
    let started = Instant::now();
    let request_id = uuid::Uuid::new_v4().to_string();
    let route = request
        .extensions()
        .get::<MatchedPath>()
        .map_or("unmatched", MatchedPath::as_str)
        .to_owned();
    let method = crate::metrics::http_method(request.method().as_str());
    let _active = runtime.metrics.active_http();
    let probe = matches!(route.as_str(), "/health" | "/ready");
    // An inbound ID may contain private data or be chosen to collide with another request.
    request.headers_mut().insert(
        "x-request-id",
        HeaderValue::from_str(&request_id).expect("UUID is a header value"),
    );
    let span = tracing::info_span!(
        "http.request",
        otel.kind = "server",
        trace_id = tracing::field::Empty,
        otel.status_code = tracing::field::Empty,
        request_id,
        method,
        route,
        status = tracing::field::Empty,
        duration_ms = tracing::field::Empty
    );
    let trace_id = crate::telemetry::trace_id(&span);
    if let Some(id) = &trace_id {
        span.record("trace_id", id);
    }
    async move {
        let work = async {
            // Probes must remain available when application admission is saturated.
            let _permit = if probe {
                None
            } else {
                if runtime.health.is_draining() {
                    runtime.metrics.http_admission_rejected("draining");
                    return AppError::Busy.into_response();
                }
                match runtime.permits.try_acquire() {
                    Ok(permit) => Some(permit),
                    Err(_) => {
                        runtime.metrics.http_admission_rejected("capacity");
                        return AppError::Busy.into_response();
                    }
                }
            };
            // Enforce both the per-request limit and an aggregate byte budget
            // before copying chunks into the buffered body. A Content-Length is
            // only an admission hint; every received frame is still counted.
            let (parts, body) = request.into_parts();
            let declared = match parts
                .headers
                .get_all(header::CONTENT_LENGTH)
                .iter()
                .collect::<Vec<_>>()
                .as_slice()
            {
                [value] => {
                    let Some(value) = value
                        .to_str()
                        .ok()
                        .and_then(|value| value.parse::<usize>().ok())
                    else {
                        return AppError::BadRequest("invalid Content-Length".into())
                            .into_response();
                    };
                    if value > runtime.body_limit {
                        return AppError::PayloadTooLarge.into_response();
                    }
                    Some(value)
                }
                [] => None,
                _ => return AppError::BadRequest("invalid Content-Length".into()).into_response(),
            };
            let mut body_permits = Vec::new();
            let mut reserved_quanta = 0;
            if let Some(length) = declared
                && length > 0
            {
                let permits = permits_for_body(length);
                match runtime.body_memory.clone().try_acquire_many_owned(permits) {
                    Ok(permit) => body_permits.push(permit),
                    Err(_) => return AppError::Busy.into_response(),
                }
                reserved_quanta = permits;
            }
            // Reserve declared body capacity before allocating the backing Vec.
            let mut body_bytes = Vec::with_capacity(declared.unwrap_or(0));
            let mut body = body;
            while let Some(frame) = body.frame().await {
                let frame = match frame {
                    Ok(frame) => frame,
                    Err(_) => {
                        return AppError::BadRequest("could not read request body".into())
                            .into_response();
                    }
                };
                let Ok(data) = frame.into_data() else {
                    continue;
                };
                let Some(next_len) = body_bytes.len().checked_add(data.len()) else {
                    return AppError::PayloadTooLarge.into_response();
                };
                if next_len > runtime.body_limit {
                    return AppError::PayloadTooLarge.into_response();
                }
                let required_quanta = permits_for_body(next_len);
                if required_quanta > reserved_quanta {
                    let additional = required_quanta - reserved_quanta;
                    match runtime
                        .body_memory
                        .clone()
                        .try_acquire_many_owned(additional)
                    {
                        Ok(permit) => body_permits.push(permit),
                        Err(_) => return AppError::Busy.into_response(),
                    }
                    reserved_quanta = required_quanta;
                }
                body_bytes.extend_from_slice(&data);
            }
            // Keep the body-byte reservation alive through route processing;
            // parsed request values can overlap with the buffered representation.
            let _body_permits = body_permits;
            let body = Body::from(body_bytes);
            next.run(Request::from_parts(parts, body)).await
        };
        let mut response = tokio::time::timeout(runtime.timeout, work)
            .await
            .unwrap_or_else(|_| AppError::Timeout.into_response());
        response.headers_mut().insert(
            "x-request-id",
            HeaderValue::from_str(&request_id).expect("UUID is a header value"),
        );
        response
            .headers_mut()
            .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
        if let Some(id) = trace_id {
            response.headers_mut().insert(
                "x-trace-id",
                HeaderValue::from_str(&id).expect("trace ID header"),
            );
        }
        runtime.metrics.http(
            &route,
            method,
            response.status().as_u16(),
            started.elapsed().as_secs_f64(),
        );
        let current = tracing::Span::current();
        if response.status().is_server_error() {
            current.record("otel.status_code", "ERROR");
        }
        current.record("status", response.status().as_u16());
        current.record("duration_ms", started.elapsed().as_millis() as u64);
        tracing::info!("request completed");
        response
    }
    .instrument(span)
    .await
}

fn permits_for_body(bytes: usize) -> u32 {
    bytes.div_ceil(BODY_MEMORY_QUANTUM_BYTES) as u32
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Bytes, to_bytes},
        http::{HeaderValue, Request as HttpRequest, StatusCode},
        middleware,
        routing::{get, post},
    };
    use tokio::sync::Notify;
    use tower::ServiceExt;

    fn request(path: &str) -> HttpRequest<Body> {
        HttpRequest::get(path).body(Body::empty()).unwrap()
    }

    fn body_request(size: usize) -> HttpRequest<Body> {
        body_request_with_content_length(size, size)
    }

    fn body_request_with_content_length(size: usize, declared: usize) -> HttpRequest<Body> {
        HttpRequest::builder()
            .method("POST")
            .uri("/body")
            .header(
                header::CONTENT_LENGTH,
                HeaderValue::from_str(&declared.to_string()).unwrap(),
            )
            .body(Body::from(vec![0; size]))
            .unwrap()
    }

    #[tokio::test]
    async fn aggregate_body_budget_rejects_before_buffering_and_releases_after_handler() {
        let config = Config {
            max_in_flight_requests: 8,
            max_request_body_bytes: 8 * 1024,
            ..Config::default()
        };
        let runtime = HttpRuntime::with_body_memory_budget(
            &config,
            RuntimeHealth::new(&config),
            Arc::new(crate::metrics::Metrics::default()),
            4 * 1024,
        );
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let app = Router::new()
            .route(
                "/body",
                post({
                    let entered = entered.clone();
                    let release = release.clone();
                    move |_body: Bytes| {
                        let entered = entered.clone();
                        let release = release.clone();
                        async move {
                            entered.notify_one();
                            release.notified().await;
                            StatusCode::OK
                        }
                    }
                }),
            )
            .layer(middleware::from_fn_with_state(runtime, envelope));

        let first = tokio::spawn(app.clone().oneshot(body_request(3 * 1024)));
        entered.notified().await;
        let rejected = app.clone().oneshot(body_request(2 * 1024)).await.unwrap();
        assert_eq!(rejected.status(), StatusCode::SERVICE_UNAVAILABLE);

        release.notify_one();
        assert_eq!(first.await.unwrap().unwrap().status(), StatusCode::OK);
        let mismatched = app
            .clone()
            .oneshot(body_request_with_content_length(5 * 1024, 1024))
            .await
            .unwrap();
        assert_eq!(mismatched.status(), StatusCode::SERVICE_UNAVAILABLE);
        let next = tokio::spawn(app.clone().oneshot(body_request(2 * 1024)));
        entered.notified().await;
        release.notify_one();
        assert_eq!(next.await.unwrap().unwrap().status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn overload_is_immediate_probes_survive_and_completed_work_releases_permits() {
        let config = Config {
            max_in_flight_requests: 1,
            ..Config::default()
        };
        let metrics = Arc::new(crate::metrics::Metrics::default());
        let runtime =
            HttpRuntime::with_metrics(&config, RuntimeHealth::new(&config), metrics.clone());
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let app = Router::new()
            .route(
                "/slow",
                get({
                    let entered = entered.clone();
                    let release = release.clone();
                    move || async move {
                        entered.notify_one();
                        release.notified().await;
                        "done"
                    }
                }),
            )
            .route("/fast", get(|| async { "ok" }))
            .route("/health", get(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(runtime, envelope));
        let first = tokio::spawn(app.clone().oneshot(request("/slow")));
        entered.notified().await;
        let busy = app.clone().oneshot(request("/fast")).await.unwrap();
        assert_eq!(busy.status(), StatusCode::SERVICE_UNAVAILABLE);
        assert_eq!(busy.headers()["retry-after"], "1");
        assert!(
            metrics
                .encode()
                .unwrap()
                .contains("honey_http_admission_rejections_total{outcome=\"capacity\"} 1")
        );
        assert_eq!(
            app.clone()
                .oneshot(request("/health"))
                .await
                .unwrap()
                .status(),
            StatusCode::OK
        );
        release.notify_one();
        assert_eq!(first.await.unwrap().unwrap().status(), StatusCode::OK);
        assert_eq!(
            app.oneshot(request("/fast")).await.unwrap().status(),
            StatusCode::OK
        );
    }

    #[tokio::test]
    async fn timeout_is_structured_and_releases_admission_permit() {
        let config = Config {
            max_in_flight_requests: 1,
            ..Config::default()
        };
        let mut runtime = HttpRuntime::new(&config, RuntimeHealth::new(&config));
        runtime.timeout = Duration::from_millis(10);
        let app = Router::new()
            .route(
                "/slow",
                get(|| async {
                    std::future::pending::<()>().await;
                    "unreachable"
                }),
            )
            .route("/fast", get(|| async { "ok" }))
            .layer(middleware::from_fn_with_state(runtime, envelope));
        let response = app.clone().oneshot(request("/slow")).await.unwrap();
        assert_eq!(response.status(), StatusCode::GATEWAY_TIMEOUT);
        assert!(response.headers().contains_key("x-request-id"));
        let bytes = to_bytes(response.into_body(), 4096).await.unwrap();
        let body: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(body["error"]["code"], "timeout");
        assert_eq!(
            app.oneshot(request("/fast")).await.unwrap().status(),
            StatusCode::OK
        );
    }
}
