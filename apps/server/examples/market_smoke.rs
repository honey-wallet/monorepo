//! Explicit read-only upstream smoke against a private disposable Redis namespace.
use honey_server::{Config, config::SecretUrl, runtime::Infrastructure};
use std::{sync::Arc, time::Duration};
use uuid::Uuid;
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config {
        redis_url: Some(SecretUrl::new(std::env::var("TEST_REDIS_URL")?)),
        redis_namespace: format!("smoke:{}", Uuid::new_v4().simple()),
        prices_enabled: true,
        ..Config::default()
    };
    let infrastructure = Arc::new(Infrastructure::new(&config)?);
    let hub = infrastructure.markets().unwrap();
    let tasks = hub.clone().start();
    let result = tokio::time::timeout(Duration::from_secs(20), async {
        loop {
            if let Some(snapshot) = hub.snapshot().filter(|s| !s.stale) {
                break snapshot;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    })
    .await;
    for task in tasks {
        task.abort();
        let _ = task.await;
    }
    let redis = infrastructure.redis().unwrap();
    let _: i32 = redis
        .query(
            redis::cmd("DEL")
                .arg(redis.key("prices", "control"))
                .arg(redis.key("prices", "snapshot")),
        )
        .await?;
    let snapshot = result?;
    println!("{}", serde_json::to_string_pretty(&snapshot)?);
    Ok(())
}
