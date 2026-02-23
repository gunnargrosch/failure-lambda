use std::collections::HashMap;
use std::env;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;
use tracing::{info, warn, error};

/// The supported failure injection modes, in execution order.
pub const FAILURE_MODE_ORDER: &[&str] = &[
    "latency",
    "timeout",
    "diskspace",
    "denylist",
    "statuscode",
    "exception",
    "corruption",
];

/// Match operators for event-based targeting.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum MatchOperator {
    Eq,
    Exists,
    StartsWith,
    Regex,
}

impl Default for MatchOperator {
    fn default() -> Self {
        MatchOperator::Eq
    }
}

/// Condition for event-based targeting.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MatchCondition {
    pub path: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub operator: Option<MatchOperator>,
}

/// A single feature flag's value.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct FlagValue {
    #[serde(default)]
    pub enabled: bool,
    pub percentage: Option<u32>,
    pub min_latency: Option<f64>,
    pub max_latency: Option<f64>,
    pub exception_msg: Option<String>,
    pub status_code: Option<u16>,
    pub disk_space: Option<u32>,
    pub deny_list: Option<Vec<String>>,
    pub timeout_buffer_ms: Option<f64>,
    pub body: Option<String>,
    #[serde(rename = "match")]
    pub match_conditions: Option<Vec<MatchCondition>>,
}

/// The full config: a map of failure mode names to their flag values.
pub type FailureFlagsConfig = HashMap<String, FlagValue>;

/// A failure resolved and ready to inject.
#[derive(Debug, Clone)]
pub struct ResolvedFailure {
    pub mode: String,
    pub percentage: u32,
    pub flag: FlagValue,
}

const DEFAULT_CACHE_TTL_SECONDS: u64 = 60;

struct CachedConfig {
    config: FailureFlagsConfig,
    fetched_at: Instant,
}

pub struct ConfigManager {
    cache: Arc<Mutex<Option<CachedConfig>>>,
    ssm_client: Arc<Mutex<Option<aws_sdk_ssm::Client>>>,
}

impl Default for ConfigManager {
    fn default() -> Self {
        Self::new()
    }
}

impl ConfigManager {
    pub fn new() -> Self {
        Self {
            cache: Arc::new(Mutex::new(None)),
            ssm_client: Arc::new(Mutex::new(None)),
        }
    }

    fn is_appconfig_source() -> bool {
        env::var("FAILURE_APPCONFIG_CONFIGURATION")
            .ok()
            .filter(|v| !v.is_empty())
            .is_some()
    }

    fn get_cache_ttl() -> Duration {
        let env_value = env::var("FAILURE_CACHE_TTL").ok().filter(|v| !v.is_empty());

        match env_value {
            None => {
                if Self::is_appconfig_source() {
                    Duration::ZERO
                } else {
                    Duration::from_secs(DEFAULT_CACHE_TTL_SECONDS)
                }
            }
            Some(val) => {
                match val.parse::<f64>() {
                    Ok(seconds) if seconds >= 0.0 => {
                        if seconds > 0.0 && Self::is_appconfig_source() {
                            warn!(
                                source = "failure-lambda",
                                action = "config",
                                message = format!(
                                    "FAILURE_CACHE_TTL={seconds}s with AppConfig — the AppConfig extension already caches at its poll interval; library caching adds staleness"
                                ),
                            );
                        }
                        Duration::from_secs_f64(seconds)
                    }
                    _ => {
                        warn!(
                            source = "failure-lambda",
                            action = "config",
                            message = format!(
                                "invalid FAILURE_CACHE_TTL=\"{val}\", using default {DEFAULT_CACHE_TTL_SECONDS}s"
                            ),
                        );
                        Duration::from_secs(DEFAULT_CACHE_TTL_SECONDS)
                    }
                }
            }
        }
    }

    async fn get_ssm_client(&self) -> aws_sdk_ssm::Client {
        let mut guard = self.ssm_client.lock().await;
        if let Some(ref client) = *guard {
            return client.clone();
        }
        let sdk_config = aws_config::load_defaults(aws_config::BehaviorVersion::latest()).await;
        let client = aws_sdk_ssm::Client::new(&sdk_config);
        *guard = Some(client.clone());
        client
    }

    async fn fetch_from_ssm(&self) -> Result<FailureFlagsConfig, String> {
        let parameter_name = env::var("FAILURE_INJECTION_PARAM")
            .map_err(|_| "FAILURE_INJECTION_PARAM not set".to_string())?;

        let client = self.get_ssm_client().await;
        let response = client
            .get_parameter()
            .name(&parameter_name)
            .with_decryption(true)
            .send()
            .await
            .map_err(|e| format!("SSM GetParameter failed: {e}"))?;

        let raw_value = response
            .parameter()
            .and_then(|p| p.value())
            .ok_or_else(|| format!("SSM parameter \"{parameter_name}\" has no value"))?;

        let json: serde_json::Value = serde_json::from_str(raw_value)
            .map_err(|e| format!("SSM parameter is not valid JSON: {e}"))?;

        Ok(parse_flags(&json))
    }

    async fn fetch_from_appconfig(&self) -> Result<FailureFlagsConfig, String> {
        let port = env::var("AWS_APPCONFIG_EXTENSION_HTTP_PORT")
            .unwrap_or_else(|_| "2772".to_string());
        let application = env::var("FAILURE_APPCONFIG_APPLICATION")
            .map_err(|_| "FAILURE_APPCONFIG_APPLICATION not set".to_string())?;
        let environment = env::var("FAILURE_APPCONFIG_ENVIRONMENT")
            .map_err(|_| "FAILURE_APPCONFIG_ENVIRONMENT not set".to_string())?;
        let configuration = env::var("FAILURE_APPCONFIG_CONFIGURATION")
            .map_err(|_| "FAILURE_APPCONFIG_CONFIGURATION not set".to_string())?;

        let url = format!(
            "http://localhost:{port}/applications/{application}/environments/{environment}/configurations/{configuration}"
        );

        let response = reqwest::get(&url)
            .await
            .map_err(|e| format!("AppConfig fetch failed: {e}"))?;

        if !response.status().is_success() {
            return Err(format!(
                "AppConfig fetch failed: {} {}",
                response.status().as_u16(),
                response.status().canonical_reason().unwrap_or(""),
            ));
        }

        let json: serde_json::Value = response
            .json()
            .await
            .map_err(|e| format!("AppConfig response is not valid JSON: {e}"))?;

        Ok(parse_flags(&json))
    }

    /// Fetch config from AppConfig or SSM, with caching.
    pub async fn get_config(&self) -> FailureFlagsConfig {
        let cache_ttl = Self::get_cache_ttl();

        // Check cache
        {
            let cache_guard = self.cache.lock().await;
            if let Some(ref cached) = *cache_guard {
                if !cache_ttl.is_zero() && cached.fetched_at.elapsed() < cache_ttl {
                    return cached.config.clone();
                }
            }
        }

        let result = if Self::is_appconfig_source() {
            match self.fetch_from_appconfig().await {
                Ok(config) => Some(("appconfig", config)),
                Err(e) => {
                    error!(
                        source = "failure-lambda",
                        action = "config",
                        message = "error fetching config",
                        error = %e,
                    );
                    None
                }
            }
        } else if env::var("FAILURE_INJECTION_PARAM").ok().filter(|v| !v.is_empty()).is_some() {
            match self.fetch_from_ssm().await {
                Ok(config) => Some(("ssm", config)),
                Err(e) => {
                    error!(
                        source = "failure-lambda",
                        action = "config",
                        message = "error fetching config",
                        error = %e,
                    );
                    None
                }
            }
        } else {
            return FailureFlagsConfig::new();
        };

        match result {
            Some((config_source, config)) => {
                let enabled_flags: Vec<&String> = config
                    .iter()
                    .filter(|(_, v)| v.enabled)
                    .map(|(k, _)| k)
                    .collect();
                info!(
                    source = "failure-lambda",
                    action = "config",
                    config_source = config_source,
                    cache_ttl_seconds = cache_ttl.as_secs_f64(),
                    enabled_flags = ?enabled_flags,
                );

                let mut cache_guard = self.cache.lock().await;
                *cache_guard = Some(CachedConfig {
                    config: config.clone(),
                    fetched_at: Instant::now(),
                });
                config
            }
            None => {
                // Fall back to stale cache if available — better to use last known
                // config than to silently disable all failures on a transient error
                let cache_guard = self.cache.lock().await;
                if let Some(ref cached) = *cache_guard {
                    warn!(
                        source = "failure-lambda",
                        action = "config",
                        message = "fetch failed; using last known config",
                    );
                    return cached.config.clone();
                }
                FailureFlagsConfig::new()
            }
        }
    }
}

/// Parse raw JSON into FailureFlagsConfig. Validates each known flag key.
pub fn parse_flags(raw: &serde_json::Value) -> FailureFlagsConfig {
    let obj = match raw.as_object() {
        Some(o) => o,
        None => {
            warn!(
                source = "failure-lambda",
                action = "config",
                message = "config is not a JSON object",
            );
            return FailureFlagsConfig::new();
        }
    };

    // Detect old v0.x format
    if obj.contains_key("isEnabled") || obj.contains_key("failureMode") {
        warn!(
            source = "failure-lambda",
            action = "config",
            message = "detected 0.x configuration format — this version requires the v1.0 feature-flag format",
        );
    }

    let known_flags: std::collections::HashSet<&str> =
        FAILURE_MODE_ORDER.iter().copied().collect();

    let mut config = FailureFlagsConfig::new();

    for (key, value) in obj {
        if !known_flags.contains(key.as_str()) {
            continue;
        }

        let flag_obj = match value.as_object() {
            Some(o) => o,
            None => {
                warn!(
                    source = "failure-lambda",
                    action = "config",
                    mode = %key,
                    message = "must be an object, skipping",
                );
                continue;
            }
        };

        match serde_json::from_value::<FlagValue>(serde_json::Value::Object(flag_obj.clone())) {
            Ok(flag) => {
                let errors = validate_flag_value(key, &flag, flag_obj);
                if !errors.is_empty() {
                    for err in &errors {
                        warn!(
                            source = "failure-lambda",
                            action = "config",
                            field = %err.field,
                            message = %err.message,
                        );
                    }
                    warn!(
                        source = "failure-lambda",
                        action = "config",
                        mode = %key,
                        message = "skipping flag due to validation errors",
                    );
                    continue;
                }
                config.insert(key.clone(), flag);
            }
            Err(e) => {
                warn!(
                    source = "failure-lambda",
                    action = "config",
                    mode = %key,
                    message = format!("failed to parse flag: {e}"),
                );
                continue;
            }
        }
    }

    config
}

struct ValidationError {
    field: String,
    message: String,
}

fn validate_flag_value(
    mode: &str,
    flag: &FlagValue,
    raw: &serde_json::Map<String, serde_json::Value>,
) -> Vec<ValidationError> {
    let mut errors = Vec::new();

    // enabled must be present in the raw JSON as a boolean
    match raw.get("enabled") {
        Some(serde_json::Value::Bool(_)) => {}
        _ => {
            errors.push(ValidationError {
                field: format!("{mode}.enabled"),
                message: "must be a boolean".to_string(),
            });
        }
    }

    // percentage: 0-100 integer
    if let Some(pct) = flag.percentage {
        if pct > 100 {
            errors.push(ValidationError {
                field: format!("{mode}.percentage"),
                message: "must be an integer between 0 and 100".to_string(),
            });
        }
    }

    match mode {
        "latency" => {
            if let Some(min) = flag.min_latency {
                if min < 0.0 {
                    errors.push(ValidationError {
                        field: format!("{mode}.min_latency"),
                        message: "must be a non-negative number".to_string(),
                    });
                }
            }
            if let Some(max) = flag.max_latency {
                if max < 0.0 {
                    errors.push(ValidationError {
                        field: format!("{mode}.max_latency"),
                        message: "must be a non-negative number".to_string(),
                    });
                }
            }
            if let (Some(min), Some(max)) = (flag.min_latency, flag.max_latency) {
                if min > max {
                    errors.push(ValidationError {
                        field: format!("{mode}.max_latency"),
                        message: "max_latency must be >= min_latency".to_string(),
                    });
                }
            }
        }
        "exception" => {
            if let Some(ref raw_msg) = raw.get("exception_msg") {
                if !raw_msg.is_string() && !raw_msg.is_null() {
                    errors.push(ValidationError {
                        field: format!("{mode}.exception_msg"),
                        message: "must be a string".to_string(),
                    });
                }
            }
        }
        "statuscode" => {
            if let Some(code) = flag.status_code {
                if !(100..=599).contains(&code) {
                    errors.push(ValidationError {
                        field: format!("{mode}.status_code"),
                        message: "must be an HTTP status code (100-599)".to_string(),
                    });
                }
            }
        }
        "diskspace" => {
            if let Some(space) = flag.disk_space {
                if space == 0 || space > 10240 {
                    errors.push(ValidationError {
                        field: format!("{mode}.disk_space"),
                        message: "must be between 1 and 10240 (MB)".to_string(),
                    });
                }
            }
        }
        "denylist" => {
            if let Some(ref patterns) = flag.deny_list {
                for (i, pattern) in patterns.iter().enumerate() {
                    if regex::Regex::new(pattern).is_err() {
                        errors.push(ValidationError {
                            field: format!("{mode}.deny_list[{i}]"),
                            message: "invalid regular expression".to_string(),
                        });
                    }
                }
            }
        }
        "timeout" => {
            if let Some(buffer) = flag.timeout_buffer_ms {
                if buffer < 0.0 {
                    errors.push(ValidationError {
                        field: format!("{mode}.timeout_buffer_ms"),
                        message: "must be a non-negative number".to_string(),
                    });
                }
            }
        }
        "corruption" => {
            if let Some(ref raw_body) = raw.get("body") {
                if !raw_body.is_string() && !raw_body.is_null() {
                    errors.push(ValidationError {
                        field: format!("{mode}.body"),
                        message: "must be a string".to_string(),
                    });
                }
            }
        }
        _ => {}
    }

    // Validate match conditions
    if let Some(ref conditions) = flag.match_conditions {
        let valid_operators = ["eq", "exists", "startsWith", "regex"];
        for (i, cond) in conditions.iter().enumerate() {
            if cond.path.is_empty() {
                errors.push(ValidationError {
                    field: format!("{mode}.match[{i}].path"),
                    message: "must be a non-empty string".to_string(),
                });
            }
            let op = cond
                .operator
                .as_ref()
                .cloned()
                .unwrap_or(MatchOperator::Eq);
            let op_str = match &op {
                MatchOperator::Eq => "eq",
                MatchOperator::Exists => "exists",
                MatchOperator::StartsWith => "startsWith",
                MatchOperator::Regex => "regex",
            };
            if !valid_operators.contains(&op_str) {
                errors.push(ValidationError {
                    field: format!("{mode}.match[{i}].operator"),
                    message: "must be one of: eq, exists, startsWith, regex".to_string(),
                });
            }
            if op != MatchOperator::Exists && cond.value.is_none() {
                errors.push(ValidationError {
                    field: format!("{mode}.match[{i}].value"),
                    message: "must be a string (required for all operators except 'exists')"
                        .to_string(),
                });
            }
            if op == MatchOperator::Regex {
                if let Some(ref val) = cond.value {
                    if regex::Regex::new(val).is_err() {
                        errors.push(ValidationError {
                            field: format!("{mode}.match[{i}].value"),
                            message: "invalid regular expression".to_string(),
                        });
                    }
                }
            }
        }
    }

    errors
}

/// Resolve enabled flags into an ordered array of failures to inject.
pub fn resolve_failures(config: &FailureFlagsConfig) -> Vec<ResolvedFailure> {
    let mut failures = Vec::new();

    for &mode in FAILURE_MODE_ORDER {
        if let Some(flag) = config.get(mode) {
            if !flag.enabled {
                continue;
            }
            let percentage = flag.percentage.unwrap_or(100).min(100);
            failures.push(ResolvedFailure {
                mode: mode.to_string(),
                percentage,
                flag: flag.clone(),
            });
        }
    }

    failures
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parse_flags_valid_config() {
        let json: serde_json::Value = serde_json::json!({
            "latency": {
                "enabled": true,
                "percentage": 50,
                "min_latency": 100.0,
                "max_latency": 500.0
            },
            "exception": {
                "enabled": false,
                "exception_msg": "test error"
            }
        });

        let config = parse_flags(&json);
        assert_eq!(config.len(), 2);

        let latency = config.get("latency").unwrap();
        assert!(latency.enabled);
        assert_eq!(latency.percentage, Some(50));
        assert_eq!(latency.min_latency, Some(100.0));
        assert_eq!(latency.max_latency, Some(500.0));

        let exception = config.get("exception").unwrap();
        assert!(!exception.enabled);
        assert_eq!(exception.exception_msg.as_deref(), Some("test error"));
    }

    #[test]
    fn test_parse_flags_unknown_keys_ignored() {
        let json: serde_json::Value = serde_json::json!({
            "unknown_mode": { "enabled": true },
            "latency": { "enabled": true }
        });

        let config = parse_flags(&json);
        assert_eq!(config.len(), 1);
        assert!(config.contains_key("latency"));
    }

    #[test]
    fn test_parse_flags_invalid_flag_skipped() {
        let json: serde_json::Value = serde_json::json!({
            "latency": {
                "enabled": true,
                "min_latency": 500.0,
                "max_latency": 100.0
            }
        });

        let config = parse_flags(&json);
        assert!(config.is_empty());
    }

    #[test]
    fn test_parse_flags_non_object() {
        let json: serde_json::Value = serde_json::json!("not an object");
        let config = parse_flags(&json);
        assert!(config.is_empty());
    }

    #[test]
    fn test_parse_flags_non_object_flag() {
        let json: serde_json::Value = serde_json::json!({
            "latency": "not an object"
        });
        let config = parse_flags(&json);
        assert!(config.is_empty());
    }

    #[test]
    fn test_resolve_failures_order() {
        let json: serde_json::Value = serde_json::json!({
            "exception": { "enabled": true },
            "latency": { "enabled": true },
            "corruption": { "enabled": true }
        });
        let config = parse_flags(&json);
        let failures = resolve_failures(&config);

        assert_eq!(failures.len(), 3);
        assert_eq!(failures[0].mode, "latency");
        assert_eq!(failures[1].mode, "exception");
        assert_eq!(failures[2].mode, "corruption");
    }

    #[test]
    fn test_resolve_failures_defaults_percentage() {
        let json: serde_json::Value = serde_json::json!({
            "latency": { "enabled": true }
        });
        let config = parse_flags(&json);
        let failures = resolve_failures(&config);

        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].percentage, 100);
    }

    #[test]
    fn test_resolve_failures_clamps_percentage() {
        let mut config = FailureFlagsConfig::new();
        config.insert(
            "latency".to_string(),
            FlagValue {
                enabled: true,
                percentage: Some(200),
                ..Default::default()
            },
        );
        let failures = resolve_failures(&config);
        assert_eq!(failures[0].percentage, 100);
    }

    #[test]
    fn test_resolve_failures_skips_disabled() {
        let json: serde_json::Value = serde_json::json!({
            "latency": { "enabled": false },
            "exception": { "enabled": true }
        });
        let config = parse_flags(&json);
        let failures = resolve_failures(&config);

        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].mode, "exception");
    }

    #[test]
    fn test_validate_statuscode_range() {
        let json: serde_json::Value = serde_json::json!({
            "statuscode": { "enabled": true, "status_code": 999 }
        });
        let config = parse_flags(&json);
        assert!(config.is_empty());
    }

    #[test]
    fn test_validate_diskspace_range() {
        let json: serde_json::Value = serde_json::json!({
            "diskspace": { "enabled": true, "disk_space": 0 }
        });
        let config = parse_flags(&json);
        assert!(config.is_empty());
    }

    #[test]
    fn test_validate_match_conditions() {
        let json: serde_json::Value = serde_json::json!({
            "latency": {
                "enabled": true,
                "match": [
                    { "path": "requestContext.http.method", "value": "GET" },
                    { "path": "headers.host", "operator": "exists" }
                ]
            }
        });
        let config = parse_flags(&json);
        assert_eq!(config.len(), 1);

        let latency = config.get("latency").unwrap();
        let conditions = latency.match_conditions.as_ref().unwrap();
        assert_eq!(conditions.len(), 2);
        assert_eq!(conditions[0].path, "requestContext.http.method");
        assert_eq!(conditions[0].value.as_deref(), Some("GET"));
    }

    #[test]
    fn test_validate_invalid_regex_in_denylist() {
        let json: serde_json::Value = serde_json::json!({
            "denylist": {
                "enabled": true,
                "deny_list": ["[invalid"]
            }
        });
        let config = parse_flags(&json);
        assert!(config.is_empty());
    }

    #[test]
    fn test_all_failure_modes() {
        let json: serde_json::Value = serde_json::json!({
            "latency": { "enabled": true, "min_latency": 100.0, "max_latency": 200.0 },
            "timeout": { "enabled": true, "timeout_buffer_ms": 50.0 },
            "diskspace": { "enabled": true, "disk_space": 100 },
            "denylist": { "enabled": true, "deny_list": [".*\\.example\\.com"] },
            "statuscode": { "enabled": true, "status_code": 503 },
            "exception": { "enabled": true, "exception_msg": "chaos" },
            "corruption": { "enabled": true, "body": "corrupted" }
        });
        let config = parse_flags(&json);
        assert_eq!(config.len(), 7);

        let failures = resolve_failures(&config);
        assert_eq!(failures.len(), 7);
        assert_eq!(failures[0].mode, "latency");
        assert_eq!(failures[1].mode, "timeout");
        assert_eq!(failures[2].mode, "diskspace");
        assert_eq!(failures[3].mode, "denylist");
        assert_eq!(failures[4].mode, "statuscode");
        assert_eq!(failures[5].mode, "exception");
        assert_eq!(failures[6].mode, "corruption");
    }
}
