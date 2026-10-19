//! Fixed-origin, read-only provider transport. Shared Redis admission is mandatory.
use crate::{metrics::Metrics, redis_store::RedisStore};
use reqwest::{Method, StatusCode};
use serde::Serialize;
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::Semaphore;

const GATE: &str = include_str!("../scripts/provider_read_gate.lua");
const COOLDOWN: &str = include_str!("../scripts/provider_read_cooldown.lua");
const MAX_BODY: usize = 256 * 1024;

#[derive(Clone, Copy, Debug)]
pub enum ReadProvider {
    Morpho,
    Aave,
}
impl ReadProvider {
    pub fn name(self) -> &'static str {
        match self {
            Self::Morpho => "morpho",
            Self::Aave => "aave",
        }
    }
    fn origin(self) -> &'static str {
        match self {
            Self::Morpho => "https://api.morpho.org",
            Self::Aave => "https://api.v3.aave.com",
        }
    }
    fn domain(self) -> &'static str {
        match self {
            Self::Morpho => "provider-read-morpho",
            Self::Aave => "provider-read-aave",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum ReadError {
    #[error("provider read admission unavailable")]
    Busy,
    #[error("provider read is cooling down")]
    CoolingDown,
    #[error("provider read timed out")]
    Timeout,
    #[error("provider read unavailable")]
    Unavailable,
    #[error("provider rejected the read")]
    Rejected,
    #[error("provider entity not found")]
    NotFound,
    #[error("provider response failed validation")]
    InvalidResponse,
    #[error("invalid provider target")]
    InvalidTarget,
}
impl ReadError {
    pub fn code(self) -> &'static str {
        match self {
            Self::Busy => "busy",
            Self::CoolingDown => "cooldown",
            Self::Timeout => "timeout",
            Self::Unavailable => "unavailable",
            Self::Rejected => "rejected",
            Self::NotFound => "not_found",
            Self::InvalidResponse => "invalid_response",
            Self::InvalidTarget => "invalid_target",
        }
    }
}

#[derive(Clone)]
pub struct ReadTransport {
    inner: Arc<Inner>,
}
struct Inner {
    client: reqwest::Client,
    redis: RedisStore,
    metrics: Arc<Metrics>,
    permits: Semaphore,
    // Test override is compiled only for module tests; runtime callers cannot select an origin.
    #[cfg(test)]
    test_origin: Option<String>,
}
impl ReadTransport {
    pub fn new(redis: RedisStore, metrics: Arc<Metrics>) -> Result<Self, ReadError> {
        let client = reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(1))
            .timeout(Duration::from_secs(4))
            .redirect(reqwest::redirect::Policy::none())
            .pool_max_idle_per_host(2)
            .user_agent("HoneyWallet/0.1 public-earn-reader")
            .build()
            .map_err(|_| ReadError::Unavailable)?;
        Ok(Self {
            inner: Arc::new(Inner {
                client,
                redis,
                metrics,
                permits: Semaphore::new(4),
                #[cfg(test)]
                test_origin: None,
            }),
        })
    }
    // Only provider adapters can construct requests; these methods are not a URL proxy.
    pub(super) async fn morpho(&self, path: &str) -> Result<Vec<u8>, ReadError> {
        self.read(ReadProvider::Morpho, Method::GET, path, None::<&()>)
            .await
    }
    pub(super) async fn aave(&self, body: &impl Serialize) -> Result<Vec<u8>, ReadError> {
        self.read(ReadProvider::Aave, Method::POST, "/graphql", Some(body))
            .await
    }
    #[tracing::instrument(name = "provider.earn_read", skip_all, fields(provider = provider.name(), otel.kind = "client"))]
    async fn read<T: Serialize + ?Sized>(
        &self,
        provider: ReadProvider,
        method: Method,
        path: &str,
        body: Option<&T>,
    ) -> Result<Vec<u8>, ReadError> {
        let started = Instant::now();
        let result = self.read_inner(provider, method, path, body).await;
        self.inner.metrics.earn_read(
            provider.name(),
            result.as_ref().err().map(|e| e.code()).unwrap_or("ok"),
            started.elapsed().as_secs_f64(),
        );
        result
    }
    async fn read_inner<T: Serialize + ?Sized>(
        &self,
        provider: ReadProvider,
        method: Method,
        path: &str,
        body: Option<&T>,
    ) -> Result<Vec<u8>, ReadError> {
        let _permit = self
            .inner
            .permits
            .try_acquire()
            .map_err(|_| ReadError::Busy)?;
        // Bound waiting for shared spacing; never queue arbitrary frontend traffic here.
        tokio::time::timeout(Duration::from_secs(4), self.admit(provider))
            .await
            .map_err(|_| ReadError::Busy)??;
        let origin = provider.origin();
        #[cfg(test)]
        let origin = self.inner.test_origin.as_deref().unwrap_or(origin);
        let mut request = self
            .inner
            .client
            .request(method, format!("{origin}{path}"))
            .header(reqwest::header::ACCEPT, "application/json");
        if let Some(body) = body {
            request = request.json(body);
        }
        let response = request.send().await;
        let mut response = match response {
            Ok(response) => response,
            Err(error) => {
                self.cooldown(provider, Some(10_000)).await?;
                return Err(if error.is_timeout() {
                    ReadError::Timeout
                } else {
                    ReadError::Unavailable
                });
            }
        };
        let status = response.status();
        if !status.is_success() {
            if status == StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
                let delay = retry_after_ms(
                    response
                        .headers()
                        .get(reqwest::header::RETRY_AFTER)
                        .and_then(|h| h.to_str().ok()),
                    SystemTime::now(),
                );
                self.cooldown(provider, delay).await?;
                return Err(if status == StatusCode::TOO_MANY_REQUESTS {
                    ReadError::CoolingDown
                } else {
                    ReadError::Unavailable
                });
            }
            return Err(if status == StatusCode::NOT_FOUND {
                ReadError::NotFound
            } else {
                ReadError::Rejected
            });
        }
        if response
            .content_length()
            .is_some_and(|n| n > MAX_BODY as u64)
        {
            return Err(ReadError::InvalidResponse);
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(|e| {
            if e.is_timeout() {
                ReadError::Timeout
            } else {
                ReadError::Unavailable
            }
        })? {
            if bytes.len() + chunk.len() > MAX_BODY {
                return Err(ReadError::InvalidResponse);
            }
            bytes.extend_from_slice(&chunk);
        }
        Ok(bytes)
    }
    async fn admit(&self, provider: ReadProvider) -> Result<(), ReadError> {
        loop {
            let (status, wait): (i32, u64) = self
                .inner
                .redis
                .query(
                    redis::cmd("EVAL")
                        .arg(GATE)
                        .arg(2)
                        .arg(self.inner.redis.key(provider.domain(), "next"))
                        .arg(self.inner.redis.key(provider.domain(), "cooldown")),
                )
                .await
                .map_err(|_| ReadError::Busy)?;
            match status {
                1 => return Ok(()),
                2 => return Err(ReadError::CoolingDown),
                0 if wait <= 1000 => tokio::time::sleep(Duration::from_millis(wait.max(1))).await,
                _ => return Err(ReadError::Busy),
            }
        }
    }
    async fn cooldown(&self, provider: ReadProvider, ms: Option<u64>) -> Result<(), ReadError> {
        let _: i32 = self
            .inner
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(COOLDOWN)
                    .arg(1)
                    .arg(self.inner.redis.key(provider.domain(), "cooldown"))
                    .arg(ms.map(|n| n.to_string()).unwrap_or_else(|| "hold".into())),
            )
            .await
            .map_err(|_| ReadError::Busy)?;
        Ok(())
    }
}
// Unknown/unrepresentable Retry-After requires manual investigation, never early retry.
pub(super) fn retry_after_ms(value: Option<&str>, now: SystemTime) -> Option<u64> {
    let Some(value) = value else {
        return Some(10_000);
    };
    let max = 366 * 24 * 60 * 60 * 1000;
    let ms = value
        .parse::<u64>()
        .ok()
        .and_then(|n| n.checked_mul(1000))
        .or_else(|| {
            httpdate::parse_http_date(value).ok().and_then(|t| {
                u64::try_from(t.duration_since(now).unwrap_or_default().as_millis()).ok()
            })
        })?;
    (ms <= max).then_some(ms.max(10_000))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn long_provider_cooldowns_are_not_shortened_to_normal_poll_interval() {
        assert_eq!(
            retry_after_ms(Some("604800"), SystemTime::now()),
            Some(604_800_000)
        );
        assert_eq!(
            retry_after_ms(Some("invalid-private-error"), SystemTime::now()),
            None
        );
        assert_eq!(retry_after_ms(None, SystemTime::now()), Some(10_000));
    }
}

#[cfg(test)]
mod integration {
    use super::*;
    use axum::{
        Router,
        body::{Body, Bytes},
        http::{Response, StatusCode as HttpStatus},
        routing::get,
    };
    use std::sync::atomic::{AtomicUsize, Ordering};
    fn transport(origin: String, namespace: &str) -> ReadTransport {
        let redis = RedisStore::new(
            redis::Client::open(std::env::var("TEST_REDIS_URL").expect("isolated TEST_REDIS_URL"))
                .unwrap(),
            namespace.into(),
            Duration::from_millis(500),
        );
        let mut t = ReadTransport::new(redis, Arc::new(Metrics::default())).unwrap();
        Arc::get_mut(&mut t.inner).unwrap().test_origin = Some(origin);
        t
    }
    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "requires isolated TEST_REDIS_URL and loopback HTTP"]
    async fn replicas_share_spacing_cooldown_and_http_safety_bounds() {
        let hits = Arc::new(AtomicUsize::new(0));
        let counter = hits.clone();
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let redirect = format!("{origin}/redirected");
        let app = Router::new()
            .route("/ok", get(|| async { "{}" }))
            .route(
                "/redirect",
                get(move || {
                    let location = redirect.clone();
                    async move {
                        Response::builder()
                            .status(302)
                            .header("location", location)
                            .body(Body::empty())
                            .unwrap()
                    }
                }),
            )
            .route(
                "/redirected",
                get(move || {
                    counter.fetch_add(1, Ordering::Relaxed);
                    async { "{}" }
                }),
            )
            .route(
                "/large",
                get(|| async {
                    Body::from_stream(futures_util::stream::iter([
                        Ok::<_, std::io::Error>(Bytes::from(vec![b'x'; MAX_BODY])),
                        Ok(Bytes::from_static(b"extra")),
                    ]))
                }),
            )
            .route(
                "/slow",
                get(|| async {
                    tokio::time::sleep(Duration::from_secs(5)).await;
                    "{}"
                }),
            )
            .route(
                "/limited",
                get(|| async {
                    (
                        HttpStatus::TOO_MANY_REQUESTS,
                        [("retry-after", "604800")],
                        "private-provider-body",
                    )
                }),
            );
        let task = tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });
        let namespace = format!("earn-test:{}", uuid::Uuid::new_v4().simple());
        let a = transport(origin.clone(), &namespace);
        let b = transport(origin.clone(), &namespace);
        let started = Instant::now();
        let (one, two) = tokio::join!(a.morpho("/ok"), b.morpho("/ok"));
        assert!(one.is_ok() && two.is_ok());
        assert!(started.elapsed() >= Duration::from_millis(900));
        assert_eq!(
            a.morpho("/redirect").await.unwrap_err(),
            ReadError::Rejected
        );
        assert_eq!(hits.load(Ordering::Relaxed), 0);
        // Redis failure must prevent outbound reads, rather than bypass shared quotas.
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed_address = closed.local_addr().unwrap();
        drop(closed);
        let unavailable_redis = RedisStore::new(
            redis::Client::open(format!("redis://{closed_address}")).unwrap(),
            "unavailable".into(),
            Duration::from_millis(100),
        );
        let mut unavailable =
            ReadTransport::new(unavailable_redis, Arc::new(Metrics::default())).unwrap();
        Arc::get_mut(&mut unavailable.inner).unwrap().test_origin = Some(origin.clone());
        assert_eq!(
            unavailable.morpho("/redirected").await.unwrap_err(),
            ReadError::Busy
        );
        assert_eq!(hits.load(Ordering::Relaxed), 0);

        assert_eq!(
            a.morpho("/large").await.unwrap_err(),
            ReadError::InvalidResponse
        );
        assert_eq!(
            a.morpho("/limited").await.unwrap_err(),
            ReadError::CoolingDown
        );
        let start = Instant::now();
        assert_eq!(b.morpho("/ok").await.unwrap_err(), ReadError::CoolingDown);
        assert!(start.elapsed() < Duration::from_millis(500));
        let ttl: i64 = a
            .inner
            .redis
            .query(
                redis::cmd("PTTL")
                    .arg(a.inner.redis.key(ReadProvider::Morpho.domain(), "cooldown")),
            )
            .await
            .unwrap();
        assert!(ttl > 604_790_000);
        // A stale/shorter failure cannot erase the shared seven-day cooldown.
        b.cooldown(ReadProvider::Morpho, Some(10_000))
            .await
            .unwrap();
        let ttl2: i64 = a
            .inner
            .redis
            .query(
                redis::cmd("PTTL")
                    .arg(a.inner.redis.key(ReadProvider::Morpho.domain(), "cooldown")),
            )
            .await
            .unwrap();
        assert!(ttl2 > 604_790_000);
        b.cooldown(ReadProvider::Morpho, None).await.unwrap();
        a.cooldown(ReadProvider::Morpho, Some(10_000))
            .await
            .unwrap();
        let hold: String = a
            .inner
            .redis
            .query(
                redis::cmd("GET").arg(a.inner.redis.key(ReadProvider::Morpho.domain(), "cooldown")),
            )
            .await
            .unwrap();
        assert_eq!(hold, "hold");
        let slow = transport(origin, &format!("{namespace}:slow"));
        assert_eq!(slow.morpho("/slow").await.unwrap_err(), ReadError::Timeout);
        for t in [&a, &slow] {
            let _: i32 = t
                .inner
                .redis
                .query(
                    redis::cmd("DEL")
                        .arg(t.inner.redis.key(ReadProvider::Morpho.domain(), "cooldown"))
                        .arg(t.inner.redis.key(ReadProvider::Morpho.domain(), "next")),
                )
                .await
                .unwrap();
        }
        task.abort();
        let _ = task.await;
    }
}
