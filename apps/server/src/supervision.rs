//! Required background tasks must not silently disappear while the API stays ready.
use crate::{metrics::Metrics, runtime::RuntimeHealth};
use std::sync::Arc;
use tokio::task::JoinHandle;

/// Returns the consumed handle's index; caller removes it before awaiting the rest.
/// Task names/order are chosen by startup, not supplied by clients. No panic payload
/// is formatted (a dependency panic could contain private connection details).
pub async fn watch(
    health: RuntimeHealth,
    metrics: Arc<Metrics>,
    tasks: &mut [JoinHandle<()>],
) -> usize {
    assert!(!tasks.is_empty());
    let (result, index, _) = futures_util::future::select_all(tasks.iter_mut()).await;
    let outcome = match result {
        Ok(()) => "exited",
        Err(error) if error.is_panic() => "panic",
        Err(_) => "cancelled",
    };
    metrics.background_failure(outcome);
    health.begin_drain();
    metrics.draining.set(1);
    tracing::error!(
        task_index = index,
        error_code = outcome,
        "required background task stopped; draining process"
    );
    index
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn unexpected_exit_revokes_readiness_and_caller_can_cancel_remaining_tasks() {
        let health = RuntimeHealth::new(&crate::Config::default());
        let metrics = Arc::new(Metrics::default());
        let mut tasks = vec![
            tokio::spawn(std::future::pending::<()>()),
            tokio::spawn(async {}),
        ];
        let index = watch(health.clone(), metrics.clone(), &mut tasks).await;
        assert_eq!(index, 1);
        assert!(health.is_draining());
        assert_eq!(metrics.draining.get(), 1);
        drop(tasks.swap_remove(index));
        for task in tasks {
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        }
    }

    #[tokio::test]
    async fn panic_is_classified_without_exposing_panic_payload_and_revokes_readiness() {
        let health = RuntimeHealth::new(&crate::Config::default());
        let metrics = Arc::new(Metrics::default());
        let mut tasks = vec![tokio::spawn(async { panic!("private provider detail") })];

        let index = watch(health.clone(), metrics.clone(), &mut tasks).await;

        assert_eq!(index, 0);
        assert!(health.is_draining());
        assert_eq!(metrics.draining.get(), 1);
        let exposition = metrics.encode().unwrap();
        assert!(exposition.contains("honey_background_failures_total{outcome=\"panic\"} 1"));
        assert!(!exposition.contains("private provider detail"));
    }
}
