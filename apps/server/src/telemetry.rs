use tracing_subscriber::{EnvFilter, fmt, prelude::*};

/// Initializes logging. Filter with `RUST_LOG`; set `LOG_FORMAT=json` for
/// structured output in production.
pub fn init() {
    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new("honey_server=debug,tower_http=debug,info"));

    let json = std::env::var("LOG_FORMAT").is_ok_and(|v| v.eq_ignore_ascii_case("json"));
    let registry = tracing_subscriber::registry().with(filter);

    if json {
        registry.with(fmt::layer().json()).init();
    } else {
        registry.with(fmt::layer()).init();
    }
}
