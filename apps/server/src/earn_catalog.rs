//! Fixed read registry and fenced cached observations. Never prepares a transaction.
use crate::{
    metrics::Metrics,
    providers::{
        earn::{EarnObservation, EarnProtocol, EarnReader, EarnTarget},
        transport::{ReadError, ReadTransport},
    },
    redis_store::RedisStore,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, HashSet},
    sync::{Arc, RwLock},
    time::{Duration, Instant},
};
use uuid::Uuid;
const CLAIM: &str = include_str!("scripts/earn_claim.lua");
const PUBLISH: &str = include_str!("scripts/earn_publish.lua");
const READ: &str = include_str!("scripts/earn_read.lua");
pub const FRESH_MS: u64 = 120_000;
const RETAIN_MS: u64 = 600_000;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReadProductConfig {
    pub protocol: EarnProtocol,
    pub chain_id: String,
    pub contract_address: String,
    pub asset_address: String,
    pub label: String,
}
#[derive(Clone)]
struct Product {
    id: String,
    config: ReadProductConfig,
    target: EarnTarget,
}
fn registry(entries: &[ReadProductConfig]) -> Result<Vec<Product>, ReadError> {
    if entries.len() > 8 {
        return Err(ReadError::InvalidTarget);
    }
    let mut seen = HashSet::new();
    entries
        .iter()
        .map(|config| {
            let chain = config
                .chain_id
                .parse::<u64>()
                .map_err(|_| ReadError::InvalidTarget)?;
            if chain.to_string() != config.chain_id
                || config.label.is_empty()
                || config.label.len() > 80
                || config.label.chars().any(|c| {
                    c.is_control() || matches!(c,'\u{202a}'..='\u{202e}'|'\u{2066}'..='\u{2069}')
                })
            {
                return Err(ReadError::InvalidTarget);
            }
            let target = EarnTarget::new(
                config.protocol,
                chain,
                &config.contract_address,
                &config.asset_address,
            )?;
            let identity = serde_json::to_vec(&(
                1,
                config.protocol,
                chain,
                config.contract_address.to_ascii_lowercase(),
                config.asset_address.to_ascii_lowercase(),
            ))
            .map_err(|_| ReadError::InvalidTarget)?;
            let id = hex::encode(Sha256::digest(identity));
            if !seen.insert(id.clone()) {
                return Err(ReadError::InvalidTarget);
            }
            Ok(Product {
                id,
                config: config.clone(),
                target,
            })
        })
        .collect()
}
pub fn validate_registry(entries: &[ReadProductConfig]) -> bool {
    registry(entries).is_ok()
}
pub fn parse_registry(raw: &str) -> Result<Vec<ReadProductConfig>, ReadError> {
    if raw.len() > 8192 {
        return Err(ReadError::InvalidTarget);
    }
    let entries: Vec<ReadProductConfig> =
        serde_json::from_str(raw).map_err(|_| ReadError::InvalidTarget)?;
    registry(&entries)?;
    Ok(entries)
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Cached {
    published_at_ms: u64,
    observation: EarnObservation,
}
struct Local {
    cached: Cached,
    age_ms: u64,
    installed: Instant,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EarnCatalog {
    pub schema_version: u8,
    pub status: &'static str,
    pub max_age_ms: u64,
    pub products: Vec<CatalogProduct>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProduct {
    pub id: String,
    pub label: String,
    pub protocol: EarnProtocol,
    pub chain_id: String,
    pub contract_address: String,
    pub asset_address: String,
    pub status: &'static str,
    pub age_ms: Option<u64>,
    pub observation: Option<EarnObservation>,
}
impl EarnCatalog {
    pub fn unconfigured() -> Self {
        Self {
            schema_version: 1,
            status: "not_configured",
            max_age_ms: FRESH_MS,
            products: vec![],
        }
    }
}
pub struct EarnCatalogHub {
    products: Vec<Product>,
    redis: RedisStore,
    reader: EarnReader,
    local: RwLock<BTreeMap<String, Local>>,
}
impl EarnCatalogHub {
    pub fn new(
        entries: &[ReadProductConfig],
        redis: RedisStore,
        metrics: Arc<Metrics>,
    ) -> Result<Self, ReadError> {
        Ok(Self {
            products: registry(entries)?,
            reader: EarnReader::new(ReadTransport::new(redis.clone(), metrics)?),
            redis,
            local: RwLock::new(BTreeMap::new()),
        })
    }
    pub fn snapshot(&self) -> EarnCatalog {
        let local = self.local.read().unwrap_or_else(|p| p.into_inner());
        let products: Vec<_> = self
            .products
            .iter()
            .map(|p| {
                let cached = local
                    .get(&p.id)
                    .map(|v| {
                        (
                            &v.cached,
                            v.age_ms
                                .saturating_add(v.installed.elapsed().as_millis() as u64),
                        )
                    })
                    .filter(|(_, age)| *age < RETAIN_MS);
                CatalogProduct {
                    id: p.id.clone(),
                    label: p.config.label.clone(),
                    protocol: p.config.protocol,
                    chain_id: p.config.chain_id.clone(),
                    contract_address: p.config.contract_address.to_ascii_lowercase(),
                    asset_address: p.config.asset_address.to_ascii_lowercase(),
                    status: match cached {
                        Some((_, age)) if age <= FRESH_MS => "fresh",
                        Some(_) => "stale",
                        None => "unavailable",
                    },
                    age_ms: cached.map(|(_, age)| age),
                    observation: cached.map(|(c, _)| c.observation.clone()),
                }
            })
            .collect();
        EarnCatalog {
            schema_version: 1,
            status: if products.is_empty() {
                "not_configured"
            } else if products.iter().all(|p| p.status == "fresh") {
                "ready"
            } else {
                "degraded"
            },
            max_age_ms: FRESH_MS,
            products,
        }
    }
    pub fn start(self: Arc<Self>) -> Vec<tokio::task::JoinHandle<()>> {
        self.start_for_role(crate::config::ServerRole::Combined)
    }
    pub fn start_for_role(
        self: Arc<Self>,
        role: crate::config::ServerRole,
    ) -> Vec<tokio::task::JoinHandle<()>> {
        let mut tasks = Vec::with_capacity(2);
        if role.runs_workers() {
            let collector = self.clone();
            tasks.push(tokio::spawn(async move {
                loop {
                    collector.collect_once().await;
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }));
        }
        if role.serves_api() {
            tasks.push(tokio::spawn(async move {
                loop {
                    self.refresh_local().await;
                    tokio::time::sleep(Duration::from_secs(5)).await;
                }
            }));
        }
        tasks
    }
    async fn collect_once(&self) {
        for product in &self.products {
            let owner = Uuid::new_v4();
            if !self.claim(product, &owner).await.unwrap_or(false) {
                continue;
            }
            let result =
                tokio::time::timeout(Duration::from_secs(27), self.reader.read(&product.target))
                    .await;
            match result {
                Ok(Ok(observation)) => match self.publish(product, &owner, observation).await {
                    Ok(true) => (),
                    Ok(false) => {
                        tracing::debug!(protocol = ?product.config.protocol, product_id = %product.id, error_code = "lease_lost", "Earn cache publication fenced out")
                    }
                    Err(error) => {
                        tracing::warn!(protocol = ?product.config.protocol, product_id = %product.id, error_code = error.code(), "Earn cache publication failed")
                    }
                },
                Ok(Err(error)) => {
                    tracing::warn!(protocol = ?product.config.protocol, product_id = %product.id, error_code = error.code(), "indexed Earn refresh failed; cached sample will age")
                }
                Err(_) => {
                    tracing::warn!(protocol = ?product.config.protocol, product_id = %product.id, error_code = "refresh_timeout", "indexed Earn refresh exceeded its deadline")
                }
            }
        }
    }
    async fn claim(&self, product: &Product, owner: &Uuid) -> Result<bool, ReadError> {
        let granted: i32 = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(CLAIM)
                    .arg(1)
                    .arg(self.control(product))
                    .arg(owner.to_string()),
            )
            .await
            .map_err(|_| ReadError::Busy)?;
        Ok(granted == 1)
    }
    async fn publish(
        &self,
        product: &Product,
        owner: &Uuid,
        observation: EarnObservation,
    ) -> Result<bool, ReadError> {
        if !observation.valid_for(&product.target) {
            return Err(ReadError::InvalidResponse);
        }
        let encoded =
            serde_json::to_string(&observation).map_err(|_| ReadError::InvalidResponse)?;
        let changed: i32 = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(PUBLISH)
                    .arg(2)
                    .arg(self.control(product))
                    .arg(self.cache(product))
                    .arg(owner.to_string())
                    .arg(encoded),
            )
            .await
            .map_err(|_| ReadError::Busy)?;
        Ok(changed == 1)
    }
    pub async fn refresh_local(&self) {
        for product in &self.products {
            let result: Result<(u64, String), _> = self
                .redis
                .query(redis::cmd("EVAL").arg(READ).arg(1).arg(self.cache(product)))
                .await;
            if let Ok((now, raw)) = result {
                let decoded = serde_json::from_str::<Cached>(&raw).ok().filter(|c| {
                    c.published_at_ms > 0
                        && c.published_at_ms <= now
                        && now - c.published_at_ms < RETAIN_MS
                        && c.observation.valid_for(&product.target)
                });
                let mut local = self.local.write().unwrap_or_else(|p| p.into_inner());
                if let Some(cached) = decoded {
                    let mut age_ms = now - cached.published_at_ms;
                    if let Some(old) = local.get(&product.id)
                        && old.cached.published_at_ms == cached.published_at_ms
                    {
                        age_ms = age_ms.max(
                            old.age_ms
                                .saturating_add(old.installed.elapsed().as_millis() as u64),
                        );
                    }
                    if local
                        .get(&product.id)
                        .is_none_or(|old| old.cached.published_at_ms <= cached.published_at_ms)
                    {
                        local.insert(
                            product.id.clone(),
                            Local {
                                cached,
                                age_ms,
                                installed: Instant::now(),
                            },
                        );
                    }
                } else {
                    local.remove(&product.id);
                }
            }
        }
    }
    fn control(&self, p: &Product) -> String {
        self.redis.key("earn", &format!("{}:control", p.id))
    }
    fn cache(&self, p: &Product) -> String {
        self.redis.key("earn", &format!("{}:snapshot", p.id))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn roles_start_only_their_assigned_tasks() {
        use crate::config::ServerRole;
        let cfg = crate::Config {
            redis_url: Some(crate::config::SecretUrl::new("redis://127.0.0.1:1".into())),
            ..Default::default()
        };
        let infrastructure = crate::runtime::Infrastructure::new(&cfg).unwrap();
        let hub = Arc::new(
            EarnCatalogHub::new(
                &[],
                infrastructure.redis().unwrap().clone(),
                infrastructure.metrics().clone(),
            )
            .unwrap(),
        );
        for (role, expected) in [
            (ServerRole::Api, 1),
            (ServerRole::Worker, 1),
            (ServerRole::Combined, 2),
        ] {
            let tasks = hub.clone().start_for_role(role);
            assert_eq!(tasks.len(), expected);
            // Abort before yielding: this checks task topology without contacting
            // Redis or an upstream provider.
            for task in &tasks {
                task.abort();
            }
            for task in tasks {
                assert!(task.await.unwrap_err().is_cancelled());
            }
        }
    }

    fn config() -> ReadProductConfig {
        ReadProductConfig {
            protocol: EarnProtocol::AaveV3,
            chain_id: "1".into(),
            contract_address: "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2".into(),
            asset_address: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".into(),
            label: "Aave Ethereum USDC".into(),
        }
    }
    #[test]
    fn read_registry_is_bounded_explicit_and_cannot_enable_execution() {
        assert!(validate_registry(&[]));
        assert!(validate_registry(&[config()]));
        assert!(!validate_registry(&[config(), config()]));
        assert!(!validate_registry(&vec![config(); 9]));
        let mut bad = config();
        bad.chain_id = "01".into();
        assert!(!validate_registry(&[bad]));
        assert!(parse_registry(r#"[{"protocol":"aave_v3","chainId":"1","contractAddress":"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2","assetAddress":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","label":"USDC","executionAvailable":true}]"#).is_err());
        assert!(
            crate::Config {
                earn_read_targets: vec![config()],
                ..Default::default()
            }
            .validate()
            .is_err()
        );
    }
    #[tokio::test]
    async fn unconfigured_api_is_explicit_and_uses_the_common_http_envelope() {
        use tower::ServiceExt;
        let response = crate::build_router(&Default::default())
            .oneshot(
                axum::http::Request::get("/api/v1/earn/catalog")
                    .body(axum::body::Body::empty())
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), 200);
        assert!(response.headers().contains_key("x-request-id"));
        assert_eq!(response.headers()["cache-control"], "no-store");
        let data: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(data["status"], "not_configured");
        assert_eq!(data["products"], serde_json::json!([]));
    }
    #[tokio::test]
    #[ignore = "requires isolated TEST_REDIS_URL"]
    async fn replicas_fence_publication_age_cached_data_and_reject_tampering() {
        use tower::ServiceExt;
        let cfg = crate::Config {
            redis_url: Some(crate::config::SecretUrl::new(
                std::env::var("TEST_REDIS_URL").expect("isolated TEST_REDIS_URL"),
            )),
            redis_namespace: format!("earn-cache-test:{}", Uuid::new_v4().simple()),
            earn_read_targets: vec![config()],
            ..Default::default()
        };
        let infrastructure = crate::runtime::Infrastructure::new(&cfg).unwrap();
        let a = infrastructure.earn().unwrap();
        let b = EarnCatalogHub::new(
            &cfg.earn_read_targets,
            infrastructure.redis().unwrap().clone(),
            infrastructure.metrics().clone(),
        )
        .unwrap();
        let p = &a.products[0];
        let first = Uuid::new_v4();
        let second = Uuid::new_v4();
        assert!(a.claim(p, &first).await.unwrap());
        assert!(!b.claim(p, &second).await.unwrap());
        let observations: Vec<EarnObservation> = serde_json::from_str(include_str!(
            "../../../docs/backend/results/earn-read-smoke-2026-10-18.json"
        ))
        .unwrap();
        let mut observation = observations[0].clone();
        observation.fetched_at_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(!b.publish(p, &second, observation.clone()).await.unwrap());
        let _: i32 = a
            .redis
            .query(
                redis::cmd("HSET")
                    .arg(a.control(p))
                    .arg("lease")
                    .arg(0)
                    .arg("next")
                    .arg(0),
            )
            .await
            .unwrap();
        assert!(b.claim(p, &second).await.unwrap());
        assert!(!a.publish(p, &first, observation.clone()).await.unwrap());
        assert!(b.publish(p, &second, observation.clone()).await.unwrap());
        // The API replica receives a different instance's publication through its
        // mirror task; it does not need to run an upstream collector.
        let api_tasks = a.clone().start_for_role(crate::config::ServerRole::Api);
        assert_eq!(api_tasks.len(), 1);
        let mirrored = tokio::time::timeout(Duration::from_secs(2), async {
            while a.snapshot().status != "ready" {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await;
        for task in api_tasks {
            task.abort();
            let _ = task.await;
        }
        mirrored.unwrap();
        b.refresh_local().await;
        assert_eq!(a.snapshot().status, "ready");
        assert_eq!(b.snapshot().status, "ready");
        let response = crate::build_router_with_infrastructure(
            &cfg,
            crate::runtime::RuntimeHealth::new(&cfg),
            &infrastructure,
        )
        .unwrap()
        .oneshot(
            axum::http::Request::get("/api/v1/earn/catalog")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
        let data: serde_json::Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), 65536)
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            data["products"][0]["observation"]["executionAvailable"],
            false
        );
        // Monotonic local age advances even if Redis cannot refresh the mirror.
        a.local.write().unwrap().get_mut(&p.id).unwrap().installed =
            Instant::now() - Duration::from_secs(121);
        assert_eq!(a.snapshot().products[0].status, "stale");
        // Re-reading the same cache sample must not make it younger.
        a.refresh_local().await;
        assert_eq!(a.snapshot().products[0].status, "stale");
        a.local.write().unwrap().get_mut(&p.id).unwrap().installed =
            Instant::now() - Duration::from_secs(601);
        assert!(a.snapshot().products[0].observation.is_none());
        let raw: String = a
            .redis
            .query(redis::cmd("GET").arg(a.cache(p)))
            .await
            .unwrap();
        let mut tampered: serde_json::Value = serde_json::from_str(&raw).unwrap();
        tampered["observation"]["executionAvailable"] = serde_json::json!(true);
        let _: String = a
            .redis
            .query(redis::cmd("SET").arg(a.cache(p)).arg(tampered.to_string()))
            .await
            .unwrap();
        b.refresh_local().await;
        assert_eq!(b.snapshot().products[0].status, "unavailable");
        let _: i32 = a
            .redis
            .query(redis::cmd("DEL").arg(a.control(p)).arg(a.cache(p)))
            .await
            .unwrap();
    }
}
