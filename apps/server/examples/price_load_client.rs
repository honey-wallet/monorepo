#![recursion_limit = "256"]

//! External load generator for a separately running Honey API replica.
//!
//! Unlike `price_load`, this process does not host the API, so its RSS/CPU does
//! not include generator allocations. Set LOAD_SERVER_PID to sample the API
//! process with `ps`; process-level sampling is advisory (not cgroup accounting).
use futures_util::StreamExt;
use honey_server::markets::PriceSnapshot;
use k256::ecdsa::SigningKey;
use serde_json::json;
use siwe::Message as SiweMessage;
use std::{
    net::IpAddr,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tokio_tungstenite::{
    connect_async,
    tungstenite::{Message, client::IntoClientRequest, http::HeaderValue},
};
use uuid::Uuid;

const DEFAULT_PRICE_PATH: &str = "/api/v1/prices";
const AUTHENTICATED_PROFILE_PATH: &str = "/api/v1/me";

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let ws_url = std::env::var("LOAD_WS_URL").ok();
    if let Some(url) = &ws_url {
        anyhow::ensure!(
            url.starts_with("ws://"),
            "this local generator supports ws:// only"
        );
    }
    let http_url = std::env::var("LOAD_HTTP_URL").unwrap_or_else(|_| {
        ws_url.as_ref().map_or_else(String::new, |url| {
            url.replacen("ws://", "http://", 1)
                .replace("/api/v1/stream/prices", DEFAULT_PRICE_PATH)
        })
    });
    let authenticated_profile = boolean("LOAD_AUTHENTICATED_PROFILE", false)?;
    let authenticated_principals = number("LOAD_AUTHENTICATED_PRINCIPALS", 1usize)?;
    let principal_offset = number("LOAD_PRINCIPAL_OFFSET", 0usize)?;
    anyhow::ensure!((1..=15).contains(&authenticated_principals));
    anyhow::ensure!(principal_offset + authenticated_principals <= 15);
    anyhow::ensure!(
        authenticated_profile || authenticated_principals == 1,
        "LOAD_AUTHENTICATED_PRINCIPALS requires authenticated profile mode"
    );
    if authenticated_profile {
        anyhow::ensure!(
            is_local_profile_url(&http_url),
            "authenticated test mode is restricted to local http://127.0.0.1 or http://localhost /api/v1/me"
        );
    }
    let users = number("LOAD_USERS", 10_000usize)?;
    anyhow::ensure!(
        (1..=10_000).contains(&users) || (users == 0 && authenticated_profile),
        "LOAD_USERS may be zero only for authenticated profile-only mode"
    );
    anyhow::ensure!(
        users == 0 || ws_url.is_some(),
        "LOAD_WS_URL is required when LOAD_USERS > 0"
    );
    let soak_seconds = number("LOAD_SECONDS", 60u64)?;
    if authenticated_profile {
        anyhow::ensure!(
            soak_seconds < 14 * 60,
            "authenticated local sessions are short-lived; keep the soak under 14 minutes"
        );
    }
    let ramp_ms = number("LOAD_RAMP_MS", 30_000u64)?;
    let http_enabled = boolean("LOAD_HTTP_ENABLED", true)?;
    let test_client_ip = std::env::var("LOAD_TEST_CLIENT_IP")
        .ok()
        .map(|value| {
            value
                .parse::<IpAddr>()
                .map_err(|_| anyhow::anyhow!("LOAD_TEST_CLIENT_IP must be an IP address"))
        })
        .transpose()?;
    if test_client_ip.is_some() {
        anyhow::ensure!(
            test_client_ip_is_allowed(test_client_ip, &http_url, ws_url.as_deref()),
            "LOAD_TEST_CLIENT_IP must be loopback and is allowed only for loopback HTTP/WebSocket targets"
        );
    }
    let aggregate_http_rps = number("LOAD_HTTP_RPS", 100u64)?;
    let http_shard_index = number("LOAD_HTTP_SHARD_INDEX", 0u64)?;
    let http_shard_count = number("LOAD_HTTP_SHARD_COUNT", 1u64)?;
    anyhow::ensure!(http_shard_count > 0 && http_shard_index < http_shard_count);
    anyhow::ensure!(aggregate_http_rps > 0 && aggregate_http_rps <= 10_000);
    anyhow::ensure!(aggregate_http_rps % http_shard_count == 0);
    anyhow::ensure!(
        http_enabled || !authenticated_profile,
        "authenticated profile mode requires HTTP load"
    );
    anyhow::ensure!(http_shard_count == 1 || http_enabled);
    let http_rps = aggregate_http_rps / http_shard_count;
    let run_id_explicit = std::env::var("LOAD_RUN_ID").ok();
    let run_id = run_id_explicit
        .as_deref()
        .map(Uuid::parse_str)
        .transpose()?;
    let run_id = run_id.unwrap_or_else(Uuid::new_v4);
    let requested_start_unix_ms = std::env::var("LOAD_START_AT_UNIX_MS")
        .ok()
        .map(|value| value.parse::<u64>())
        .transpose()?;
    anyhow::ensure!(
        http_shard_count == 1 || (run_id_explicit.is_some() && requested_start_unix_ms.is_some()),
        "sharded mode requires a shared LOAD_RUN_ID and LOAD_START_AT_UNIX_MS"
    );
    if authenticated_profile {
        anyhow::ensure!(
            run_id_explicit.is_some() && requested_start_unix_ms.is_some(),
            "authenticated profile runs require a shared LOAD_RUN_ID and LOAD_START_AT_UNIX_MS"
        );
    }
    let max_http_errors = number("LOAD_MAX_HTTP_ERRORS", 0u64)?;
    let min_frames_per_client = number(
        "LOAD_MIN_FRAMES_PER_CLIENT",
        if users == 0 { 0 } else { 45 },
    )?;
    anyhow::ensure!((1..=3600).contains(&soak_seconds));
    anyhow::ensure!(
        ramp_ms >= users as u64 / 100,
        "ramp must be >=10ms per client"
    );
    anyhow::ensure!((1..=10_000).contains(&aggregate_http_rps));

    let mut test_headers = reqwest::header::HeaderMap::new();
    if let Some(ip) = test_client_ip {
        test_headers.insert(
            "x-forwarded-for",
            ip.to_string().parse::<reqwest::header::HeaderValue>()?,
        );
    }
    let http_client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .redirect(reqwest::redirect::Policy::none())
        .default_headers(test_headers)
        .build()?;
    let principals = if authenticated_profile {
        let mut sessions = Vec::with_capacity(authenticated_principals);
        for key_id in 1..=authenticated_principals {
            sessions.push(
                create_local_test_session(
                    &http_client,
                    &http_url,
                    (principal_offset + key_id) as u64,
                )
                .await?,
            );
        }
        anyhow::ensure!(
            principals_are_distinct(&sessions),
            "local SIWE sessions did not produce distinct user and wallet IDs"
        );
        Some(Arc::new(sessions))
    } else {
        None
    };

    let connected = Arc::new(AtomicU64::new(0));
    let closed = Arc::new(AtomicU64::new(0));
    let connect_failures = Arc::new(ConnectFailures::default());
    let frame_count = Arc::new(AtomicU64::new(0));
    let client_frames = Arc::new((0..users).map(|_| AtomicU64::new(0)).collect::<Vec<_>>());
    let client_soak_frames = Arc::new((0..users).map(|_| AtomicU64::new(0)).collect::<Vec<_>>());
    let client_last_frame_ms = Arc::new((0..users).map(|_| AtomicU64::new(0)).collect::<Vec<_>>());
    let client_max_frame_gap_ms =
        Arc::new((0..users).map(|_| AtomicU64::new(0)).collect::<Vec<_>>());
    let soak_window = Arc::new(SoakWindow::new(Instant::now()));
    let mut tasks = Vec::with_capacity(users);
    let start = Instant::now();
    let interval = Duration::from_micros((ramp_ms * 1000 / users.max(1) as u64).max(1));
    for client_id in 0..users {
        let url = ws_url.as_ref().expect("validated WebSocket URL").clone();
        let connected = connected.clone();
        let closed = closed.clone();
        let frames = frame_count.clone();
        let per_client = client_frames.clone();
        let per_client_soak = client_soak_frames.clone();
        let last_frame = client_last_frame_ms.clone();
        let max_frame_gap = client_max_frame_gap_ms.clone();
        let run_started = start;
        let soak_window = soak_window.clone();
        let connect_failures = connect_failures.clone();
        tasks.push(tokio::spawn(async move {
            let Ok(request) = websocket_request(url, test_client_ip) else {
                connect_failures.other.fetch_add(1, Ordering::Relaxed);
                closed.fetch_add(1, Ordering::Relaxed);
                return;
            };
            let opened =
                tokio::time::timeout(Duration::from_secs(15), connect_async(request)).await;
            let (mut socket, _) = match opened {
                Ok(Ok(socket)) => socket,
                Err(_) => {
                    connect_failures.timeout.fetch_add(1, Ordering::Relaxed);
                    closed.fetch_add(1, Ordering::Relaxed);
                    return;
                }
                Ok(Err(error)) => {
                    connect_failures.record(&error);
                    closed.fetch_add(1, Ordering::Relaxed);
                    return;
                }
            };
            connected.fetch_add(1, Ordering::Relaxed);
            while let Some(message) = socket.next().await {
                match message {
                    Ok(Message::Text(text)) => {
                        if serde_json::from_str::<PriceSnapshot>(&text).is_err() {
                            break;
                        }
                        let processed_at = Instant::now();
                        let elapsed_ms =
                            processed_at.duration_since(run_started).as_millis() as u64;
                        let previous_ms = last_frame[client_id].swap(elapsed_ms, Ordering::Relaxed);
                        if previous_ms > 0 {
                            max_frame_gap[client_id].fetch_max(
                                elapsed_ms.saturating_sub(previous_ms),
                                Ordering::Relaxed,
                            );
                        }
                        frames.fetch_add(1, Ordering::Relaxed);
                        per_client[client_id].fetch_add(1, Ordering::Relaxed);
                        if soak_window.contains(processed_at) {
                            per_client_soak[client_id].fetch_add(1, Ordering::Relaxed);
                        }
                    }
                    Ok(Message::Ping(_)) => {}
                    Ok(Message::Close(_)) | Err(_) => break,
                    _ => {}
                }
            }
            let ended_ms = Instant::now().duration_since(run_started).as_millis() as u64;
            let previous_ms = last_frame[client_id].load(Ordering::Relaxed);
            if previous_ms > 0 {
                max_frame_gap[client_id]
                    .fetch_max(ended_ms.saturating_sub(previous_ms), Ordering::Relaxed);
            }
            connected.fetch_sub(1, Ordering::Relaxed);
            closed.fetch_add(1, Ordering::Relaxed);
        }));
        tokio::time::sleep(interval).await;
    }
    let ramp_elapsed_ms = start.elapsed().as_millis();
    let connect_count = connected.load(Ordering::Relaxed);
    // Convert the requested UTC rendezvous only after sign-in and the socket
    // launch ramp. A start that was future at process boot may have expired by
    // readiness; rejecting it here avoids silently shortening or skipping soak.
    let ready_at = Instant::now();
    let ready_unix_ms = unix_time_ms()?;
    let (planned_start_unix_ms, scheduled_start) =
        plan_run_start(requested_start_unix_ms, ready_unix_ms, ready_at)?;

    // Open-loop HTTP requests: scheduled independently of completion. If work
    // accumulates, report it as in-flight at the end instead of hiding stalls.
    let http_done = Arc::new(AtomicU64::new(0));
    let http_started = Arc::new(AtomicU64::new(0));
    let http_completed_before_deadline = Arc::new(AtomicU64::new(0));
    let http_issued_buckets = Arc::new(
        (0..soak_seconds)
            .map(|_| AtomicU64::new(0))
            .collect::<Vec<_>>(),
    );
    let http_completed_buckets = Arc::new(
        (0..soak_seconds)
            .map(|_| AtomicU64::new(0))
            .collect::<Vec<_>>(),
    );
    let http_errors = Arc::new(AtomicU64::new(0));
    let inflight = Arc::new(AtomicU64::new(0));
    let latency_us = Arc::new(tokio::sync::Mutex::new(Vec::<u64>::new()));
    let principal_request_counts = Arc::new(
        (0..principals.as_ref().map_or(0, |sessions| sessions.len()))
            .map(|_| AtomicU64::new(0))
            .collect::<Vec<_>>(),
    );
    // All shard processes wait on this same UTC epoch. A fixed global-slot phase
    // prevents each shard's first slot from landing at the same instant.
    eprintln!(
        "capacity_ready run_id={run_id} shard={http_shard_index}/{http_shard_count} sockets={connect_count}/{users} principals={} start_unix_ms={planned_start_unix_ms}",
        principals.as_ref().map_or(0, |sessions| sessions.len())
    );
    tokio::time::sleep_until(scheduled_start.into()).await;
    let actual_start_unix_ms = unix_time_ms()?;
    // Anchor every window and schedule to the shared monotonic deadline. If a
    // process wakes late, missed open-loop slots are visible as failures.
    let http_start = scheduled_start;
    let http_duration = Duration::from_secs(soak_seconds);
    let http_deadline = http_start + http_duration;
    soak_window.set(http_start, http_deadline);
    let global_slot_interval_ns = 1_000_000_000 / aggregate_http_rps;
    let request_interval = Duration::from_nanos(global_slot_interval_ns * http_shard_count);
    let expected_http_requests = if http_enabled {
        expected_http_requests(http_rps, soak_seconds)
    } else {
        0
    };
    let http_end = Arc::new(tokio::sync::Notify::new());
    let timer_end = http_end.clone();
    let timer = tokio::spawn(async move {
        tokio::time::sleep_until(http_deadline.into()).await;
        timer_end.notify_one();
    });
    // Treat the soak as [http_start, http_deadline): the first slot is at the
    // start boundary, and a hard count cap prevents a terminal extra tick.
    // Schedule against absolute deadlines. Delayed slots are recorded and skipped
    // instead of emitting a catch-up burst that distorts the target load.
    let mut next_request_due = http_start
        + Duration::from_nanos(if http_enabled {
            global_slot_interval_ns * http_shard_index
        } else {
            0
        });
    let mut scheduler_lag_max_us = 0u64;
    let mut scheduler_slots_skipped = 0u64;
    let mut requests = tokio::task::JoinSet::new();
    let started_at_deadline = loop {
        tokio::select! {
            _ = http_end.notified() => {
                let issued = http_started.load(Ordering::Relaxed);
                if next_request_due < http_deadline {
                    let lag = Instant::now().saturating_duration_since(next_request_due);
                    scheduler_lag_max_us = scheduler_lag_max_us.max(
                        lag.as_micros().min(u64::MAX as u128) as u64,
                    );
                }
                // Includes due slots that were never reached because the generator
                // was descheduled through the deadline.
                scheduler_slots_skipped = scheduler_slots_skipped.max(
                    expected_http_requests.saturating_sub(issued),
                );
                break issued;
            },
            _ = tokio::time::sleep_until(next_request_due.into()), if http_enabled && Instant::now() < http_deadline
                && http_started.load(Ordering::Relaxed) < expected_http_requests => {
                let scheduled_due = next_request_due;
                let actual_start = Instant::now();
                if actual_start >= http_deadline {
                    break http_started.load(Ordering::Relaxed);
                }
                let (next_due, skipped) = advance_open_loop_schedule(scheduled_due, actual_start, request_interval);
                next_request_due = next_due;
                scheduler_slots_skipped = scheduler_slots_skipped.saturating_add(skipped);
                scheduler_lag_max_us = scheduler_lag_max_us.max(
                    actual_start.duration_since(scheduled_due).as_micros().min(u64::MAX as u128) as u64,
                );
                let client = http_client.clone();
                let url = http_url.clone();
                let done = http_done.clone();
                let errors = http_errors.clone();
                let pending = inflight.clone();
                let started = http_started.clone();
                let completed_before_deadline = http_completed_before_deadline.clone();
                let completed_buckets = http_completed_buckets.clone();
                let latency = latency_us.clone();
                let principals = principals.clone();
                let principal_counts = principal_request_counts.clone();
                let scheduled = actual_start;
                let issue_second = actual_start.duration_since(http_start).as_secs() as usize;
                http_issued_buckets[issue_second.min(soak_seconds as usize - 1)].fetch_add(1, Ordering::Relaxed);
                pending.fetch_add(1, Ordering::Relaxed);
                let request_index = started.fetch_add(1, Ordering::Relaxed) as usize;
                let principal_id = principal_for_request(
                    request_index,
                    principals.as_ref().map_or(0, |items| items.len()),
                );
                if !principal_counts.is_empty() {
                    principal_counts[principal_id].fetch_add(1, Ordering::Relaxed);
                }
                requests.spawn(async move {
                    let principal = principals
                        .as_ref()
                        .map(|sessions| &sessions[principal_id % sessions.len()]);
                    let mut request = client.get(url);
                    if let Some(session) = principal {
                        request = request.bearer_auth(&session.token);
                    }
                    let ok = match request.send().await {
                        Ok(resp) if resp.status().is_success() => match resp.json::<serde_json::Value>().await {
                            Ok(body) => valid_http_response(
                                &body,
                                principal.is_some(),
                                principal.map(|session| session.wallet_address.as_str()),
                                principal.map(|session| (session.user_id.as_str(), session.wallet_id.as_str())),
                            ),
                            Err(_) => false,
                        },
                        _ => false,
                    };
                    let completed_at = Instant::now();
                    if completed_at < http_deadline {
                        completed_before_deadline.fetch_add(1, Ordering::Relaxed);
                        let second = completed_at.duration_since(http_start).as_secs() as usize;
                        completed_buckets[second.min(soak_seconds as usize - 1)].fetch_add(1, Ordering::Relaxed);
                    }
                    if !ok { errors.fetch_add(1, Ordering::Relaxed); }
                    let mut samples = latency.lock().await;
                    if samples.len() < 100_000 {
                        samples.push(scheduled.elapsed().as_micros() as u64);
                    }
                    done.fetch_add(1, Ordering::Relaxed);
                    pending.fetch_sub(1, Ordering::Relaxed);
                });
            }
            Some(_) = requests.join_next(), if !requests.is_empty() => {}
        }
    };
    while requests.join_next().await.is_some() {}
    timer.abort();
    // Derive deadline status from request start/completion timestamps after all
    // spawned work has drained. Sampling counters when the timer task wakes can
    // misclassify completions that happened at the deadline but were scheduled
    // on another Tokio worker before the main task handled its notification.
    let completed_at_deadline = http_completed_before_deadline.load(Ordering::Relaxed);
    let in_flight_at_deadline = in_flight_at_deadline(started_at_deadline, completed_at_deadline);

    let mut latencies = std::mem::take(&mut *latency_us.lock().await);
    latencies.sort_unstable();
    let p = |n: usize| {
        latencies
            .get(latencies.len().saturating_sub(1) * n / 100)
            .copied()
    };
    let server_pid = std::env::var("LOAD_SERVER_PID").ok();
    let server_resources = if let Some(pid) = server_pid {
        sample_ps(&pid).await.ok()
    } else {
        None
    };
    let client_frame_counts = client_frames
        .iter()
        .map(|count| count.load(Ordering::Relaxed))
        .collect::<Vec<_>>();
    let client_soak_frame_counts = client_soak_frames
        .iter()
        .map(|count| count.load(Ordering::Relaxed))
        .collect::<Vec<_>>();
    let clients_with_frames = client_last_frame_ms
        .iter()
        .filter(|last| last.load(Ordering::Relaxed) > 0)
        .count();
    let clients_with_no_frames = users.saturating_sub(clients_with_frames);
    let mut client_frame_gaps = client_last_frame_ms
        .iter()
        .zip(client_max_frame_gap_ms.iter())
        .filter(|(last, _)| last.load(Ordering::Relaxed) > 0)
        .map(|(_, gap)| gap.load(Ordering::Relaxed))
        .collect::<Vec<_>>();
    client_frame_gaps.sort_unstable();
    let percentile_gap = |n: usize| {
        client_frame_gaps
            .get(client_frame_gaps.len().saturating_sub(1) * n / 100)
            .copied()
    };
    let minimum_frames_for_any_client = client_soak_frame_counts.iter().copied().min().unwrap_or(0);
    let total_client_frames = client_frame_counts.iter().sum::<u64>();
    let total_soak_frames = client_soak_frame_counts.iter().sum::<u64>();
    let result = json!({
        "schemaVersion":4, "runId": run_id, "generator":"external-process", "profileOnly":users == 0, "targetWebSockets":users,
        "connectedAfterRamp":connect_count, "closedDuringRun":closed.load(Ordering::Relaxed),
        "connectionFailures":connect_failures.snapshot(),
        "connectionFailureStatusCodes":connect_failures.status_snapshot(),
        "rampMs":ramp_elapsed_ms, "soakSeconds":soak_seconds,
        "framesDuringSoak":total_soak_frames,
        "totalFrames":frame_count.load(Ordering::Relaxed), "clientFrameCountTotal":total_client_frames,
        "minimumFramesPerClientDuringSoak":minimum_frames_for_any_client,
        "minimumLifetimeFramesForAnyClient":client_frame_counts.iter().copied().min().unwrap_or(0),
        "clientsWithFrames":clients_with_frames,
        "clientsWithNoFrames":clients_with_no_frames,
        "clientsClosedByReportEnd":closed.load(Ordering::Relaxed),
        "clientFrameGapMs":{"p50":percentile_gap(50),"p95":percentile_gap(95),"p99":percentile_gap(99),"max":client_frame_gaps.last().copied()},
        "httpEnabled":http_enabled, "httpTargetRps":http_rps, "httpAggregateTargetRps":aggregate_http_rps,
        "httpShardIndex":http_shard_index,"httpShardCount":http_shard_count,
        "httpExpectedShardRequests":expected_http_requests,"plannedStartUnixMs":planned_start_unix_ms,
        "actualStartUnixMs":actual_start_unix_ms,"httpStartUnixMs":actual_start_unix_ms,
        "httpCompleted":http_done.load(Ordering::Relaxed),
        "httpRoute": if authenticated_profile { AUTHENTICATED_PROFILE_PATH } else { DEFAULT_PRICE_PATH },
        "httpAuthenticated":principals.is_some(), "authenticatedPrincipalCount":principals.as_ref().map_or(0, |sessions| sessions.len()),
        "authenticatedRequestsPerPrincipal":principal_request_counts.iter().map(|count| count.load(Ordering::Relaxed)).collect::<Vec<_>>(),
        "httpIssuedAtDeadline":started_at_deadline,
        "httpIssuedPerSecond":http_issued_buckets.iter().map(|n| n.load(Ordering::Relaxed)).collect::<Vec<_>>(),
        "httpSchedulerMaxLagMicros":scheduler_lag_max_us,
        "httpSchedulerSkippedSlots":scheduler_slots_skipped,
        "httpIssuedRpsAtDeadline":(started_at_deadline as f64 / soak_seconds as f64),
        "httpCompletedAtDeadline":completed_at_deadline,
        "httpCompletedPerSecond":http_completed_buckets.iter().map(|n| n.load(Ordering::Relaxed)).collect::<Vec<_>>(),
        "httpErrors":http_errors.load(Ordering::Relaxed), "httpInFlightAtDeadline":in_flight_at_deadline,
        "httpInFlightAfterDrain":inflight.load(Ordering::Relaxed),
        "httpLatencySamples":latencies.len(),
        "httpLatencyMicrosFirst100k":{"p50":p(50),"p95":p(95),"p99":p(99),"max":latencies.last().copied()},
        "httpObservedRpsIncludingDrain":(http_done.load(Ordering::Relaxed) as f64 / http_start.elapsed().as_secs_f64()),
        "httpCompletedRpsAtDeadline":(completed_at_deadline as f64 / soak_seconds as f64),
        "serverProcessSample":server_resources, "tls":false,
        "thresholds":{"maxHttpErrors":max_http_errors,"minFramesPerClientDuringSoak":min_frames_per_client}
    });
    println!("{}", serde_json::to_string_pretty(&result)?);
    let passed = connect_count == users as u64
        && closed.load(Ordering::Relaxed) == 0
        && open_loop_schedule_passes(
            started_at_deadline,
            expected_http_requests,
            scheduler_slots_skipped,
        )
        && http_capacity_passes(
            started_at_deadline,
            expected_http_requests,
            http_errors.load(Ordering::Relaxed),
            max_http_errors,
            in_flight_at_deadline,
            inflight.load(Ordering::Relaxed),
        )
        && minimum_frames_for_any_client >= min_frames_per_client;
    for task in tasks {
        task.abort();
    }
    anyhow::ensure!(
        passed,
        "external capacity thresholds failed; inspect JSON report"
    );
    Ok(())
}

fn boolean(name: &str, default: bool) -> anyhow::Result<bool> {
    match std::env::var(name) {
        Ok(value) if value.eq_ignore_ascii_case("true") => Ok(true),
        Ok(value) if value.eq_ignore_ascii_case("false") => Ok(false),
        Ok(_) => anyhow::bail!("{name} must be true or false"),
        Err(std::env::VarError::NotPresent) => Ok(default),
        Err(error) => Err(error.into()),
    }
}

fn unix_time_ms() -> anyhow::Result<u64> {
    Ok(SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .try_into()?)
}

fn plan_run_start(
    requested_start_unix_ms: Option<u64>,
    ready_unix_ms: u64,
    ready_at: Instant,
) -> anyhow::Result<(u64, Instant)> {
    match requested_start_unix_ms {
        Some(epoch_ms) => {
            anyhow::ensure!(
                epoch_ms > ready_unix_ms.saturating_add(1000),
                "shared start epoch must be at least one second in the future after sign-in and socket setup; increase LOAD_START_AT_UNIX_MS"
            );
            Ok((
                epoch_ms,
                ready_at + Duration::from_millis(epoch_ms - ready_unix_ms),
            ))
        }
        None => Ok((ready_unix_ms, ready_at)),
    }
}

/// Authenticate one disposable test principal through the real local SIWE routes.
/// Private key 1 is public test data and must never be used for funds.
async fn create_local_test_session(
    client: &reqwest::Client,
    profile_url: &str,
    key_id: u64,
) -> anyhow::Result<LocalSession> {
    anyhow::ensure!(is_local_profile_url(profile_url));
    anyhow::ensure!((1..=15).contains(&key_id), "test key ID must be in 1..=15");
    let base = profile_url
        .strip_suffix(AUTHENTICATED_PROFILE_PATH)
        .ok_or_else(|| anyhow::anyhow!("profile URL has an unexpected path"))?;
    let auth_config: serde_json::Value = client
        .get(format!("{base}/api/v1/auth/config"))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    anyhow::ensure!(
        auth_config["enabled"] == true,
        "local wallet auth is disabled"
    );
    let chain_id = auth_config["chainId"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("local auth chain is unavailable"))?;
    let challenge: LoadChallenge = client
        .post(format!("{base}/api/v1/auth/challenges"))
        .json(&serde_json::json!({"address": test_wallet_address(key_id)?, "chainId": chain_id}))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    let message: SiweMessage = challenge.message.parse()?;
    let mut private_key = [0u8; 32];
    private_key[24..].copy_from_slice(&key_id.to_be_bytes());
    let signer = SigningKey::from_bytes((&private_key).into())?;
    private_key.fill(0);
    let wallet = test_wallet_address(key_id)?;
    let (signature, recovery) = signer.sign_prehash_recoverable(&message.eip191_hash()?)?;
    let signature = format!(
        "0x{}{:02x}",
        hex::encode(signature.to_bytes()),
        recovery.to_byte() + 27
    );
    let session: LoadLoginResponse = client
        .post(format!("{base}/api/v1/auth/verify"))
        .json(&serde_json::json!({
            "challengeId": challenge.id,
            "signature": signature,
            "deviceId": Uuid::new_v4(),
        }))
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    anyhow::ensure!(
        session.profile.wallet.address.eq_ignore_ascii_case(&wallet),
        "local sign-in returned a different wallet"
    );
    anyhow::ensure!(
        !session.profile.user_id.is_empty(),
        "local sign-in returned an empty user ID"
    );
    anyhow::ensure!(
        !session.profile.wallet.id.is_empty(),
        "local sign-in returned an empty wallet ID"
    );
    anyhow::ensure!(
        session.access_token.len() == 64
            && session
                .access_token
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit()),
        "local sign-in returned an invalid access token"
    );
    Ok(LocalSession {
        token: session.access_token,
        user_id: session.profile.user_id,
        wallet_id: session.profile.wallet.id,
        wallet_address: wallet,
    })
}

struct LocalSession {
    token: String,
    user_id: String,
    wallet_id: String,
    wallet_address: String,
}

fn test_wallet_address(key_id: u64) -> anyhow::Result<String> {
    let mut private_key = [0u8; 32];
    private_key[24..].copy_from_slice(&key_id.to_be_bytes());
    let signer = SigningKey::from_bytes((&private_key).into())?;
    private_key.fill(0);
    let public_key = signer.verifying_key().to_encoded_point(false);
    let digest = alloy_primitives::keccak256(&public_key.as_bytes()[1..]);
    Ok(alloy_primitives::Address::from_slice(&digest[12..]).to_checksum(None))
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadChallenge {
    id: String,
    message: String,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadLoginResponse {
    access_token: String,
    profile: LoadProfile,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadProfile {
    user_id: String,
    wallet: LoadWallet,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoadWallet {
    id: String,
    address: String,
}

#[cfg(test)]
fn is_evm_address(value: &str) -> bool {
    value.len() == 42
        && value.starts_with("0x")
        && value.as_bytes()[2..].iter().all(u8::is_ascii_hexdigit)
}

fn is_local_profile_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port().is_some()
        && url.path() == AUTHENTICATED_PROFILE_PATH
        && url.query().is_none()
        && url.fragment().is_none()
}

fn http_url_is_local(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "http"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port().is_some()
        && matches!(url.path(), "/api/v1/me" | "/api/v1/prices")
        && url.query().is_none()
        && url.fragment().is_none()
}

fn is_local_websocket_url(value: &str) -> bool {
    let Ok(url) = reqwest::Url::parse(value) else {
        return false;
    };
    url.scheme() == "ws"
        && url.username().is_empty()
        && url.password().is_none()
        && matches!(url.host_str(), Some("127.0.0.1" | "localhost"))
        && url.port().is_some()
        && url.path() == "/api/v1/stream/prices"
        && url.query().is_none()
        && url.fragment().is_none()
}

fn test_client_ip_is_allowed(ip: Option<IpAddr>, http_url: &str, ws_url: Option<&str>) -> bool {
    ip.is_some_and(|ip| ip.is_loopback())
        && http_url_is_local(http_url)
        && ws_url.is_none_or(is_local_websocket_url)
}

fn websocket_request(
    url: String,
    test_client_ip: Option<IpAddr>,
) -> anyhow::Result<tokio_tungstenite::tungstenite::http::Request<()>> {
    let mut request = url.into_client_request()?;
    if let Some(ip) = test_client_ip {
        request
            .headers_mut()
            .insert("x-forwarded-for", HeaderValue::from_str(&ip.to_string())?);
    }
    Ok(request)
}

fn valid_http_response(
    body: &serde_json::Value,
    authenticated: bool,
    expected_wallet: Option<&str>,
    expected_identity: Option<(&str, &str)>,
) -> bool {
    if authenticated {
        let Some(expected) = expected_wallet else {
            return false;
        };
        expected_identity.is_some_and(|(expected_user, expected_wallet_id)| {
            body.get("userId").and_then(serde_json::Value::as_str) == Some(expected_user)
                && body
                    .get("wallet")
                    .and_then(|wallet| wallet.get("id"))
                    .and_then(serde_json::Value::as_str)
                    == Some(expected_wallet_id)
        }) && body
            .get("userId")
            .and_then(serde_json::Value::as_str)
            .is_some_and(|id| !id.is_empty())
            && body
                .get("wallet")
                .and_then(|wallet| wallet.get("address"))
                .and_then(serde_json::Value::as_str)
                .is_some_and(|address| address.eq_ignore_ascii_case(expected))
    } else {
        serde_json::from_value::<PriceSnapshot>(body.clone()).is_ok()
    }
}

fn principals_are_distinct(sessions: &[LocalSession]) -> bool {
    let users = sessions
        .iter()
        .map(|session| &session.user_id)
        .collect::<std::collections::HashSet<_>>();
    let wallets = sessions
        .iter()
        .map(|session| &session.wallet_id)
        .collect::<std::collections::HashSet<_>>();
    users.len() == sessions.len() && wallets.len() == sessions.len()
}

/// Return the next future slot, skipping missed slots instead of bursting to catch up.
fn advance_open_loop_schedule(due: Instant, now: Instant, interval: Duration) -> (Instant, u64) {
    let late = now.saturating_duration_since(due);
    let skipped = (late.as_nanos() / interval.as_nanos()).min(u64::MAX as u128) as u64;
    let steps = skipped.saturating_add(1);
    let advance_ns = interval
        .as_nanos()
        .saturating_mul(steps as u128)
        .min(u64::MAX as u128) as u64;
    let next = due + Duration::from_nanos(advance_ns);
    (next, skipped)
}

fn in_flight_at_deadline(started_before_deadline: u64, completed_before_deadline: u64) -> u64 {
    started_before_deadline.saturating_sub(completed_before_deadline)
}

fn expected_http_requests(target_rps: u64, soak_seconds: u64) -> u64 {
    target_rps.saturating_mul(soak_seconds)
}

fn open_loop_schedule_passes(issued: u64, expected: u64, skipped_slots: u64) -> bool {
    issued == expected && skipped_slots == 0
}

fn principal_for_request(request_index: usize, principal_count: usize) -> usize {
    request_index % principal_count.max(1)
}

#[derive(Default)]
struct ConnectFailures {
    timeout: AtomicU64,
    http_4xx: AtomicU64,
    http_5xx: AtomicU64,
    http_500: AtomicU64,
    http_502: AtomicU64,
    http_503: AtomicU64,
    http_504: AtomicU64,
    http_5xx_other: AtomicU64,
    io: AtomicU64,
    other: AtomicU64,
}

impl ConnectFailures {
    fn record(&self, error: &tokio_tungstenite::tungstenite::Error) {
        use tokio_tungstenite::tungstenite::Error;
        match error {
            Error::Http(response) if response.status().is_client_error() => {
                self.http_4xx.fetch_add(1, Ordering::Relaxed);
            }
            Error::Http(response) if response.status().is_server_error() => {
                self.http_5xx.fetch_add(1, Ordering::Relaxed);
                let bucket = match response.status().as_u16() {
                    500 => &self.http_500,
                    502 => &self.http_502,
                    503 => &self.http_503,
                    504 => &self.http_504,
                    _ => &self.http_5xx_other,
                };
                bucket.fetch_add(1, Ordering::Relaxed);
            }
            Error::Io(_) => {
                self.io.fetch_add(1, Ordering::Relaxed);
            }
            _ => {
                self.other.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    fn snapshot(&self) -> serde_json::Value {
        json!({
            "timeout": self.timeout.load(Ordering::Relaxed),
            "http4xx": self.http_4xx.load(Ordering::Relaxed),
            "http5xx": self.http_5xx.load(Ordering::Relaxed),
            "io": self.io.load(Ordering::Relaxed),
            "other": self.other.load(Ordering::Relaxed),
        })
    }

    fn status_snapshot(&self) -> serde_json::Value {
        json!({
            "500": self.http_500.load(Ordering::Relaxed),
            "502": self.http_502.load(Ordering::Relaxed),
            "503": self.http_503.load(Ordering::Relaxed),
            "504": self.http_504.load(Ordering::Relaxed),
            "other": self.http_5xx_other.load(Ordering::Relaxed),
        })
    }
}

fn http_capacity_passes(
    issued_at_deadline: u64,
    expected_requests: u64,
    errors: u64,
    max_errors: u64,
    in_flight_at_deadline: u64,
    in_flight_after_drain: u64,
) -> bool {
    issued_at_deadline == expected_requests
        && errors <= max_errors
        && in_flight_at_deadline == 0
        && in_flight_after_drain == 0
}

/// Defines the exact frame-counting window used by the external-load gate.
/// Frames validated before the HTTP soak starts or at/after its deadline are excluded,
/// even if the generator is delayed while draining HTTP work or writing results.
struct SoakWindow {
    origin: Instant,
    start_ns: AtomicU64,
    end_ns: AtomicU64,
}

impl SoakWindow {
    fn new(origin: Instant) -> Self {
        Self {
            origin,
            start_ns: AtomicU64::new(0),
            end_ns: AtomicU64::new(0),
        }
    }

    fn set(&self, start: Instant, end: Instant) {
        let start_ns = start
            .duration_since(self.origin)
            .as_nanos()
            .min(u64::MAX as u128) as u64;
        let end_ns = end
            .duration_since(self.origin)
            .as_nanos()
            .min(u64::MAX as u128) as u64;
        self.end_ns.store(end_ns, Ordering::Release);
        self.start_ns.store(start_ns, Ordering::Release);
    }

    fn contains(&self, instant: Instant) -> bool {
        let elapsed_ns = instant
            .duration_since(self.origin)
            .as_nanos()
            .min(u64::MAX as u128) as u64;
        let start_ns = self.start_ns.load(Ordering::Acquire);
        let end_ns = self.end_ns.load(Ordering::Acquire);
        start_ns != 0 && elapsed_ns >= start_ns && elapsed_ns < end_ns
    }
}

#[cfg(test)]
mod tests {
    use super::{
        ConnectFailures, LocalSession, SoakWindow, advance_open_loop_schedule,
        expected_http_requests, http_capacity_passes, http_url_is_local, in_flight_at_deadline,
        is_evm_address, is_local_profile_url, is_local_websocket_url, open_loop_schedule_passes,
        plan_run_start, principal_for_request, principals_are_distinct, test_client_ip_is_allowed,
        test_wallet_address, valid_http_response, websocket_request,
    };
    use std::time::{Duration, Instant};

    #[test]
    fn frame_window_excludes_ramp_and_deadline_or_later_frames() {
        let origin = Instant::now();
        let window = SoakWindow::new(origin);
        let start = origin + Duration::from_secs(1);
        let end = origin + Duration::from_secs(61);
        window.set(start, end);

        assert!(!window.contains(origin + Duration::from_millis(999)));
        assert!(window.contains(start));
        assert!(window.contains(end - Duration::from_nanos(1)));
        assert!(!window.contains(end));
        assert!(!window.contains(end + Duration::from_nanos(1)));
    }

    #[test]
    fn in_flight_uses_only_work_started_and_completed_before_deadline() {
        assert_eq!(in_flight_at_deadline(100, 96), 4);
        assert_eq!(in_flight_at_deadline(96, 100), 0);
    }

    #[test]
    fn target_schedule_has_exactly_rps_times_soak_slots() {
        assert_eq!(expected_http_requests(100, 60), 6_000);
        assert_eq!(expected_http_requests(2_000, 60), 120_000);
    }

    #[test]
    fn coordinated_start_is_validated_at_ready_and_local_start_begins_when_ready() {
        let ready_at = Instant::now();
        let (epoch, local_start) = plan_run_start(None, 10_000, ready_at).unwrap();
        assert_eq!(epoch, 10_000);
        assert_eq!(local_start, ready_at);

        let (epoch, coordinated_start) = plan_run_start(Some(13_000), 10_000, ready_at).unwrap();
        assert_eq!(epoch, 13_000);
        assert_eq!(coordinated_start, ready_at + Duration::from_secs(3));
        assert!(plan_run_start(Some(11_000), 10_000, ready_at).is_err());
        assert!(plan_run_start(Some(9_000), 10_000, ready_at).is_err());
    }

    #[test]
    fn open_loop_schedule_skips_late_slots_instead_of_bursting() {
        let due = Instant::now();
        let interval = Duration::from_millis(10);
        let (next, skipped) =
            advance_open_loop_schedule(due, due + Duration::from_millis(25), interval);
        assert_eq!(skipped, 2);
        assert_eq!(next, due + Duration::from_millis(30));
        let (on_time_next, on_time_skipped) = advance_open_loop_schedule(due, due, interval);
        assert_eq!(on_time_skipped, 0);
        assert_eq!(on_time_next, due + interval);
        assert!(open_loop_schedule_passes(6_000, 6_000, 0));
        assert!(!open_loop_schedule_passes(6_000, 6_000, 1));
        assert!(!open_loop_schedule_passes(5_999, 6_000, 1));
    }

    #[test]
    fn local_test_principals_are_distinct_and_requests_are_evenly_distributed() {
        let addresses = (1..=15)
            .map(|id| test_wallet_address(id).unwrap())
            .collect::<std::collections::HashSet<_>>();
        assert_eq!(addresses.len(), 15);
        assert_eq!(
            test_wallet_address(1).unwrap(),
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
        );
        let counts = (0..6_000).fold([0u64; 15], |mut counts, request| {
            counts[principal_for_request(request, 15)] += 1;
            counts
        });
        assert!(counts.iter().all(|count| *count == 400));
        assert_eq!(principal_for_request(0, 0), 0);
        let distinct = vec![
            LocalSession {
                token: String::new(),
                user_id: "u1".into(),
                wallet_id: "w1".into(),
                wallet_address: String::new(),
            },
            LocalSession {
                token: String::new(),
                user_id: "u2".into(),
                wallet_id: "w2".into(),
                wallet_address: String::new(),
            },
        ];
        assert!(principals_are_distinct(&distinct));
        let repeated_user = vec![
            LocalSession {
                token: String::new(),
                user_id: "u1".into(),
                wallet_id: "w1".into(),
                wallet_address: String::new(),
            },
            LocalSession {
                token: String::new(),
                user_id: "u1".into(),
                wallet_id: "w2".into(),
                wallet_address: String::new(),
            },
        ];
        assert!(!principals_are_distinct(&repeated_user));
        let repeated_wallet = vec![
            LocalSession {
                token: String::new(),
                user_id: "u1".into(),
                wallet_id: "w1".into(),
                wallet_address: String::new(),
            },
            LocalSession {
                token: String::new(),
                user_id: "u2".into(),
                wallet_id: "w1".into(),
                wallet_address: String::new(),
            },
        ];
        assert!(!principals_are_distinct(&repeated_wallet));
    }

    #[test]
    fn acceptance_rejects_an_extra_request_or_deadline_backlog() {
        assert!(http_capacity_passes(6_000, 6_000, 0, 0, 0, 0));
        assert!(!http_capacity_passes(6_001, 6_000, 0, 0, 0, 0));
        assert!(!http_capacity_passes(6_000, 6_000, 0, 0, 1, 0));
        assert!(!http_capacity_passes(6_000, 6_000, 0, 0, 0, 1));
    }

    #[test]
    fn authenticated_mode_is_local_and_requires_an_expected_wallet() {
        assert!(is_local_profile_url("http://127.0.0.1:8080/api/v1/me"));
        assert!(is_local_profile_url("http://localhost:8080/api/v1/me"));
        assert!(!is_local_profile_url("https://127.0.0.1:8080/api/v1/me"));
        assert!(!is_local_profile_url("http://127.0.0.1:8080/api/v1/prices"));
        assert!(!is_local_profile_url("http://example.com/api/v1/me"));
        assert!(!is_local_profile_url(
            "http://localhost:8080@evil.example/api/v1/me"
        ));
        assert!(!is_local_profile_url(
            "http://localhost:8080/api/v1/me?redirect=1"
        ));
        assert!(is_evm_address("0x0000000000000000000000000000000000000001"));
        assert!(!is_evm_address(
            "0x000000000000000000000000000000000000000g"
        ));
    }

    #[test]
    fn proxy_ip_simulation_is_loopback_only_and_applies_to_websocket_handshake() {
        assert!(http_url_is_local("http://127.0.0.1:8080/api/v1/me"));
        assert!(http_url_is_local("http://localhost:8080/api/v1/prices"));
        assert!(!http_url_is_local("https://127.0.0.1:8080/api/v1/me"));
        assert!(!http_url_is_local("http://example.com:8080/api/v1/me"));
        assert!(is_local_websocket_url(
            "ws://127.0.0.1:8080/api/v1/stream/prices"
        ));
        assert!(!is_local_websocket_url(
            "wss://127.0.0.1:8080/api/v1/stream/prices"
        ));
        assert!(!is_local_websocket_url(
            "ws://example.com:8080/api/v1/stream/prices"
        ));
        assert!(test_client_ip_is_allowed(
            Some("127.0.0.2".parse().unwrap()),
            "http://127.0.0.1:8080/api/v1/me",
            Some("ws://127.0.0.1:8080/api/v1/stream/prices"),
        ));
        assert!(!test_client_ip_is_allowed(
            Some("192.0.2.10".parse().unwrap()),
            "http://127.0.0.1:8080/api/v1/me",
            None,
        ));
        assert!(!test_client_ip_is_allowed(
            Some("127.0.0.2".parse().unwrap()),
            "http://example.com:8080/api/v1/me",
            None,
        ));
        let request = websocket_request(
            "ws://127.0.0.1:8080/api/v1/stream/prices".into(),
            Some("127.0.0.2".parse().unwrap()),
        )
        .unwrap();
        assert_eq!(request.headers()["x-forwarded-for"], "127.0.0.2");
        assert!(
            websocket_request(
                "ws://example.com:8080/api/v1/stream/prices".into(),
                Some("127.0.0.2".parse().unwrap()),
            )
            .is_ok()
        );
    }

    #[test]
    fn connection_failures_are_aggregated_into_bounded_categories() {
        use tokio_tungstenite::tungstenite::{Error, http::Response};

        let failures = ConnectFailures::default();
        failures.record(&Error::Io(std::io::Error::other("local test detail")));
        let response = Response::builder()
            .status(503)
            .body(None::<Vec<u8>>)
            .unwrap();
        failures.record(&Error::Http(Box::new(response)));
        let snapshot = failures.snapshot();
        assert_eq!(snapshot.as_object().unwrap().len(), 5);
        assert_eq!(snapshot["io"], 1);
        assert_eq!(snapshot["http5xx"], 1);
        assert_eq!(failures.status_snapshot()["503"], 1);
        assert_eq!(snapshot["http4xx"], 0);
        assert_eq!(snapshot["timeout"], 0);
        assert_eq!(snapshot["other"], 0);
        assert!(!snapshot.to_string().contains("local test detail"));
    }

    #[test]
    fn authenticated_profile_response_must_match_expected_wallet() {
        let body = serde_json::json!({
            "userId": "user-1",
            "wallet": {
                "id": "wallet-1",
                "address": "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
                "chainId": "eip155:1",
                "accountKind": "eoa"
            }
        });
        assert!(valid_http_response(
            &body,
            true,
            Some("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
            Some(("user-1", "wallet-1"))
        ));
        assert!(!valid_http_response(
            &body,
            true,
            Some("0x0000000000000000000000000000000000000001"),
            Some(("user-1", "wallet-1"))
        ));
        assert!(!valid_http_response(
            &body,
            true,
            None,
            Some(("user-1", "wallet-1"))
        ));
        assert!(!valid_http_response(
            &body,
            true,
            Some("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
            Some(("different-user", "wallet-1"))
        ));
        assert!(!valid_http_response(
            &body,
            true,
            Some("0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
            Some(("user-1", "different-wallet"))
        ));
    }
}

fn number<T: std::str::FromStr>(name: &str, default: T) -> anyhow::Result<T>
where
    T::Err: std::error::Error + Send + Sync + 'static,
{
    Ok(std::env::var(name)
        .ok()
        .map(|s| s.parse())
        .transpose()?
        .unwrap_or(default))
}

async fn sample_ps(pid: &str) -> anyhow::Result<serde_json::Value> {
    let output = Command::new("ps")
        .args(["-o", "%cpu=,rss=,etime=", "-p", pid])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()?;
    anyhow::ensure!(output.status.success());
    let line = String::from_utf8(output.stdout)?;
    Ok(json!({"pid":pid,"ps":"%CPU RSS_KiB ELAPSED","sample":line.trim()}))
}
