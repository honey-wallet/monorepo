//! Fixed-endpoint bounded RPC. Broadcast is restricted to journaled local-fork dispatch.
use super::{rpc_budget::RpcBudget, transport::retry_after_ms};
use crate::metrics::Metrics;
use serde_json::{Value, json};
use std::{
    sync::Arc,
    time::{Duration, Instant, SystemTime},
};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RpcError {
    #[error("invalid RPC configuration")]
    Configuration,
    #[error("RPC unavailable")]
    Unavailable,
    #[error("RPC returned an invalid response")]
    InvalidResponse,
    #[error("RPC rejected the read or simulation")]
    Rejected,
    #[error("RPC admission unavailable")]
    Busy,
    #[error("RPC account is cooling down")]
    CoolingDown,
}
#[derive(Clone)]
pub struct EvmReadRpc {
    client: reqwest::Client,
    endpoint: reqwest::Url,
    permits: Arc<Semaphore>,
    loopback: bool,
    budget: Option<RpcBudget>,
    metrics: Arc<Metrics>,
}
/// Single-use admission acquired before the durable dispatch journal. Dropping it
/// never refunds shared units. Private fields bind it to this exact RPC client.
pub(crate) struct LocalBroadcastPermit {
    rpc: EvmReadRpc,
    _permit: OwnedSemaphorePermit,
    granted: Instant,
}
impl LocalBroadcastPermit {
    #[tracing::instrument(name = "provider.evm_broadcast", skip_all)]
    pub(crate) async fn send(
        self,
        attempt: &crate::submissions::InitialDispatch,
    ) -> Result<(), RpcError> {
        if self.granted.elapsed() > Duration::from_secs(2) {
            return Err(RpcError::Busy);
        }
        let raw =
            zeroize::Zeroizing::new(format!("0x{}", hex::encode(attempt.expose_signed_bytes())));
        let started = Instant::now();
        let result = self
            .rpc
            .exchange("eth_sendRawTransaction", json!([raw.as_str()]))
            .await;
        let result = result.and_then(|v| {
            if v.as_str() == Some(attempt.transaction_hash().as_str()) {
                Ok(())
            } else {
                Err(RpcError::InvalidResponse)
            }
        });
        self.rpc.metrics.evm_rpc(
            "eth_sendRawTransaction",
            result.as_ref().err().copied(),
            started.elapsed().as_secs_f64(),
        );
        result
    }
}
impl EvmReadRpc {
    /// Uncoordinated transport is exclusively for literal-loopback test fixtures.
    pub fn new(endpoint: &str) -> Result<Self, RpcError> {
        Self::build(endpoint, None, Arc::new(Metrics::default()))
    }
    pub fn with_budget(
        endpoint: &str,
        budget: RpcBudget,
        metrics: Arc<Metrics>,
    ) -> Result<Self, RpcError> {
        Self::build(endpoint, Some(budget), metrics)
    }
    fn build(
        endpoint: &str,
        budget: Option<RpcBudget>,
        metrics: Arc<Metrics>,
    ) -> Result<Self, RpcError> {
        let url = reqwest::Url::parse(endpoint).map_err(|_| RpcError::Configuration)?;
        let loopback = url
            .host_str()
            .is_some_and(|s| s == "127.0.0.1" || s == "[::1]");
        if url.scheme() != "https" && !(url.scheme() == "http" && loopback)
            || !url.username().is_empty()
            || url.password().is_some()
            || url.fragment().is_some()
            || (budget.is_none() && !loopback)
        {
            return Err(RpcError::Configuration);
        }
        Ok(Self {
            client: reqwest::Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(12))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| RpcError::Configuration)?,
            endpoint: url,
            permits: Arc::new(Semaphore::new(4)),
            loopback,
            budget,
            metrics,
        })
    }
    pub fn is_loopback(&self) -> bool {
        self.loopback
    }
    #[tracing::instrument(name = "provider.evm_read", skip_all)]
    async fn request(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        let started = Instant::now();
        let result = self.request_inner(method, params).await;
        self.metrics.evm_rpc(
            method,
            result.as_ref().err().copied(),
            started.elapsed().as_secs_f64(),
        );
        result
    }
    async fn cooldown(&self, ms: Option<u64>) -> Result<(), RpcError> {
        if let Some(budget) = &self.budget {
            budget.cooldown(ms).await?;
        }
        Ok(())
    }
    async fn request_inner(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        // Reject excess tasks instead of maintaining an unbounded semaphore queue.
        let _permit = self.permits.try_acquire().map_err(|_| RpcError::Busy)?;
        if let Some(budget) = &self.budget {
            budget.admit(method == "eth_simulateV1").await?;
        }
        self.exchange(method, params).await
    }
    async fn exchange(&self, method: &'static str, params: Value) -> Result<Value, RpcError> {
        let response = self
            .client
            .post(self.endpoint.clone())
            .json(&json!({"jsonrpc":"2.0","id":1,"method":method,"params":params}))
            .send()
            .await;
        let mut response = match response {
            Ok(r) => r,
            Err(_) => {
                self.cooldown(Some(10_000)).await?;
                return Err(RpcError::Unavailable);
            }
        };
        let status = response.status();
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS || status.is_server_error() {
            self.cooldown(retry_after_ms(
                response
                    .headers()
                    .get(reqwest::header::RETRY_AFTER)
                    .and_then(|h| h.to_str().ok()),
                SystemTime::now(),
            ))
            .await?;
            return Err(if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
                RpcError::CoolingDown
            } else {
                RpcError::Unavailable
            });
        }
        if !status.is_success() {
            return Err(RpcError::Unavailable);
        }
        if response
            .content_length()
            .is_some_and(|len| len > 256 * 1024)
        {
            return Err(RpcError::InvalidResponse);
        }
        let mut body = Vec::new();
        loop {
            let chunk = match response.chunk().await {
                Ok(Some(chunk)) => chunk,
                Ok(None) => break,
                Err(_) => {
                    self.cooldown(Some(10_000)).await?;
                    return Err(RpcError::Unavailable);
                }
            };
            if body.len() + chunk.len() > 256 * 1024 {
                return Err(RpcError::InvalidResponse);
            }
            body.extend_from_slice(&chunk);
        }
        let result: Value = serde_json::from_slice(&body).map_err(|_| RpcError::InvalidResponse)?;
        if result["jsonrpc"] != "2.0" || result["id"] != 1 || !result.is_object() {
            return Err(RpcError::InvalidResponse);
        }
        if result.get("error").is_some() {
            if result.get("result").is_some()
                || !result["error"]["code"].is_i64()
                || !result["error"]["message"].is_string()
            {
                return Err(RpcError::InvalidResponse);
            }
            if result["error"]["code"] == -32005 {
                self.cooldown(Some(10_000)).await?;
                return Err(RpcError::CoolingDown);
            }
            return Err(RpcError::Rejected);
        }
        result
            .get("result")
            .cloned()
            .ok_or(RpcError::InvalidResponse)
    }
    /// Reserve before journaling, so routine quota pressure does not create an
    /// unknown dispatch. Once journaled, any send error still remains unknown.
    pub(crate) async fn reserve_local_broadcast(&self) -> Result<LocalBroadcastPermit, RpcError> {
        if self.endpoint.scheme() != "http"
            || self.endpoint.host_str() != Some("127.0.0.1")
            || self.chain_id().await? != "0x7a69"
        {
            return Err(RpcError::Configuration);
        }
        let permit = self
            .permits
            .clone()
            .try_acquire_owned()
            .map_err(|_| RpcError::Busy)?;
        if let Some(budget) = &self.budget {
            budget.admit(false).await?;
        }
        Ok(LocalBroadcastPermit {
            rpc: self.clone(),
            _permit: permit,
            granted: Instant::now(),
        })
    }
    pub async fn receipt(&self, hash: &str) -> Result<Value, RpcError> {
        self.request("eth_getTransactionReceipt", json!([hash]))
            .await
    }
    pub async fn transaction(&self, hash: &str) -> Result<Value, RpcError> {
        self.request("eth_getTransactionByHash", json!([hash]))
            .await
    }
    pub async fn chain_id(&self) -> Result<Value, RpcError> {
        self.request("eth_chainId", json!([])).await
    }
    pub async fn block(&self, tag: &str) -> Result<Value, RpcError> {
        self.request("eth_getBlockByNumber", json!([tag, false]))
            .await
    }
    pub async fn code(&self, address: &str, block: &str) -> Result<Value, RpcError> {
        self.request("eth_getCode", json!([address, block])).await
    }
    pub async fn storage(&self, address: &str, slot: &str, block: &str) -> Result<Value, RpcError> {
        self.request("eth_getStorageAt", json!([address, slot, block]))
            .await
    }
    pub async fn balance(&self, address: &str, block: &str) -> Result<Value, RpcError> {
        self.request("eth_getBalance", json!([address, block]))
            .await
    }
    pub async fn nonce(&self, address: &str, block: &str) -> Result<Value, RpcError> {
        self.request("eth_getTransactionCount", json!([address, block]))
            .await
    }
    pub async fn priority_fee(&self) -> Result<Value, RpcError> {
        self.request("eth_maxPriorityFeePerGas", json!([])).await
    }
    pub async fn call(&self, to: &str, data: &str, block: &str) -> Result<Value, RpcError> {
        self.request("eth_call", json!([{"to":to,"data":data},block]))
            .await
    }
    pub async fn simulate(&self, calls: Vec<Value>, block: &str) -> Result<Value, RpcError> {
        self.request("eth_simulateV1",json!([{"blockStateCalls":[{"calls":calls}],"validation":false,"returnFullTransactions":false},block])).await
    }
}
