//! Two real API replicas, shared cache and public provider reads; no financial actions.
use honey_server::{
    Config, build_router_with_infrastructure,
    config::SecretUrl,
    earn_catalog::parse_registry,
    runtime::{Infrastructure, RuntimeHealth},
};
use serde_json::Value;
use std::{sync::Arc, time::Duration};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config {
        redis_url: Some(SecretUrl::new(std::env::var("TEST_REDIS_URL")?)),
        // Preserve provider cooldowns across runs, just like the direct-reader smoke.
        redis_namespace: "earn-smoke".into(),
        earn_read_targets: parse_registry(
            r#"[
          {"protocol":"aave_v3","chainId":"1","contractAddress":"0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2","assetAddress":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","label":"Reference Aave Ethereum USDC"},
          {"protocol":"morpho_vault_v2","chainId":"1","contractAddress":"0x04422053addbc9bb2759b248b574e3fca76bc145","assetAddress":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","label":"Reference Morpho V2 USDC"}
        ]"#,
        )?,
        ..Default::default()
    };
    let mut processes = Vec::new();
    let mut addresses = Vec::new();
    let mut tasks = Vec::new();
    for _ in 0..2 {
        let infrastructure = Arc::new(Infrastructure::new(&config)?);
        tasks.extend(infrastructure.earn().unwrap().clone().start());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        addresses.push(listener.local_addr()?);
        let router = build_router_with_infrastructure(
            &config,
            RuntimeHealth::new(&config),
            &infrastructure,
        )?;
        tasks.push(tokio::spawn(async move {
            axum::serve(listener, router).await.unwrap();
        }));
        processes.push(infrastructure);
    }
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(3))
        .build()?;
    let result = tokio::time::timeout(Duration::from_secs(40), async {
        loop {
            let mut snapshots = Vec::new();
            for address in &addresses {
                snapshots.push(
                    client
                        .get(format!("http://{address}/api/v1/earn/catalog"))
                        .send()
                        .await?
                        .json::<Value>()
                        .await?,
                );
            }
            if snapshots.iter().all(|v| v["status"] == "ready") {
                break Ok::<_, anyhow::Error>(snapshots.remove(0));
            }
            tokio::time::sleep(Duration::from_millis(250)).await;
        }
    })
    .await;
    let result=async {
        let catalog=result??;
        let before:Vec<_>=processes.iter().map(|p|provider_counts(&p.metrics().encode().unwrap())).collect();
        for _ in 0..100 { let response=client.get(format!("http://{}/api/v1/earn/catalog",addresses[0])).send().await?; anyhow::ensure!(response.status().is_success()); let _:Value=response.json().await?; }
        let after:Vec<_>=processes.iter().map(|p|provider_counts(&p.metrics().encode().unwrap())).collect();
        anyhow::ensure!(before==after,"API reads triggered upstream requests");
        anyhow::ensure!(catalog["products"].as_array().unwrap().iter().all(|p|p["observation"]["executionAvailable"]==false));
        println!("{}",serde_json::to_string_pretty(&serde_json::json!({"replicas":2,"cachedHttpReads":100,"providerCallsUnchanged":true,"catalog":catalog}))?);
        Ok::<_,anyhow::Error>(())
    }.await;
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    result
}
fn provider_counts(metrics: &str) -> Vec<String> {
    metrics
        .lines()
        .filter(|l| l.starts_with("honey_provider_requests_total{") && l.contains("earn_read"))
        .map(str::to_owned)
        .collect()
}
