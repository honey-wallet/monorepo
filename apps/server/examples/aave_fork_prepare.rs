//! Local-fork test bridge. Never accepts an RPC endpoint or a production chain.
use alloy_primitives::{Address, U256, keccak256};
use honey_server::{
    evm_envelope::{EvmEnvelopePolicy, verify_signed_bundle},
    preparation::EvmPreparation,
    providers::{aave_execution::*, evm_rpc::EvmReadRpc},
};
use honey_server::{
    submissions::{NonceObservation, StageSubmission, SubmissionKeys},
    work::{Action, NewOperation, OperationState, Topic, WorkStore},
};
use serde_json::{Value, json};
use sqlx::{
    ConnectOptions, PgPool, Row,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use std::io::Read;
use uuid::Uuid;
use zeroize::Zeroizing;
fn now_ms() -> i64 {
    (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64
}
fn fixture_keys() -> SubmissionKeys {
    SubmissionKeys::new(
        "public-local-fork-only".into(),
        [("public-local-fork-only".into(), Zeroizing::new([0x55; 32]))].into(),
    )
    .unwrap()
}
fn db_name(v: &Value) -> anyhow::Result<&str> {
    let name = v["database"]
        .as_str()
        .ok_or_else(|| anyhow::anyhow!("database missing"))?;
    let suffix = name
        .strip_prefix("honey_aave_smoke_")
        .ok_or_else(|| anyhow::anyhow!("requires owned test database prefix"))?;
    anyhow::ensure!(
        suffix.len() == 32 && suffix.bytes().all(|b| b.is_ascii_hexdigit()),
        "invalid test database"
    );
    Ok(name)
}
async fn local_pool(name: &str) -> anyhow::Result<PgPool> {
    let options = PgConnectOptions::new()
        .host("127.0.0.1")
        .port(25432)
        .username("honey")
        .password("honey_local_only")
        .database(name)
        .disable_statement_logging();
    Ok(PgPoolOptions::new()
        .max_connections(2)
        .connect_with(options)
        .await?)
}
async fn owner(pool: &PgPool) -> anyhow::Result<(Uuid, Uuid)> {
    Ok(sqlx::query_as("SELECT user_id,id FROM wallet_memberships")
        .fetch_one(pool)
        .await?)
}
async fn nonce(rpc: &EvmReadRpc) -> anyhow::Result<NonceObservation> {
    let signer = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
    let pending = rpc.nonce(signer, "pending").await?;
    anyhow::ensure!(
        pending == rpc.nonce(signer, "latest").await?,
        "fixture pending nonce mismatch"
    );
    let n = pending
        .as_str()
        .and_then(|n| n.strip_prefix("0x"))
        .ok_or_else(|| anyhow::anyhow!("invalid nonce"))?;
    Ok(NonceObservation {
        nonce: u64::from_str_radix(n, 16)?,
        observed_at_ms: now_ms(),
    })
}
async fn reconcile(store: &WorkStore, rpc: &EvmReadRpc, operation: Uuid) -> anyhow::Result<()> {
    let lease = store
        .claim(Topic::OperationChanged, 30)
        .await?
        .ok_or_else(|| anyhow::anyhow!("missing fixture job"))?;
    anyhow::ensure!(lease.operation_id == operation, "unexpected fixture job");
    let context = store
        .reconciliation_context(&fixture_keys(), operation)
        .await?;
    let proof = honey_server::reconciliation::collect(rpc, &context).await?;
    store.record_reconciliation(&lease, &proof).await?;
    Ok(())
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let mut input = String::new();
    std::io::stdin()
        .take(128 * 1024)
        .read_to_string(&mut input)?;
    let v: Value = serde_json::from_str(&input)?;
    if v["command"] == "init_database" {
        let admin = local_pool("honey").await?;
        let name = format!("honey_aave_smoke_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await?;
        let pool = local_pool(&name).await?;
        honey_server::database::migrate(&pool).await?;
        let user = Uuid::new_v4();
        let wallet = Uuid::new_v4();
        sqlx::query("INSERT INTO users(id) VALUES ($1)")
            .bind(user)
            .execute(&pool)
            .await?;
        sqlx::query("INSERT INTO wallet_memberships(id,user_id,chain_id,address,account_kind) VALUES ($1,$2,31337,$3,'eoa')")
            .bind(wallet).bind(user).bind(hex::decode("7e5f4552091a69125d5dfcb7b8c2659029395bdf")?).execute(&pool).await?;
        pool.close().await;
        admin.close().await;
        println!("{}", json!({"database":name}));
        return Ok(());
    }
    if v["command"] == "drop_database" {
        let name = db_name(&v)?;
        let admin = local_pool("honey").await?;
        sqlx::query(&format!("DROP DATABASE {name}"))
            .execute(&admin)
            .await?;
        admin.close().await;
        if v["cleanupRpcBudget"] == true {
            let redis = honey_server::redis_store::RedisStore::new(
                redis::Client::open("redis://127.0.0.1:26379")?,
                format!(
                    "honey-rpc:{}",
                    name.strip_prefix("honey_aave_smoke_").unwrap()
                ),
                std::time::Duration::from_secs(1),
            );
            let _: i32 = redis
                .query(
                    redis::cmd("DEL")
                        .arg(redis.key("rpc-budget-local-aave-fork", "policy"))
                        .arg(redis.key("rpc-budget-local-aave-fork", "next"))
                        .arg(redis.key("rpc-budget-local-aave-fork", "cooldown")),
                )
                .await?;
            // The Uniswap HTTP fork harness reuses this disposable database
            // helper and has its own quote/build account budget in the same
            // unique namespace. Never scan/delete shared or unrelated keys.
            if v["cleanupUniswapBudget"] == true {
                let _: i32 = redis
                    .query(
                        redis::cmd("DEL")
                            .arg(redis.key("rpc-budget-uniswap-local-aave-fork", "policy"))
                            .arg(redis.key("rpc-budget-uniswap-local-aave-fork", "next"))
                            .arg(redis.key("rpc-budget-uniswap-local-aave-fork", "cooldown")),
                    )
                    .await?;
            }
        }
        println!("{}", json!({"dropped":true}));
        return Ok(());
    }
    let rpc = EvmReadRpc::new("http://127.0.0.1:28545")?;
    anyhow::ensure!(
        rpc.chain_id().await? == "0x7a69",
        "requires local chain 31337"
    );
    if v["command"] == "dispatch" || v["command"] == "reconcile" {
        let pool = local_pool(db_name(&v)?).await?;
        let store = WorkStore::new(pool.clone());
        let operation: Uuid = v["operation"]
            .as_str()
            .ok_or_else(|| anyhow::anyhow!("operation missing"))?
            .parse()?;
        if v["command"] == "dispatch" {
            let step = u8::try_from(
                v["step"]
                    .as_u64()
                    .ok_or_else(|| anyhow::anyhow!("step missing"))?,
            )?;
            if step > 0 {
                reconcile(&store, &rpc, operation).await?;
            }
            let lease = store
                .claim(Topic::OperationChanged, 30)
                .await?
                .ok_or_else(|| anyhow::anyhow!("missing dispatch job"))?;
            anyhow::ensure!(lease.operation_id == operation, "unexpected fixture job");
            let attempt = store
                .begin_dispatch_step(&fixture_keys(), &lease, nonce(&rpc).await?, step)
                .await?;
            println!(
                "{}",
                json!({"attemptId":attempt.attempt_id(),"hash":attempt.transaction_hash()})
            );
        } else {
            reconcile(&store, &rpc, operation).await?;
            let (user, wallet) = owner(&pool).await?;
            let recovered = store.recover(user, wallet, operation).await?;
            anyhow::ensure!(
                recovered.operation.state == OperationState::Succeeded,
                "fixture has not reached simulated finality"
            );
            if let Some(lease) = store.claim(Topic::OperationChanged, 30).await? {
                store.complete(&lease).await?;
            }
            println!("{}", serde_json::to_string(&recovered)?);
        }
        pool.close().await;
        return Ok(());
    }
    if v["command"] == "verify" {
        let plan: EvmPreparation = serde_json::from_value(v["plan"].clone())?;
        anyhow::ensure!(plan.chain_id == "31337", "requires local chain 31337");
        let signed: Vec<String> = serde_json::from_value(v["signed"].clone())?;
        let verified = verify_signed_bundle(
            &plan,
            EvmEnvelopePolicy {
                first_nonce: v["firstNonce"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("nonce missing"))?
                    .parse()?,
                maximum_gas_per_transaction: 1_000_000,
            },
            &signed,
            (time::OffsetDateTime::now_utc().unix_timestamp_nanos() / 1_000_000) as i64,
        )?;
        if v.get("database").is_some() {
            let pool = local_pool(db_name(&v)?).await?;
            let store = WorkStore::new(pool.clone());
            let (user, wallet) = owner(&pool).await?;
            let operation: Uuid = v["operation"]
                .as_str()
                .ok_or_else(|| anyhow::anyhow!("operation missing"))?
                .parse()?;
            store
                .stage_signed(
                    &fixture_keys(),
                    StageSubmission {
                        user,
                        wallet,
                        operation,
                        expected_version: 1,
                        bundle: &verified,
                        nonce: nonce(&rpc).await?,
                    },
                )
                .await?;
            pool.close().await;
        }
        println!(
            "{}",
            json!({"preparationHash":verified.preparation_hash(),"hashes":verified.transactions().iter().map(|t|format!("{:#x}",t.hash())).collect::<Vec<_>>()})
        );
        return Ok(());
    }
    let pool: Address = "0x87870bca3f3fd6335c3f4ce8392d69350b4fa4e2".parse()?;
    let asset: Address = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48".parse()?;
    let a_token: Address = "0x98c23e9d8f34fefb1b7bd6a91b7ff122f4e16f5c".parse()?;
    let mut hashes = Vec::new();
    for address in [pool, asset, a_token] {
        let code = rpc.code(&format!("{address:#x}"), "latest").await?;
        let code = code
            .as_str()
            .and_then(|s| s.strip_prefix("0x"))
            .ok_or_else(|| anyhow::anyhow!("invalid code"))?;
        anyhow::ensure!(!code.is_empty(), "missing contract");
        hashes.push(keccak256(hex::decode(code)?));
    }
    let mut implementations = Vec::new();
    for (address, slot) in [
        (pool, AAVE_IMPLEMENTATION_SLOT),
        (asset, USDC_IMPLEMENTATION_SLOT),
        (a_token, AAVE_IMPLEMENTATION_SLOT),
    ] {
        let storage = rpc
            .storage(&format!("{address:#x}"), slot, "latest")
            .await?;
        let storage = hex::decode(
            storage
                .as_str()
                .and_then(|s| s.strip_prefix("0x"))
                .ok_or_else(|| anyhow::anyhow!("invalid slot"))?,
        )?;
        anyhow::ensure!(
            storage.len() == 32 && storage[..12].iter().all(|b| *b == 0),
            "invalid implementation word"
        );
        let address = Address::from_slice(&storage[12..]);
        let code = rpc.code(&format!("{address:#x}"), "latest").await?;
        let code = hex::decode(
            code.as_str()
                .and_then(|s| s.strip_prefix("0x"))
                .ok_or_else(|| anyhow::anyhow!("invalid implementation code"))?,
        )?;
        anyhow::ensure!(!code.is_empty(), "missing implementation");
        implementations.push(ImplementationPin {
            address,
            code_hash: keccak256(code),
        });
    }
    let a_token_implementation = implementations.pop().unwrap();
    let asset_implementation = implementations.pop().unwrap();
    let pool_implementation = implementations.pop().unwrap();
    // Dynamically observed hashes are exclusively a fork fixture, NOT a launch registry.
    let policy = AaveExecutionPolicy {
        chain_id: 31337,
        pool,
        asset,
        a_token,
        decimals: 6,
        pool_code_hash: hashes[0],
        asset_code_hash: hashes[1],
        a_token_code_hash: hashes[2],
        pool_implementation,
        asset_implementation,
        a_token_implementation,
        registry_revision: "local-fork-observed-test-only".into(),
        zero_fee_policy_revision: "local-fork-zero-fees-test-only".into(),
        maximum_gas_per_transaction: 1_000_000,
        maximum_atoken_rounding_raw: U256::from(2),
    };
    let mut prepared = prepare(
        &rpc,
        &policy,
        AavePrepareRequest {
            action: serde_json::from_value(v["action"].clone())?,
            signer: "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".parse()?,
            amount: U256::from_str_radix(
                v["amount"]
                    .as_str()
                    .ok_or_else(|| anyhow::anyhow!("amount missing"))?,
                10,
            )?,
            intent_hash: "a".repeat(64),
            maximum_network_fee: U256::from(10_000_000_000_000_000u64),
        },
    )
    .await?;
    if v.get("database").is_some() {
        let pool = local_pool(db_name(&v)?).await?;
        let store = WorkStore::new(pool.clone());
        let (user, wallet) = owner(&pool).await?;
        let intent = json!({"provider":"aave_v3","action":v["action"],"amountRaw":v["amount"],"chainId":"31337","asset":format!("{asset:#x}"),"recipient":prepared.plan.signer});
        let operation = store
            .create(NewOperation {
                user_id: user,
                wallet_id: wallet,
                action: Action::Earn,
                idempotency_key: &Uuid::new_v4().to_string(),
                intent: &intent,
            })
            .await?;
        prepared.plan.intent_hash =
            sqlx::query("SELECT encode(intent_hash,'hex') AS hash FROM operations WHERE id=$1")
                .bind(operation.id)
                .fetch_one(&pool)
                .await?
                .try_get("hash")?;
        let lease = store
            .claim(Topic::OperationCreated, 30)
            .await?
            .ok_or_else(|| anyhow::anyhow!("missing preparation job"))?;
        anyhow::ensure!(
            lease.operation_id == operation.id,
            "unexpected fixture preparation job"
        );
        store.persist_preparation(&lease, &prepared.plan).await?;
        let mut value = serde_json::to_value(&prepared)?;
        value["operation"] = json!(operation.id);
        println!("{}", value);
        pool.close().await;
    } else {
        println!("{}", serde_json::to_string(&prepared)?);
    }

    Ok(())
}
