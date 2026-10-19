//! Shared admission for an operator-approved RPC account, independent of URL/key.
use super::evm_rpc::RpcError;
use crate::redis_store::RedisStore;
use serde::Deserialize;
use std::time::Duration;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RpcBudgetConfig {
    pub scope: String,
    pub interval_ms: u64,
    pub simulation_cost: u16,
}
#[derive(Clone)]
pub struct RpcBudget {
    redis: RedisStore,
    domain: String,
    fingerprint: String,
    config: RpcBudgetConfig,
}
impl RpcBudget {
    pub fn new(redis: RedisStore, config: RpcBudgetConfig) -> Result<Self, RpcError> {
        if config.scope.is_empty()
            || config.scope.len() > 64
            || !config
                .scope
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-')
            || !(1..=60_000).contains(&config.interval_ms)
            || !(1..=1000).contains(&config.simulation_cost)
        {
            return Err(RpcError::Configuration);
        }
        Ok(Self {
            redis,
            domain: format!("rpc-budget-{}", config.scope),
            fingerprint: format!("v1:{}:{}", config.interval_ms, config.simulation_cost),
            config,
        })
    }
    pub(super) async fn admit(&self, simulation: bool) -> Result<(), RpcError> {
        let cost = if simulation {
            u64::from(self.config.simulation_cost)
        } else {
            1
        };
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let (status, wait): (i32, u64) = self
                    .redis
                    .query(
                        redis::cmd("EVAL")
                            .arg(include_str!("../scripts/rpc_budget.lua"))
                            .arg(3)
                            .arg(self.redis.key(&self.domain, "policy"))
                            .arg(self.redis.key(&self.domain, "next"))
                            .arg(self.redis.key(&self.domain, "cooldown"))
                            .arg(&self.fingerprint)
                            .arg(self.config.interval_ms * cost),
                    )
                    .await
                    .map_err(|_| RpcError::Busy)?;
                match status {
                    1 => return Ok(()),
                    2 => return Err(RpcError::CoolingDown),
                    3 => return Err(RpcError::Configuration),
                    0 => tokio::time::sleep(Duration::from_millis(wait.clamp(1, 2000))).await,
                    _ => return Err(RpcError::Busy),
                }
            }
        })
        .await
        .map_err(|_| RpcError::Busy)?
    }
    pub(super) async fn cooldown(&self, ms: Option<u64>) -> Result<(), RpcError> {
        let _: i32 = self
            .redis
            .query(
                redis::cmd("EVAL")
                    .arg(include_str!("../scripts/provider_read_cooldown.lua"))
                    .arg(1)
                    .arg(self.redis.key(&self.domain, "cooldown"))
                    .arg(ms.map(|v| v.to_string()).unwrap_or_else(|| "hold".into())),
            )
            .await
            .map_err(|_| RpcError::Busy)?;
        Ok(())
    }
}
