//! Run explicitly against disposable local/CI services; never a production URL.

use std::{sync::Arc, time::Duration};

use honey_server::{
    Config,
    config::SecretUrl,
    runtime::{DependencyStatus, Infrastructure, ReadinessStatus, RuntimeHealth},
};

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn server_side_statement_timeout_cancels_slow_queries() {
    let config = Config {
        database_url: Some(SecretUrl::new(
            std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
        )),
        database_statement_timeout_ms: 100,
        ..Config::default()
    };
    let infrastructure = Infrastructure::new(&config).unwrap();
    let error = sqlx::query("SELECT pg_sleep(1)")
        .execute(infrastructure.postgres().unwrap())
        .await
        .unwrap_err();
    assert_eq!(
        error.as_database_error().unwrap().code().as_deref(),
        Some("57014")
    );
    let healthy: bool = sqlx::query_scalar("SELECT true")
        .fetch_one(infrastructure.postgres().unwrap())
        .await
        .unwrap();
    assert!(healthy);
    infrastructure.close().await;
}

#[tokio::test]
#[ignore = "requires TEST_DATABASE_URL and TEST_REDIS_URL pointing at isolated services"]
async fn real_postgres_and_redis_probes_enable_readiness() {
    let config = Config {
        database_url: Some(SecretUrl::new(
            std::env::var("TEST_DATABASE_URL").expect("set TEST_DATABASE_URL"),
        )),
        redis_url: Some(SecretUrl::new(
            std::env::var("TEST_REDIS_URL").expect("set TEST_REDIS_URL"),
        )),
        require_infrastructure: true,
        ..Config::default()
    };
    let infrastructure = Arc::new(Infrastructure::new(&config).unwrap());
    let health = RuntimeHealth::new(&config);
    assert!(matches!(
        health.readiness().status,
        ReadinessStatus::NotReady
    ));
    let monitor = infrastructure.clone().start_monitor(health.clone());
    let result = tokio::time::timeout(Duration::from_secs(10), async {
        loop {
            if matches!(health.readiness().status, ReadinessStatus::Ready) {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    monitor.abort();
    let _ = monitor.await;
    result.expect("both real dependencies should become ready");
    let readiness = health.readiness();
    assert_eq!(readiness.dependencies.postgres, DependencyStatus::Up);
    assert_eq!(readiness.dependencies.redis, DependencyStatus::Up);
    let value: i32 = sqlx::query_scalar("SELECT 42")
        .fetch_one(infrastructure.postgres().unwrap())
        .await
        .unwrap();
    assert_eq!(value, 42);
    health.begin_drain();
    assert!(matches!(
        health.readiness().status,
        ReadinessStatus::NotReady
    ));
    infrastructure.close().await;
}

#[tokio::test]
async fn invalid_dependency_configuration_is_redacted() {
    let config = Config {
        redis_url: Some(SecretUrl::new(
            "invalid://private-user:private-secret@localhost".into(),
        )),
        ..Config::default()
    };
    let error = Infrastructure::new(&config)
        .err()
        .expect("invalid URL must fail");
    assert_eq!(error.to_string(), "invalid REDIS_URL");
    assert!(!format!("{error:?}").contains("private-secret"));
}
