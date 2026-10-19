use sqlx::{
    ConnectOptions, PgPool,
    postgres::{PgConnectOptions, PgPoolOptions},
};
use uuid::Uuid;

pub struct TestDatabase {
    pub pool: PgPool,
    admin: PgPool,
    name: String,
}

impl TestDatabase {
    /// Create a unique database in an explicitly supplied disposable test service.
    /// Never uses DATABASE_URL or applies migrations to the supplied database itself.
    pub async fn new() -> Self {
        let db = Self::empty().await;
        honey_server::database::migrate(&db.pool).await.unwrap();
        db
    }

    pub async fn empty() -> Self {
        let url = std::env::var("TEST_DATABASE_URL")
            .expect("set TEST_DATABASE_URL to an isolated service");
        let options = url
            .parse::<PgConnectOptions>()
            .unwrap()
            .disable_statement_logging();
        let admin = PgPoolOptions::new()
            .max_connections(2)
            .connect_with(options.clone())
            .await
            .unwrap();
        let name = format!("honey_test_{}", Uuid::new_v4().simple());
        sqlx::query(&format!("CREATE DATABASE {name}"))
            .execute(&admin)
            .await
            .unwrap();
        let pool = PgPoolOptions::new()
            .max_connections(12)
            .connect_with(options.database(&name))
            .await
            .unwrap();
        Self { pool, admin, name }
    }

    pub async fn close(self) {
        self.pool.close().await;
        // This randomly named database belongs exclusively to this fixture.
        // Driver connection shutdown can lag pool.close(); terminate only this
        // fixture's remaining sessions rather than racing PostgreSQL cleanup.
        sqlx::query(&format!("DROP DATABASE {} WITH (FORCE)", self.name))
            .execute(&self.admin)
            .await
            .unwrap();
        self.admin.close().await;
    }
}
