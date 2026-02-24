use std::collections::HashMap;
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;

use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode, Method};
use rand::Rng;
use tokio::net::TcpListener;
use tokio::sync::Mutex;
use tracing::{info, warn, error, debug};

use crate::config::{ConfigManager, ResolvedFailure, resolve_failures};
use crate::failures;

/// Path where the proxy writes denylist patterns for the LD_PRELOAD .so to read.
const DENYLIST_FILE: &str = "/tmp/.failure-lambda-denylist";
const DENYLIST_TMP: &str = "/tmp/.failure-lambda-denylist.tmp";

/// Per-invocation state carried from GET /next to POST /response|/error.
struct InvocationState {
    failures: Vec<ResolvedFailure>,
    event: serde_json::Value,
    /// Whether denylist patterns were written for this invocation.
    /// Used to determine if the denylist file needs removing on cleanup.
    denylist_active: bool,
}

/// Shared proxy state.
struct ProxyState {
    original_runtime_api: String,
    config_manager: ConfigManager,
    http_client: reqwest::Client,
    invocations: Mutex<HashMap<String, InvocationState>>,
}

/// Start the HTTP proxy server.
pub async fn start_proxy(
    listen_port: u16,
    original_runtime_api: String,
    config_manager: ConfigManager,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let state = Arc::new(ProxyState {
        original_runtime_api,
        config_manager,
        http_client: reqwest::Client::new(),
        invocations: Mutex::new(HashMap::new()),
    });

    let addr: SocketAddr = format!("127.0.0.1:{listen_port}").parse()?;
    let listener = TcpListener::bind(addr).await?;

    info!(
        source = "failure-lambda",
        action = "proxy",
        message = format!("proxy listening on {addr}"),
    );

    // Signal readiness
    tokio::fs::write("/tmp/.failure-lambda-ready", "").await?;

    loop {
        let (stream, _) = listener.accept().await?;
        let state = state.clone();

        tokio::task::spawn(async move {
            let service = service_fn(move |req| {
                let state = state.clone();
                async move { handle_request(req, state).await }
            });

            if let Err(e) = http1::Builder::new()
                .serve_connection(hyper_util::rt::TokioIo::new(stream), service)
                .await
            {
                debug!(
                    source = "failure-lambda",
                    action = "proxy",
                    message = format!("connection error: {e}"),
                );
            }
        });
    }
}

async fn handle_request(
    req: Request<Incoming>,
    state: Arc<ProxyState>,
) -> Result<Response<Full<Bytes>>, Infallible> {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    debug!(
        source = "failure-lambda",
        action = "proxy",
        method = %method,
        path = %path,
    );

    let result = if method == Method::GET && path.ends_with("/runtime/invocation/next") {
        handle_invocation_next(req, &state).await
    } else if method == Method::POST && path.contains("/runtime/invocation/") {
        if path.ends_with("/response") {
            let request_id = extract_request_id_from_path(&path);
            handle_invocation_response(req, &state, request_id).await
        } else if path.ends_with("/error") {
            let request_id = extract_request_id_from_path(&path);
            handle_invocation_error(req, &state, request_id).await
        } else {
            passthrough(req, &state).await
        }
    } else {
        passthrough(req, &state).await
    };

    match result {
        Ok(resp) => Ok(resp),
        Err(e) => {
            error!(
                source = "failure-lambda",
                action = "proxy",
                message = format!("handler error: {e}"),
            );
            Ok(Response::builder()
                .status(StatusCode::BAD_GATEWAY)
                .body(Full::new(Bytes::from(format!("proxy error: {e}"))))
                .unwrap())
        }
    }
}

/// Collect request headers suitable for forwarding to the upstream Runtime API.
/// Filters out `host` (points to proxy, not upstream) and `content-length`
/// (recalculated by reqwest, and may change if corruption modifies the body).
fn collect_forward_headers(req: &Request<Incoming>) -> Vec<(String, String)> {
    req.headers()
        .iter()
        .filter(|(name, _)| {
            let n = name.as_str();
            n != "host" && n != "content-length"
        })
        .filter_map(|(name, value)| {
            value
                .to_str()
                .ok()
                .map(|v| (name.to_string(), v.to_string()))
        })
        .collect()
}

/// Apply collected headers to a reqwest request builder.
fn apply_headers(
    mut builder: reqwest::RequestBuilder,
    headers: &[(String, String)],
) -> reqwest::RequestBuilder {
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    builder
}

/// Handle GET /runtime/invocation/next
///
/// This is the core of the proxy. It:
/// 1. Cleans up previous invocation's side effects
/// 2. Forwards to real Runtime API to get next event
/// 3. Fetches config and resolves failures
/// 4. Executes pre-handler failures (latency, diskspace, denylist, timeout)
/// 5. For terminating failures (exception, statuscode), consumes the invocation
///    and loops back to get the next one
/// 6. Stores post-handler state (corruption) for the response phase
/// 7. Returns the event to the runtime
async fn handle_invocation_next(
    _req: Request<Incoming>,
    state: &Arc<ProxyState>,
) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
    // Outer loop: handles short-circuit (exception/statuscode) by consuming
    // invocations and fetching the next one.
    loop {
        // Safety net: clean up any leftover state from a previous invocation
        // whose runtime crashed without posting /response or /error. In normal
        // operation, cleanup already happened in the response/error handler and
        // these are no-ops.
        tokio::task::spawn_blocking(failures::clear_diskspace)
            .await
            .ok();

        {
            let mut invocations = state.invocations.lock().await;
            let had_denylist = invocations.values().any(|s| s.denylist_active);
            invocations.clear();
            if had_denylist {
                remove_denylist();
            }
        }

        // Forward to real Runtime API
        let upstream_url = format!(
            "http://{}/2018-06-01/runtime/invocation/next",
            state.original_runtime_api
        );

        let upstream_response = state.http_client.get(&upstream_url).send().await?;

        // Extract headers
        let request_id = upstream_response
            .headers()
            .get("lambda-runtime-aws-request-id")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();

        let deadline_ms: u64 = upstream_response
            .headers()
            .get("lambda-runtime-deadline-ms")
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.parse().ok())
            .unwrap_or(0);

        // Collect all response headers to forward to the runtime
        let mut response_headers: Vec<(String, String)> = Vec::new();
        for (name, value) in upstream_response.headers() {
            if let Ok(v) = value.to_str() {
                response_headers.push((name.to_string(), v.to_string()));
            }
        }

        // Read event body
        let event_body = upstream_response.bytes().await?;
        let event: serde_json::Value =
            serde_json::from_slice(&event_body).unwrap_or(serde_json::Value::Null);

        // Check if disabled — before config fetch to avoid unnecessary SSM/AppConfig calls
        if std::env::var("FAILURE_LAMBDA_DISABLED")
            .ok()
            .filter(|v| v == "true")
            .is_some()
        {
            return build_proxy_response(&event_body, &response_headers);
        }

        // Fetch config and resolve failures
        let config = state.config_manager.get_config().await;
        let resolved_failures = resolve_failures(&config);

        if resolved_failures.is_empty() {
            return build_proxy_response(&event_body, &response_headers);
        }

        // Execute pre-handler failures
        let mut should_short_circuit = false;
        let mut post_handler_failures = Vec::new();
        let mut denylist_active = false;

        for failure in &resolved_failures {
            // Skip corruption — it's post-handler
            if failure.mode == "corruption" {
                post_handler_failures.push(failure.clone());
                continue;
            }

            // Check match conditions
            if let Some(ref conditions) = failure.flag.match_conditions {
                if !failures::matches_conditions(&event, conditions) {
                    continue;
                }
            }

            // Roll percentage dice
            let roll: f64 = rand::thread_rng().gen::<f64>() * 100.0;
            if roll >= failure.percentage as f64 {
                continue;
            }

            match failure.mode.as_str() {
                "latency" => {
                    failures::inject_latency(&failure.flag).await;
                }
                "timeout" => {
                    failures::inject_timeout(deadline_ms, &failure.flag).await;
                }
                "diskspace" => {
                    let flag = failure.flag.clone();
                    tokio::task::spawn_blocking(move || {
                        failures::inject_diskspace(&flag);
                    })
                    .await
                    .ok();
                }
                "denylist" => {
                    if let Some(ref patterns) = failure.flag.deny_list {
                        match write_denylist(patterns) {
                            Ok(()) => {
                                info!(
                                    source = "failure-lambda",
                                    mode = "denylist",
                                    action = "inject",
                                    pattern_count = patterns.len(),
                                );
                                denylist_active = true;
                            }
                            Err(e) => {
                                error!(
                                    source = "failure-lambda",
                                    mode = "denylist",
                                    action = "error",
                                    message = format!("failed to write denylist file: {e}"),
                                );
                            }
                        }
                    }
                }
                "statuscode" => {
                    // Terminating: post response to real API and loop for next invocation
                    let payload = failures::build_statuscode_payload(&failure.flag);
                    let body_str = serde_json::to_string(&payload).unwrap_or_default();
                    post_to_runtime_api(
                        &state.http_client,
                        &state.original_runtime_api,
                        &request_id,
                        "response",
                        &body_str,
                    )
                    .await?;
                    should_short_circuit = true;
                    break;
                }
                "exception" => {
                    // Terminating: post error to real API and loop for next invocation
                    let payload = failures::build_exception_payload(&failure.flag);
                    let body_str = serde_json::to_string(&payload).unwrap_or_default();
                    post_to_runtime_api(
                        &state.http_client,
                        &state.original_runtime_api,
                        &request_id,
                        "error",
                        &body_str,
                    )
                    .await?;
                    should_short_circuit = true;
                    break;
                }
                _ => {}
            }
        }

        if should_short_circuit {
            // Clean up denylist immediately if it was activated during this
            // short-circuited invocation (no /response handler will run).
            if denylist_active {
                remove_denylist();
            }
            continue;
        }

        // Store per-invocation state for the response/error phase
        if !post_handler_failures.is_empty() || denylist_active {
            let mut invocations = state.invocations.lock().await;
            invocations.insert(
                request_id.clone(),
                InvocationState {
                    failures: post_handler_failures,
                    event: event.clone(),
                    denylist_active,
                },
            );
        }

        // Return event to runtime
        return build_proxy_response(&event_body, &response_headers);
    }
}

/// Handle POST /runtime/invocation/{id}/response
async fn handle_invocation_response(
    req: Request<Incoming>,
    state: &Arc<ProxyState>,
    request_id: String,
) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
    // Collect request headers before consuming the body
    let forward_headers = collect_forward_headers(&req);

    // Read response body from runtime as raw bytes
    let body_bytes = req.collect().await?.to_bytes();

    // Remove per-invocation state (corruption + cleanup info)
    let invocation_state = {
        let mut invocations = state.invocations.lock().await;
        invocations.remove(&request_id)
    };

    // Apply corruption if active, otherwise forward raw bytes untouched.
    // Note: corruption match conditions are evaluated against the incoming Lambda
    // event (from /next), not the function's response. This is by design — you
    // target failures based on what triggered the invocation, consistent with how
    // all other failure modes work.
    let (final_body, denylist_was_active) = match invocation_state {
        Some(inv_state) => {
            let mut body = body_bytes;
            for failure in &inv_state.failures {
                if failure.mode != "corruption" {
                    continue;
                }
                if let Some(ref conditions) = failure.flag.match_conditions {
                    if !failures::matches_conditions(&inv_state.event, conditions) {
                        continue;
                    }
                }
                let roll: f64 = rand::thread_rng().gen::<f64>() * 100.0;
                if roll >= failure.percentage as f64 {
                    continue;
                }
                // Corruption requires the body as a UTF-8 string
                match std::str::from_utf8(&body) {
                    Ok(body_str) => {
                        body =
                            Bytes::from(failures::corrupt_response(&failure.flag, body_str));
                    }
                    Err(_) => {
                        warn!(
                            source = "failure-lambda",
                            mode = "corruption",
                            message = "response body is not valid UTF-8; skipping corruption",
                        );
                    }
                }
            }
            (body, inv_state.denylist_active)
        }
        None => (body_bytes, false),
    };

    // Cleanup based on per-invocation state
    cleanup_denylist(denylist_was_active);

    // Forward to real API with the runtime's original request headers
    let upstream_url = format!(
        "http://{}/2018-06-01/runtime/invocation/{}/response",
        state.original_runtime_api, request_id
    );

    let builder = state.http_client.post(&upstream_url);
    let upstream_response = apply_headers(builder, &forward_headers)
        .body(final_body.to_vec())
        .send()
        .await?;

    let status = upstream_response.status();
    let response_body = upstream_response.bytes().await?;

    Ok(Response::builder()
        .status(status.as_u16())
        .body(Full::new(response_body))
        .unwrap())
}

/// Handle POST /runtime/invocation/{id}/error
async fn handle_invocation_error(
    req: Request<Incoming>,
    state: &Arc<ProxyState>,
    request_id: String,
) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
    // Collect request headers (e.g. Lambda-Runtime-Function-Error-Type) before consuming body
    let forward_headers = collect_forward_headers(&req);

    // Forward body as-is to real API
    let body_bytes = req.collect().await?.to_bytes();

    // Remove invocation state and extract cleanup info
    let denylist_was_active = {
        let mut invocations = state.invocations.lock().await;
        invocations
            .remove(&request_id)
            .map_or(false, |s| s.denylist_active)
    };

    // Cleanup based on per-invocation state
    cleanup_denylist(denylist_was_active);

    let upstream_url = format!(
        "http://{}/2018-06-01/runtime/invocation/{}/error",
        state.original_runtime_api, request_id
    );

    let builder = state.http_client.post(&upstream_url);
    let upstream_response = apply_headers(builder, &forward_headers)
        .body(body_bytes.to_vec())
        .send()
        .await?;

    let status = upstream_response.status();
    let response_body = upstream_response.bytes().await?;

    Ok(Response::builder()
        .status(status.as_u16())
        .body(Full::new(response_body))
        .unwrap())
}

/// Transparent passthrough for unrecognized routes (e.g. /runtime/init/error).
async fn passthrough(
    req: Request<Incoming>,
    state: &Arc<ProxyState>,
) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
    let method = req.method().clone();
    let path = req
        .uri()
        .path_and_query()
        .map(|pq| pq.to_string())
        .unwrap_or_default();
    let forward_headers = collect_forward_headers(&req);
    let body_bytes = req.collect().await?.to_bytes();

    let upstream_url = format!("http://{}{}", state.original_runtime_api, path);

    let builder = state.http_client.request(method, &upstream_url);
    let upstream_response = apply_headers(builder, &forward_headers)
        .body(body_bytes.to_vec())
        .send()
        .await?;

    let status = upstream_response.status();
    let response_body = upstream_response.bytes().await?;

    Ok(Response::builder()
        .status(status.as_u16())
        .body(Full::new(response_body))
        .unwrap())
}

/// Write deny patterns to the denylist file atomically (write to tmp, then rename).
/// The LD_PRELOAD .so reads this file on each getaddrinfo() call.
fn write_denylist(patterns: &[String]) -> std::io::Result<()> {
    use std::io::Write;
    let mut f = std::fs::File::create(DENYLIST_TMP)?;
    for pattern in patterns {
        writeln!(f, "{}", pattern)?;
    }
    f.sync_all()?;
    std::fs::rename(DENYLIST_TMP, DENYLIST_FILE)?;
    Ok(())
}

/// Remove the denylist file. No-op if it doesn't exist.
fn remove_denylist() {
    let _ = std::fs::remove_file(DENYLIST_FILE);
    let _ = std::fs::remove_file(DENYLIST_TMP);
}

/// Remove denylist file if it was activated during this invocation.
fn cleanup_denylist(denylist_was_active: bool) {
    if denylist_was_active {
        remove_denylist();
    }
}

/// Post to the real Runtime API (for exception/statuscode short-circuits).
async fn post_to_runtime_api(
    client: &reqwest::Client,
    original_runtime_api: &str,
    request_id: &str,
    endpoint: &str,
    body: &str,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let url = format!(
        "http://{}/2018-06-01/runtime/invocation/{}/{}",
        original_runtime_api, request_id, endpoint
    );

    let response = client
        .post(&url)
        .header("Content-Type", "application/json")
        .body(body.to_string())
        .send()
        .await?;

    if !response.status().is_success() {
        warn!(
            source = "failure-lambda",
            action = "proxy",
            message = format!(
                "POST /{endpoint} for {request_id} returned {}",
                response.status()
            ),
        );
    }

    Ok(())
}

/// Extract the request ID from a path like /runtime/invocation/{id}/response.
fn extract_request_id_from_path(path: &str) -> String {
    let parts: Vec<&str> = path.split('/').collect();
    // Path: /2018-06-01/runtime/invocation/{id}/response
    // Parts: ["", "2018-06-01", "runtime", "invocation", "{id}", "response"]
    if parts.len() >= 5 {
        parts[parts.len() - 2].to_string()
    } else {
        String::new()
    }
}

/// Build a proxy response from upstream bytes and headers.
fn build_proxy_response(
    body: &[u8],
    headers: &[(String, String)],
) -> Result<Response<Full<Bytes>>, Box<dyn std::error::Error + Send + Sync>> {
    let mut builder = Response::builder().status(200);
    for (name, value) in headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    Ok(builder.body(Full::new(Bytes::copy_from_slice(body)))?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_extract_request_id_from_path() {
        let path = "/2018-06-01/runtime/invocation/abc-123-def/response";
        assert_eq!(extract_request_id_from_path(path), "abc-123-def");

        let path = "/2018-06-01/runtime/invocation/xyz-456/error";
        assert_eq!(extract_request_id_from_path(path), "xyz-456");
    }

    #[test]
    fn test_extract_request_id_from_short_path() {
        let path = "/short";
        assert_eq!(extract_request_id_from_path(path), "");
    }

    #[test]
    fn test_build_proxy_response() {
        let body = b"hello world";
        let headers = vec![
            ("content-type".to_string(), "application/json".to_string()),
            ("x-custom".to_string(), "value".to_string()),
        ];
        let response = build_proxy_response(body, &headers).unwrap();
        assert_eq!(response.status(), 200);
    }
}
