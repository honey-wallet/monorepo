//! Waitlist HTTP contract against real PostgreSQL. Explicitly run with --ignored.
mod common;

use axum::{
    body::Body,
    extract::ConnectInfo,
    http::{Request, StatusCode},
};
use common::TestDatabase;
use honey_server::{config::AuthConfig, identity::Identity, routes};
use serde_json::{Value, json};
use tower::ServiceExt;

fn request(body: Value, ip: &str) -> Request<Body> {
    let mut request = Request::builder()
        .method("POST")
        .uri("/waitlist")
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap();
    request.extensions_mut().insert(ConnectInfo(
        format!("{ip}:1234")
            .parse::<std::net::SocketAddr>()
            .unwrap(),
    ));
    request
}

async fn body(response: axum::response::Response) -> Value {
    serde_json::from_slice(
        &axum::body::to_bytes(response.into_body(), 4096)
            .await
            .unwrap(),
    )
    .unwrap()
}

#[tokio::test]
#[ignore = "requires isolated TEST_DATABASE_URL"]
async fn waitlist_normalizes_is_idempotent_and_ip_limited() {
    let db = TestDatabase::new().await;
    let identity = Identity::new(
        db.pool.clone(),
        AuthConfig {
            origin: "http://localhost:5173".into(),
            additional_origins: vec![],
            chain_id: 1,
        },
    )
    .unwrap();
    let app = routes::waitlist::router(Some(identity), false, vec![]);

    let first = app
        .clone()
        .oneshot(request(
            json!({ "email": " Ada@Example.com " }),
            "127.0.0.1",
        ))
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    let first = body(first).await;
    assert_eq!(first, json!({ "status": "joined" }));

    // Already joined: identical response, no membership leak, still one row.
    let again = app
        .clone()
        .oneshot(request(
            json!({ "email": "ada@example.com", "source": "extension" }),
            "127.0.0.1",
        ))
        .await
        .unwrap();
    assert_eq!(again.status(), StatusCode::OK);
    assert_eq!(body(again).await, first);
    let rows: Vec<(String, String)> = sqlx::query_as("SELECT email, source FROM waitlist")
        .fetch_all(&db.pool)
        .await
        .unwrap();
    assert_eq!(rows, vec![("ada@example.com".into(), "web".into())]);

    let invalid = app
        .clone()
        .oneshot(request(json!({ "email": "not-an-email" }), "127.0.0.2"))
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);

    // Ten requests per IP per minute; the eleventh is refused.
    for n in 0..9 {
        let ok = app
            .clone()
            .oneshot(request(
                json!({ "email": format!("u{n}@example.com") }),
                "127.0.0.3",
            ))
            .await
            .unwrap();
        assert_eq!(ok.status(), StatusCode::OK);
    }
    let last = app
        .clone()
        .oneshot(request(json!({ "email": "u9@example.com" }), "127.0.0.3"))
        .await
        .unwrap();
    assert_eq!(last.status(), StatusCode::OK);
    let limited = app
        .oneshot(request(json!({ "email": "u10@example.com" }), "127.0.0.3"))
        .await
        .unwrap();
    assert_eq!(limited.status(), StatusCode::TOO_MANY_REQUESTS);
    db.close().await;
}

#[tokio::test]
async fn waitlist_without_storage_is_unsupported() {
    let app = routes::waitlist::router(None, false, vec![]);
    let response = app
        .oneshot(request(json!({ "email": "ada@example.com" }), "127.0.0.1"))
        .await
        .unwrap();
    assert_eq!(response.status(), StatusCode::UNPROCESSABLE_ENTITY);
}
