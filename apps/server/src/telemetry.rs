//! Structured logs and explicitly configured, bounded OTLP trace export.
use crate::{Config, metrics::Metrics};
use opentelemetry::trace::{TraceContextExt, TracerProvider};
use opentelemetry_otlp::{WithExportConfig, WithHttpConfig};
use opentelemetry_proto::tonic::collector::trace::v1::ExportTraceServiceResponse;
use opentelemetry_sdk::{
    Resource,
    trace::{BatchConfigBuilder, BatchSpanProcessor, Sampler, SdkTracerProvider},
};
use prost::Message;
use std::{sync::Arc, time::Duration};
use tracing_opentelemetry::OpenTelemetrySpanExt;
use tracing_subscriber::{EnvFilter, filter::Targets, fmt, prelude::*};

pub struct Telemetry {
    provider: Option<SdkTracerProvider>,
}
impl Telemetry {
    pub async fn shutdown(self) {
        if let Some(provider) = self.provider {
            let task = tokio::task::spawn_blocking(move || {
                provider.shutdown_with_timeout(Duration::from_secs(3))
            });
            if !matches!(
                tokio::time::timeout(Duration::from_secs(4), task).await,
                Ok(Ok(Ok(())))
            ) {
                tracing::warn!(
                    error_code = "trace_shutdown_incomplete",
                    "trace export did not finish before shutdown"
                );
            }
        }
    }
}

pub fn init(config: &Config, metrics: Arc<Metrics>) -> anyhow::Result<Telemetry> {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("honey_server=info,warn"));
    let provider = trace_provider(config, metrics)?;
    let otel = provider.as_ref().map(|provider| {
        tracing_opentelemetry::layer()
            .with_tracer(provider.tracer("honey-server"))
            .with_location(false)
            .with_threads(false)
            // Never export dependency HTTP/SQL internals, even when RUST_LOG is verbose.
            .with_filter(Targets::new().with_target("honey_server", tracing::Level::INFO))
    });
    let registry = tracing_subscriber::registry().with(otel);
    let json = std::env::var("LOG_FORMAT").is_ok_and(|v| v.eq_ignore_ascii_case("json"));
    if json {
        registry
            .with(
                fmt::layer()
                    .json()
                    .with_filter(filter)
                    .with_filter(Targets::new().with_target("honey_server", tracing::Level::TRACE)),
            )
            .try_init()?;
    } else {
        registry
            .with(
                fmt::layer()
                    .with_filter(filter)
                    .with_filter(Targets::new().with_target("honey_server", tracing::Level::TRACE)),
            )
            .try_init()?;
    }
    // The default panic hook prints arbitrary panic payloads before JoinError is
    // observed; dependency payloads can contain credentials. Keep only code location.
    std::panic::set_hook(Box::new(|info| {
        if let Some(location) = info.location() {
            tracing::error!(
                error_code = "runtime_panic",
                source_file = location.file(),
                source_line = location.line(),
                "runtime task panicked; payload omitted"
            );
        } else {
            tracing::error!(
                error_code = "runtime_panic",
                "runtime task panicked; payload omitted"
            );
        }
    }));
    Ok(Telemetry { provider })
}

pub fn trace_provider(
    config: &Config,
    metrics: Arc<Metrics>,
) -> anyhow::Result<Option<SdkTracerProvider>> {
    config.validate()?;
    let Some(endpoint) = &config.otlp_traces_endpoint else {
        return Ok(None);
    };
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_millis(500))
        .timeout(Duration::from_secs(2))
        .redirect(reqwest::redirect::Policy::none())
        .pool_max_idle_per_host(1)
        .build()
        .map_err(|_| anyhow::anyhow!("could not initialize trace transport"))?;
    let exporter = opentelemetry_otlp::SpanExporter::builder()
        .with_http()
        .with_protocol(opentelemetry_otlp::Protocol::HttpBinary)
        .with_endpoint(endpoint.expose())
        .with_timeout(Duration::from_secs(2))
        .with_retry_policy(opentelemetry_otlp::RetryPolicy::default().with_max_retries(0))
        .with_http_client(TraceHttp {
            client,
            runtime: tokio::runtime::Handle::current(),
            metrics,
        })
        .build()
        .map_err(|_| anyhow::anyhow!("could not initialize trace exporter"))?;
    let processor = BatchSpanProcessor::builder(exporter)
        .with_batch_config(
            BatchConfigBuilder::default()
                .with_max_queue_size(2048)
                .with_max_export_batch_size(256)
                .with_scheduled_delay(Duration::from_secs(1))
                .build(),
        )
        .build();
    let provider = SdkTracerProvider::builder()
        .with_span_processor(processor)
        // Incoming public trace context is not extracted and cannot force sampling.
        .with_sampler(Sampler::ParentBased(Box::new(Sampler::TraceIdRatioBased(
            f64::from(config.trace_sample_per_mille) / 1000.0,
        ))))
        .with_max_attributes_per_span(24)
        .with_max_events_per_span(16)
        .with_max_links_per_span(0)
        .with_max_attributes_per_event(12)
        .with_resource(
            Resource::builder_empty()
                .with_service_name("honey-server")
                .with_attribute(opentelemetry::KeyValue::new(
                    "service.version",
                    env!("CARGO_PKG_VERSION"),
                ))
                .build(),
        )
        .build();
    Ok(Some(provider))
}

pub fn trace_id(span: &tracing::Span) -> Option<String> {
    let context = span.context();
    let span = context.span();
    let context = span.span_context();
    context.is_valid().then(|| context.trace_id().to_string())
}

struct TraceHttp {
    client: reqwest::Client,
    runtime: tokio::runtime::Handle,
    metrics: Arc<Metrics>,
}
impl std::fmt::Debug for TraceHttp {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("TraceHttp")
    }
}
#[async_trait::async_trait]
impl opentelemetry_http::HttpClient for TraceHttp {
    async fn send_bytes(
        &self,
        request: opentelemetry_http::Request<opentelemetry_http::Bytes>,
    ) -> Result<
        opentelemetry_http::Response<opentelemetry_http::Bytes>,
        opentelemetry_http::HttpError,
    > {
        let client = self.client.clone();
        let metrics = self.metrics.clone();
        // BatchSpanProcessor runs on its own thread. Execute transport on the live
        // application Tokio runtime; no exporter tasks are created per API request.
        self.runtime
            .spawn(async move {
                let result = async {
                    let (parts, body) = request.into_parts();
                    let mut response = client
                        .request(parts.method, parts.uri.to_string())
                        .headers(parts.headers)
                        .body(body)
                        .send()
                        .await
                        .map_err(|_| "trace_transport_unavailable")?;
                    let status = response.status();
                    let headers = response.headers().clone();
                    let mut body = Vec::new();
                    while let Some(chunk) = response
                        .chunk()
                        .await
                        .map_err(|_| "trace_body_unavailable")?
                    {
                        if body.len() + chunk.len() > 65536 {
                            return Err("trace_response_too_large");
                        }
                        body.extend_from_slice(&chunk);
                    }
                    let mut output =
                        opentelemetry_http::Response::new(opentelemetry_http::Bytes::from(body));
                    *output.status_mut() = status;
                    *output.headers_mut() = headers;
                    Ok(output)
                }
                .await;
                let accepted = result.as_ref().is_ok_and(|response| {
                    response.status().is_success()
                        && ExportTraceServiceResponse::decode(response.body().clone()).is_ok_and(
                            |body| {
                                body.partial_success.is_none_or(|partial| {
                                    partial.rejected_spans == 0 && partial.error_message.is_empty()
                                })
                            },
                        )
                });
                metrics.trace_export(accepted);
                result.map_err(|code| -> opentelemetry_http::HttpError { code.into() })
            })
            .await
            .map_err(|_| -> opentelemetry_http::HttpError { "trace_task_unavailable".into() })?
    }
}
