use crate::{
    Config,
    error::AppError,
    markets::{MarketHub, PriceSnapshot},
    runtime::RuntimeHealth,
};
use axum::{
    Json, Router,
    extract::{
        ConnectInfo, State, WebSocketUpgrade,
        ws::{CloseFrame, Message},
    },
    http::HeaderMap,
    response::Response,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use sha2::{Digest, Sha256};
use std::{
    net::{IpAddr, SocketAddr},
    sync::Arc,
    time::{Duration, Instant},
};
use tracing::Instrument;
use uuid::Uuid;

const SOCKET_LEASE_RENEW_INTERVAL: Duration = Duration::from_secs(20);
const SOCKET_LEASE_RENEW_MIN_DELAY: Duration = Duration::from_secs(10);
const SOCKET_LEASE_RENEW_JITTER_MS: u64 = 10_000;

fn socket_lease_initial_delay(id: Uuid) -> Duration {
    let bytes = id.as_bytes();
    let phase = u16::from_be_bytes([bytes[0], bytes[1]]) as u64 % SOCKET_LEASE_RENEW_JITTER_MS;
    SOCKET_LEASE_RENEW_MIN_DELAY + Duration::from_millis(phase)
}

#[derive(Clone)]
struct StreamState {
    hub: Option<Arc<MarketHub>>,
    metrics: Option<Arc<crate::metrics::Metrics>>,
    health: RuntimeHealth,
    origins: Vec<axum::http::HeaderValue>,
    trust_proxy: bool,
    trusted_proxy_cidrs: Vec<crate::config::TrustedProxyCidr>,
}

pub fn router(hub: Option<Arc<MarketHub>>, health: RuntimeHealth, config: &Config) -> Router {
    let metrics = hub.as_ref().map(|hub| hub.metrics.clone());
    Router::new()
        .route("/prices", get(snapshot))
        .route("/stream/prices", get(upgrade))
        .with_state(StreamState {
            hub,
            metrics,
            health,
            origins: config.cors_allowed_origins.clone(),
            trust_proxy: config.trust_proxy_headers,
            trusted_proxy_cidrs: config.trusted_proxy_cidrs.clone(),
        })
}

async fn snapshot(State(state): State<StreamState>) -> Result<Json<PriceSnapshot>, AppError> {
    Ok(Json(
        state
            .hub
            .ok_or(AppError::Unsupported(
                "public price feed not configured".into(),
            ))?
            .snapshot()
            .ok_or(AppError::Busy)?,
    ))
}

async fn upgrade(
    State(state): State<StreamState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Result<Response, AppError> {
    // Origin is a browser cross-site control, not authentication: browsers attach
    // it to WebSocket handshakes, while native clients may omit it for this public
    // feed. Reject every supplied non-allowlisted origin; enforce limits below
    // independently for browser and originless clients.
    if headers.get_all("origin").iter().count() > 1
        || headers
            .get("origin")
            .is_some_and(|o| !state.origins.contains(o))
    {
        if let Some(metrics) = &state.metrics {
            metrics.socket_handshake_rejected("origin");
        }
        return Err(AppError::Forbidden);
    }
    let hub = state.hub.clone().ok_or_else(|| {
        if let Some(metrics) = &state.metrics {
            metrics.socket_handshake_rejected("feed_unavailable");
        }
        AppError::Unsupported("public price feed not configured".into())
    })?;
    if state.health.is_draining() {
        hub.metrics.socket_handshake_rejected("draining");
        return Err(AppError::Busy);
    }
    if hub.snapshot().is_none() {
        hub.metrics.socket_handshake_rejected("snapshot_missing");
        return Err(AppError::Busy);
    }
    let permit = hub.permits.clone().try_acquire_owned().map_err(|_| {
        hub.metrics.socket_handshake_rejected("local_limit");
        AppError::Busy
    })?;
    let trust_forwarded = state.trust_proxy
        && state
            .trusted_proxy_cidrs
            .iter()
            .any(|cidr| cidr.contains(peer.ip()));
    let ip: IpAddr = if trust_forwarded {
        headers
            .get_all("x-forwarded-for")
            .iter()
            .next_back()
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.rsplit(',').next()?.trim().parse().ok())
            .ok_or_else(|| {
                hub.metrics.socket_handshake_rejected("client_ip_missing");
                AppError::BadRequest("missing client address".into())
            })?
    } else {
        peer.ip()
    };
    let ip = match ip.to_canonical() {
        IpAddr::V6(v) => {
            let mut segments = v.segments();
            segments[4..].fill(0);
            IpAddr::from(segments)
        }
        v => v,
    };
    let subject = hex::encode(Sha256::digest(ip.to_string().as_bytes()));
    let id = Uuid::new_v4();
    let lease = match hub.socket_lease("acquire", id, &subject).await {
        Ok(lease) => lease,
        Err(error) => {
            hub.metrics.socket_handshake_rejected("redis_busy");
            return Err(error);
        }
    };
    if !lease {
        hub.metrics.socket_handshake_rejected("lease_limit");
        return Err(AppError::TooManyRequests);
    }
    let connection_span = tracing::info_span!("prices.connection", connection_id = %id, close_reason = tracing::field::Empty);
    let failed_hub = hub.clone();
    let failed_subject = subject.clone();
    Ok(ws.read_buffer_size(4096).write_buffer_size(0).max_write_buffer_size(16 * 1024)
        .max_message_size(4096).max_frame_size(4096)
        .on_failed_upgrade(move |_| {
            tokio::spawn(async move { failed_hub.metrics.socket_closed("upgrade failed"); let _ = failed_hub.socket_lease("release", id, &failed_subject).await; });
        })
        .on_upgrade(move |socket| async move {
            let _permit = permit;
            let _active = crate::metrics::ActiveGauge::new(hub.metrics.ws_active.clone());
            tracing::info!("price socket opened");
            let mut updates = hub.subscribe();
            let (mut writer, mut reader) = socket.split();
            let initial = updates.borrow_and_update().clone();
            if let Some(initial) = initial {
                let started = Instant::now();
                let sent = tokio::time::timeout(
                    Duration::from_secs(2),
                    writer.send(Message::Text(initial.text.clone())),
                )
                .await;
                hub.metrics
                    .price_socket_send(started.elapsed().as_secs_f64());
                if !matches!(sent, Ok(Ok(()))) {
                    hub.metrics.socket_closed("send deadline");
                    let _ = hub.socket_lease("release", id, &subject).await; return;
                }
            }
            hub.metrics.ws_frames.inc();
            let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
            heartbeat.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip); heartbeat.tick().await;
            // Connections admitted in the same burst must not stampede the
            // bounded Redis command pool at a shared lease-renewal boundary.
            // UUID-derived phase is uniform enough for scheduling and does not
            // expose client or account data. The first renewal remains 10–20s
            // after acquisition, well inside the 60s lease.
            let first_lease_renewal = tokio::time::Instant::from_std(
                Instant::now() + socket_lease_initial_delay(id),
            );
            let mut lease = tokio::time::interval_at(
                first_lease_renewal,
                SOCKET_LEASE_RENEW_INTERVAL,
            );
            lease.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
            let mut drain = tokio::time::interval(Duration::from_secs(1));
            let mut last_message = Instant::now(); let mut received = 0u32;
            let close_reason = loop {
                tokio::select! {
                    _ = drain.tick() => { if state.health.is_draining() { break "server draining"; } }
                    _ = heartbeat.tick() => {
                        if last_message.elapsed() > Duration::from_secs(45) { break "heartbeat expired"; }
                        received = 0;
                        if !matches!(tokio::time::timeout(Duration::from_secs(2), writer.send(Message::Ping(Vec::new().into()))).await, Ok(Ok(()))) { break "send deadline"; }
                    }
                    _ = lease.tick() => {
                        if !matches!(hub.socket_lease("renew", id, &subject).await, Ok(true)) { break "connection lease unavailable"; }
                    }
                    changed = updates.changed() => {
                        if changed.is_err() { break "feed stopped"; }
                        let frame = updates.borrow_and_update().clone();
                        if let Some(frame) = frame {
                            let started = Instant::now();
                            let sent = tokio::time::timeout(
                                Duration::from_secs(2),
                                writer.send(Message::Text(frame.text.clone())),
                            )
                            .await;
                            hub.metrics
                                .price_socket_send(started.elapsed().as_secs_f64());
                            if !matches!(sent, Ok(Ok(()))) { break "send deadline"; }
                            hub.metrics.ws_frames.inc();
                        }
                    }
                    incoming = reader.next() => {
                        received += 1;
                        if received > 32 { break "message rate exceeded"; }
                        match incoming {
                            Some(Ok(Message::Pong(_) | Message::Ping(_))) => { last_message = Instant::now(); }
                            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break "peer closed",
                            _ => break "fixed price feed accepts no client commands",
                        }
                    }
                }
            };
            hub.metrics.socket_closed(close_reason);
            tracing::Span::current().record("close_reason", close_reason);
            tracing::info!("price socket closed");
            let _ = tokio::time::timeout(Duration::from_millis(250), writer.send(Message::Close(Some(CloseFrame { code: 1001, reason: close_reason.into() })))).await;
            let _ = hub.socket_lease("release", id, &subject).await;
        }.instrument(connection_span)))
}

#[cfg(test)]
mod lease_schedule_tests {
    use super::*;

    #[test]
    fn socket_lease_renewal_phase_is_bounded_and_varies_by_connection_id() {
        let first = socket_lease_initial_delay(Uuid::from_u128(0));
        let second = socket_lease_initial_delay(Uuid::from_u128(1u128 << 112));
        assert_eq!(
            first,
            SOCKET_LEASE_RENEW_MIN_DELAY + Duration::from_millis(0)
        );
        assert_eq!(
            second,
            SOCKET_LEASE_RENEW_MIN_DELAY + Duration::from_millis(1)
        );
        for seed in 0..10_000u128 {
            let delay = socket_lease_initial_delay(Uuid::from_u128(seed << 112));
            assert!(delay >= SOCKET_LEASE_RENEW_MIN_DELAY);
            assert!(
                delay
                    < SOCKET_LEASE_RENEW_MIN_DELAY
                        + Duration::from_millis(SOCKET_LEASE_RENEW_JITTER_MS)
            );
        }
    }
}
