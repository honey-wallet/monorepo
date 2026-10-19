//! Explicit PUBLIC READS only. Example addresses are evidence fixtures, not approved products.
use honey_server::{
    Config,
    config::SecretUrl,
    providers::{
        earn::{EarnProtocol, EarnReader, EarnTarget},
        transport::ReadTransport,
    },
    runtime::Infrastructure,
};
#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let config = Config {
        redis_url: Some(SecretUrl::new(std::env::var("TEST_REDIS_URL")?)),
        // Stable across smoke runs so restarts respect provider spacing/cooldowns.
        redis_namespace: "earn-smoke".into(),
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config)?;
    let reader = EarnReader::new(ReadTransport::new(
        infrastructure.redis().unwrap().clone(),
        infrastructure.metrics().clone(),
    )?);
    let targets = [
        EarnTarget::new(
            EarnProtocol::AaveV3,
            1,
            "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        )?,
        EarnTarget::new(
            EarnProtocol::MorphoVaultV2,
            1,
            "0x04422053aDDbc9bB2759b248B574e3FCA76Bc145",
            "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
        )?,
    ];
    let mut observations = Vec::new();
    for target in targets {
        observations.push(reader.read(&target).await?);
    }
    println!("{}", serde_json::to_string_pretty(&observations)?);
    Ok(())
}
