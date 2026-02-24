mod config;
mod failures;
mod proxy;

use std::env;
use tracing::{info, error};

#[tokio::main]
async fn main() {
    // Initialize structured JSON logging matching the TypeScript library format
    tracing_subscriber::fmt()
        .json()
        .with_target(false)
        .with_current_span(false)
        .init();

    info!(
        source = "failure-lambda",
        action = "startup",
        message = "failure-lambda proxy starting",
    );

    // Read the original Runtime API endpoint (set by the wrapper script)
    let original_runtime_api = match env::var("_ORIGINAL_RUNTIME_API") {
        Ok(api) => api,
        Err(_) => {
            error!(
                source = "failure-lambda",
                action = "startup",
                message = "_ORIGINAL_RUNTIME_API not set — is the wrapper script configured?",
            );
            std::process::exit(1);
        }
    };

    // Proxy listen port
    let proxy_port: u16 = env::var("FAILURE_PROXY_PORT")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(9009);

    info!(
        source = "failure-lambda",
        action = "startup",
        original_runtime_api = %original_runtime_api,
        proxy_port = proxy_port,
    );

    // Create config manager
    let config_manager = config::ConfigManager::new();

    // Pre-fetch config to warm the cache (DNS works normally — the proxy process
    // is not affected by LD_PRELOAD, which is only set for the runtime process)
    let _ = config_manager.get_config().await;

    // Start the HTTP proxy server (this blocks forever)
    if let Err(e) = proxy::start_proxy(
        proxy_port,
        original_runtime_api,
        config_manager,
    )
    .await
    {
        error!(
            source = "failure-lambda",
            action = "proxy",
            message = format!("proxy server failed: {e}"),
        );
        std::process::exit(1);
    }
}
