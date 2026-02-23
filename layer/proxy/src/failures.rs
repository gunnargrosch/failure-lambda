use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::time::SystemTime;

use rand::Rng;
use regex::Regex;
use tracing::{info, warn, error};

use crate::config::{FlagValue, MatchCondition, MatchOperator};

/// Inject latency by sleeping for a random duration in [min_latency, max_latency].
pub async fn inject_latency(flag: &FlagValue) {
    let min_latency = flag.min_latency.unwrap_or(0.0).max(0.0);
    let max_latency = flag.max_latency.unwrap_or(0.0).max(0.0);
    let range = (max_latency - min_latency).max(0.0);
    let injected_latency = min_latency + rand::thread_rng().gen::<f64>() * range;
    let ms = injected_latency.floor() as u64;

    info!(
        source = "failure-lambda",
        mode = "latency",
        action = "inject",
        latency_ms = ms,
        min_latency = min_latency,
        max_latency = max_latency,
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(ms)).await;
}

/// Inject timeout by sleeping until `deadline_ms` minus `timeout_buffer_ms`, then
/// returning normally. After this returns, the proxy forwards the event to the
/// runtime, which begins processing — but Lambda's deadline has nearly elapsed,
/// so Lambda kills the runtime shortly after it starts. The buffer ensures the
/// runtime has just enough time to begin execution before the deadline hits.
pub async fn inject_timeout(deadline_ms: u64, flag: &FlagValue) {
    let buffer_ms = flag.timeout_buffer_ms.unwrap_or(0.0).max(0.0) as u64;
    let now_ms = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;

    let sleep_ms = if deadline_ms > now_ms + buffer_ms {
        deadline_ms - now_ms - buffer_ms
    } else {
        0
    };

    info!(
        source = "failure-lambda",
        mode = "timeout",
        action = "inject",
        sleep_ms = sleep_ms,
        buffer_ms = buffer_ms,
        deadline_ms = deadline_ms,
    );

    tokio::time::sleep(tokio::time::Duration::from_millis(sleep_ms)).await;
}

const DISKSPACE_PREFIX: &str = "diskspace-failure-";
const CHUNK_SIZE: usize = 1024 * 1024; // 1MB

/// Fill /tmp with data. Writes in 1MB chunks to avoid large memory allocation.
pub fn inject_diskspace(flag: &FlagValue) {
    let disk_space_mb = flag.disk_space.unwrap_or(100);
    let timestamp = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let random_suffix: u32 = rand::thread_rng().gen();
    let filename = format!("/tmp/{DISKSPACE_PREFIX}{timestamp}-{random_suffix:08x}.tmp");

    info!(
        source = "failure-lambda",
        mode = "diskspace",
        action = "inject",
        disk_space_mb = disk_space_mb,
    );

    match fs::File::create(&filename) {
        Ok(mut file) => {
            let chunk = vec![0u8; CHUNK_SIZE];
            for _ in 0..disk_space_mb {
                if let Err(e) = file.write_all(&chunk) {
                    error!(
                        source = "failure-lambda",
                        mode = "diskspace",
                        action = "error",
                        message = %e,
                    );
                    break;
                }
            }
        }
        Err(e) => {
            error!(
                source = "failure-lambda",
                mode = "diskspace",
                action = "error",
                message = format!("failed to create {filename}: {e}"),
            );
        }
    }
}

/// Remove diskspace failure files from /tmp.
pub fn clear_diskspace() {
    let tmp = Path::new("/tmp");
    match fs::read_dir(tmp) {
        Ok(entries) => {
            let mut removed = 0;
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name_str = name.to_string_lossy();
                if name_str.starts_with(DISKSPACE_PREFIX) {
                    if let Err(e) = fs::remove_file(entry.path()) {
                        warn!(
                            source = "failure-lambda",
                            mode = "diskspace",
                            action = "clear_error",
                            message = %e,
                        );
                    } else {
                        removed += 1;
                    }
                }
            }
            if removed > 0 {
                info!(
                    source = "failure-lambda",
                    mode = "diskspace",
                    action = "clear",
                    files_removed = removed,
                );
            }
        }
        Err(e) => {
            warn!(
                source = "failure-lambda",
                mode = "diskspace",
                action = "clear_error",
                message = %e,
            );
        }
    }
}

/// Build the exception error payload. The caller posts this to the real API's
/// `/invocation/{id}/error` endpoint.
pub fn build_exception_payload(flag: &FlagValue) -> serde_json::Value {
    let message = flag
        .exception_msg
        .as_deref()
        .unwrap_or("Injected exception");

    info!(
        source = "failure-lambda",
        mode = "exception",
        action = "inject",
        exception_msg = message,
    );

    serde_json::json!({
        "errorMessage": message,
        "errorType": "FailureLambdaException",
    })
}

/// Build the statuscode response payload. The caller posts this to the real API's
/// `/invocation/{id}/response` endpoint.
pub fn build_statuscode_payload(flag: &FlagValue) -> serde_json::Value {
    let status_code = flag.status_code.unwrap_or(500);

    info!(
        source = "failure-lambda",
        mode = "statuscode",
        action = "inject",
        status_code = status_code,
    );

    serde_json::json!({
        "statusCode": status_code,
        "headers": { "Content-Type": "application/json" },
        "body": format!("{{\"message\":\"Injected status code {status_code}\"}}")
    })
}

/// Corrupt a response body. If `flag.body` is set, replaces the body entirely.
/// Otherwise, mangles it by truncating and appending replacement characters.
pub fn corrupt_response(flag: &FlagValue, body: &str) -> String {
    if let Some(ref replacement) = flag.body {
        info!(
            source = "failure-lambda",
            mode = "corruption",
            action = "inject",
            method = "replace",
        );
        // Try to parse as JSON and replace the body field
        if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(body) {
            if let Some(obj) = json.as_object_mut() {
                if obj.contains_key("body") {
                    obj.insert("body".to_string(), serde_json::Value::String(replacement.clone()));
                    return serde_json::to_string(&json).unwrap_or_else(|_| body.to_string());
                }
            }
            // Response has no body field; wrap in { body }
            warn!(
                source = "failure-lambda",
                mode = "corruption",
                message = "response has no body field; wrapping in {{ body }}",
            );
            return serde_json::json!({ "body": replacement }).to_string();
        }
        return replacement.clone();
    }

    info!(
        source = "failure-lambda",
        mode = "corruption",
        action = "inject",
        method = "mangle",
    );

    // Try to parse as JSON and mangle the body field
    if let Ok(mut json) = serde_json::from_str::<serde_json::Value>(body) {
        if let Some(obj) = json.as_object_mut() {
            if let Some(serde_json::Value::String(ref body_str)) = obj.get("body").cloned() {
                let mangled = mangle_string(body_str);
                obj.insert("body".to_string(), serde_json::Value::String(mangled));
                return serde_json::to_string(&json).unwrap_or_else(|_| body.to_string());
            }
        }
    }

    warn!(
        source = "failure-lambda",
        mode = "corruption",
        message = "response has no string body field to mangle; returning unchanged",
    );
    body.to_string()
}

fn mangle_string(input: &str) -> String {
    if input.is_empty() {
        return input.to_string();
    }
    let truncate_fraction = 0.3 + rand::thread_rng().gen::<f64>() * 0.5;
    let truncate_point = (input.len() as f64 * truncate_fraction).floor() as usize;
    // Ensure we don't split a multi-byte character
    let safe_point = input
        .char_indices()
        .take_while(|&(i, _)| i <= truncate_point)
        .last()
        .map(|(i, _)| i)
        .unwrap_or(0);
    let mut result = input[..safe_point].to_string();
    result.push_str("\u{FFFD}\u{FFFD}\u{FFFD}");
    result
}

/// Resolve a dot-separated path against a nested JSON value.
pub fn get_nested_value<'a>(obj: &'a serde_json::Value, path: &str) -> Option<&'a serde_json::Value> {
    let mut current = obj;
    for part in path.split('.') {
        match current.get(part) {
            Some(v) => current = v,
            None => return None,
        }
    }
    Some(current)
}

// Cache for compiled regex patterns used in match conditions.
thread_local! {
    static REGEX_CACHE: std::cell::RefCell<HashMap<String, Regex>> =
        std::cell::RefCell::new(HashMap::new());
}

fn get_cached_regex(pattern: &str) -> Option<Regex> {
    REGEX_CACHE.with(|cache| {
        let mut cache = cache.borrow_mut();
        if let Some(re) = cache.get(pattern) {
            return Some(re.clone());
        }
        match Regex::new(pattern) {
            Ok(re) => {
                cache.insert(pattern.to_string(), re.clone());
                Some(re)
            }
            Err(_) => None,
        }
    })
}

/// Evaluate a single match operator against an actual JSON value.
fn match_operator(actual: Option<&serde_json::Value>, operator: &MatchOperator, value: Option<&str>) -> bool {
    match operator {
        MatchOperator::Exists => actual.is_some() && !actual.unwrap().is_null(),
        MatchOperator::StartsWith => {
            match actual {
                Some(v) if !v.is_null() => {
                    let actual_str = json_value_to_string(v);
                    actual_str.starts_with(value.unwrap_or(""))
                }
                _ => false,
            }
        }
        MatchOperator::Regex => {
            match actual {
                Some(v) if !v.is_null() => {
                    let actual_str = json_value_to_string(v);
                    match get_cached_regex(value.unwrap_or("")) {
                        Some(re) => re.is_match(&actual_str),
                        None => false,
                    }
                }
                _ => false,
            }
        }
        MatchOperator::Eq => {
            match actual {
                Some(v) if !v.is_null() => {
                    let actual_str = json_value_to_string(v);
                    actual_str == value.unwrap_or("")
                }
                _ => false,
            }
        }
    }
}

fn json_value_to_string(v: &serde_json::Value) -> String {
    match v {
        serde_json::Value::String(s) => s.clone(),
        serde_json::Value::Number(n) => n.to_string(),
        serde_json::Value::Bool(b) => b.to_string(),
        other => other.to_string(),
    }
}

/// Check whether all match conditions are satisfied by the event.
pub fn matches_conditions(event: &serde_json::Value, conditions: &[MatchCondition]) -> bool {
    conditions.iter().all(|condition| {
        let actual = get_nested_value(event, &condition.path);
        let operator = condition.operator.as_ref().cloned().unwrap_or(MatchOperator::Eq);
        match_operator(actual, &operator, condition.value.as_deref())
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_get_nested_value() {
        let event = serde_json::json!({
            "requestContext": {
                "http": {
                    "method": "GET"
                }
            },
            "headers": {
                "host": "example.com"
            }
        });

        let val = get_nested_value(&event, "requestContext.http.method");
        assert_eq!(val.unwrap().as_str(), Some("GET"));

        let val = get_nested_value(&event, "headers.host");
        assert_eq!(val.unwrap().as_str(), Some("example.com"));

        assert!(get_nested_value(&event, "nonexistent.path").is_none());
    }

    #[test]
    fn test_matches_conditions_eq() {
        let event = serde_json::json!({
            "requestContext": { "http": { "method": "GET" } }
        });
        let conditions = vec![MatchCondition {
            path: "requestContext.http.method".to_string(),
            value: Some("GET".to_string()),
            operator: None,
        }];
        assert!(matches_conditions(&event, &conditions));

        let conditions_no_match = vec![MatchCondition {
            path: "requestContext.http.method".to_string(),
            value: Some("POST".to_string()),
            operator: None,
        }];
        assert!(!matches_conditions(&event, &conditions_no_match));
    }

    #[test]
    fn test_matches_conditions_exists() {
        let event = serde_json::json!({ "headers": { "host": "example.com" } });

        let conditions = vec![MatchCondition {
            path: "headers.host".to_string(),
            value: None,
            operator: Some(MatchOperator::Exists),
        }];
        assert!(matches_conditions(&event, &conditions));

        let conditions_missing = vec![MatchCondition {
            path: "headers.authorization".to_string(),
            value: None,
            operator: Some(MatchOperator::Exists),
        }];
        assert!(!matches_conditions(&event, &conditions_missing));
    }

    #[test]
    fn test_matches_conditions_starts_with() {
        let event = serde_json::json!({ "path": "/api/v1/users" });

        let conditions = vec![MatchCondition {
            path: "path".to_string(),
            value: Some("/api/v1".to_string()),
            operator: Some(MatchOperator::StartsWith),
        }];
        assert!(matches_conditions(&event, &conditions));
    }

    #[test]
    fn test_matches_conditions_regex() {
        let event = serde_json::json!({ "path": "/api/v2/users/123" });

        let conditions = vec![MatchCondition {
            path: "path".to_string(),
            value: Some(r"/api/v\d+/users/\d+".to_string()),
            operator: Some(MatchOperator::Regex),
        }];
        assert!(matches_conditions(&event, &conditions));
    }

    #[test]
    fn test_matches_conditions_all_must_match() {
        let event = serde_json::json!({
            "requestContext": { "http": { "method": "GET" } },
            "path": "/api/v1/users"
        });

        // Both match
        let conditions = vec![
            MatchCondition {
                path: "requestContext.http.method".to_string(),
                value: Some("GET".to_string()),
                operator: None,
            },
            MatchCondition {
                path: "path".to_string(),
                value: Some("/api/v1".to_string()),
                operator: Some(MatchOperator::StartsWith),
            },
        ];
        assert!(matches_conditions(&event, &conditions));

        // One doesn't match
        let conditions_partial = vec![
            MatchCondition {
                path: "requestContext.http.method".to_string(),
                value: Some("POST".to_string()),
                operator: None,
            },
            MatchCondition {
                path: "path".to_string(),
                value: Some("/api/v1".to_string()),
                operator: Some(MatchOperator::StartsWith),
            },
        ];
        assert!(!matches_conditions(&event, &conditions_partial));
    }

    #[test]
    fn test_matches_conditions_empty_conditions() {
        let event = serde_json::json!({});
        assert!(matches_conditions(&event, &[]));
    }

    #[test]
    fn test_build_exception_payload() {
        let flag = FlagValue {
            enabled: true,
            exception_msg: Some("chaos test".to_string()),
            ..Default::default()
        };
        let payload = build_exception_payload(&flag);
        assert_eq!(payload["errorMessage"], "chaos test");
        assert_eq!(payload["errorType"], "FailureLambdaException");
    }

    #[test]
    fn test_build_exception_payload_default_msg() {
        let flag = FlagValue {
            enabled: true,
            ..Default::default()
        };
        let payload = build_exception_payload(&flag);
        assert_eq!(payload["errorMessage"], "Injected exception");
    }

    #[test]
    fn test_build_statuscode_payload() {
        let flag = FlagValue {
            enabled: true,
            status_code: Some(503),
            ..Default::default()
        };
        let payload = build_statuscode_payload(&flag);
        assert_eq!(payload["statusCode"], 503);
        assert!(payload["headers"]["Content-Type"].as_str().unwrap().contains("json"));
    }

    #[test]
    fn test_build_statuscode_payload_default() {
        let flag = FlagValue {
            enabled: true,
            ..Default::default()
        };
        let payload = build_statuscode_payload(&flag);
        assert_eq!(payload["statusCode"], 500);
    }

    #[test]
    fn test_corrupt_response_replace() {
        let flag = FlagValue {
            enabled: true,
            body: Some("replaced body".to_string()),
            ..Default::default()
        };
        let body = r#"{"statusCode":200,"body":"original"}"#;
        let result = corrupt_response(&flag, body);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["body"], "replaced body");
        assert_eq!(parsed["statusCode"], 200);
    }

    #[test]
    fn test_corrupt_response_mangle() {
        let flag = FlagValue {
            enabled: true,
            ..Default::default()
        };
        let body = r#"{"statusCode":200,"body":"hello world this is a test message"}"#;
        let result = corrupt_response(&flag, body);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        let mangled_body = parsed["body"].as_str().unwrap();
        assert!(mangled_body.contains('\u{FFFD}'));
        assert!(mangled_body.len() < "hello world this is a test message".len() + 10);
    }

    #[test]
    fn test_corrupt_response_no_body_field() {
        let flag = FlagValue {
            enabled: true,
            ..Default::default()
        };
        let body = r#"{"statusCode":200}"#;
        let result = corrupt_response(&flag, body);
        // Should return unchanged since there's no string body to mangle
        assert_eq!(result, body);
    }

    #[test]
    fn test_corrupt_response_replace_no_body_field() {
        let flag = FlagValue {
            enabled: true,
            body: Some("injected".to_string()),
            ..Default::default()
        };
        let body = r#"{"statusCode":200}"#;
        let result = corrupt_response(&flag, body);
        let parsed: serde_json::Value = serde_json::from_str(&result).unwrap();
        assert_eq!(parsed["body"], "injected");
    }

    #[test]
    fn test_mangle_string() {
        let input = "hello world this is a test message with enough characters";
        let result = mangle_string(input);
        assert!(result.contains('\u{FFFD}'));
        assert!(result.ends_with("\u{FFFD}\u{FFFD}\u{FFFD}"));
        // The truncated part should be shorter than original
        let without_replacement = result.trim_end_matches('\u{FFFD}');
        assert!(without_replacement.len() < input.len());
    }

    #[test]
    fn test_mangle_string_empty() {
        assert_eq!(mangle_string(""), "");
    }

    #[test]
    fn test_json_value_to_string() {
        assert_eq!(json_value_to_string(&serde_json::json!("hello")), "hello");
        assert_eq!(json_value_to_string(&serde_json::json!(42)), "42");
        assert_eq!(json_value_to_string(&serde_json::json!(true)), "true");
    }
}
