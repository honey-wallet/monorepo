//! A dedicated test process mirrors the application's single global subscriber.
use std::sync::{Arc, Mutex};

use axum::{body::Body, http::Request};
use honey_server::{Config, build_router};
use tower::ServiceExt;

#[derive(Clone)]
struct Writer(Arc<Mutex<Vec<u8>>>);

impl std::io::Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        self.0.lock().unwrap().extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn request_logs_contain_route_templates_but_no_private_request_data() {
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let writer = Writer(bytes.clone());
    tracing_subscriber::fmt()
        .json()
        .with_writer(move || writer.clone())
        .init();
    let request = Request::get("/api/v1/pairing/private-address/commit?secret=private-query")
        .header("x-pair-token", "private-auth")
        .header("x-request-id", "private-correlation")
        .body(Body::empty())
        .unwrap();
    let response = build_router(&Config::default())
        .oneshot(request)
        .await
        .unwrap();
    let request_id = response.headers()["x-request-id"].to_str().unwrap();
    let logs = String::from_utf8(bytes.lock().unwrap().clone()).unwrap();
    assert!(logs.contains("/api/v1/pairing/{channel}/{slot}"));
    assert!(logs.contains(request_id));
    assert!(logs.contains("request completed"));
    assert!(!logs.contains("private-"));
}
