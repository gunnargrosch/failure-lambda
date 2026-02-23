import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import type {
  FailureMode,
  FlagValue,
  FailureFlagsConfig,
  ResolvedFailure,
  CachedConfig,
  ConfigValidationError,
} from "./types.js";
import { DEFAULT_FLAGS_CONFIG, FAILURE_MODE_ORDER } from "./types.js";
import { log, warn, error } from "./log.js";

const KNOWN_FLAGS: ReadonlySet<string> = new Set(FAILURE_MODE_ORDER);

const DEFAULT_CACHE_TTL_SECONDS = 60;

/** Module-level cache. Resets naturally on Lambda cold start. */
let configCache: CachedConfig | null = null;

/** Lazy-initialized SSM client. Created on first use to avoid cold start penalty when using AppConfig. */
let ssmClient: SSMClient | null = null;

/** Whether we've logged the config source yet (once per cold start) */
let hasLoggedSource = false;

function getSSMClient(): SSMClient {
  if (ssmClient === null) {
    ssmClient = new SSMClient({});
  }
  return ssmClient;
}

function isAppConfigSource(): boolean {
  return Boolean(process.env.FAILURE_APPCONFIG_CONFIGURATION);
}

function getCacheTtlMs(): number {
  const envValue = process.env.FAILURE_CACHE_TTL;
  if (envValue === undefined || envValue === "") {
    // Auto-disable library cache for AppConfig — the extension already caches
    // at its poll interval (AWS_APPCONFIG_EXTENSION_POLL_INTERVAL_SECONDS).
    // Double-caching adds unnecessary staleness when changing config.
    if (isAppConfigSource()) {
      return 0;
    }
    return DEFAULT_CACHE_TTL_SECONDS * 1000;
  }
  const parsed = Number(envValue);
  if (Number.isNaN(parsed) || parsed < 0) {
    warn({ action: "config", message: `invalid FAILURE_CACHE_TTL="${envValue}", using default ${DEFAULT_CACHE_TTL_SECONDS}s` });
    return DEFAULT_CACHE_TTL_SECONDS * 1000;
  }
  if (parsed > 0 && isAppConfigSource()) {
    warn({
      action: "config",
      message: `FAILURE_CACHE_TTL=${parsed}s with AppConfig — the AppConfig extension already caches at its poll interval; library caching adds staleness`,
    });
  }
  return parsed * 1000;
}

function isCacheValid(): boolean {
  if (configCache === null) {
    return false;
  }
  const ttlMs = getCacheTtlMs();
  if (ttlMs === 0) {
    return false;
  }
  return Date.now() - configCache.fetchedAt < ttlMs;
}

/** Validate a single flag value. Returns array of errors (empty = valid). */
export function validateFlagValue(
  mode: string,
  raw: Record<string, unknown>,
): ConfigValidationError[] {
  const errors: ConfigValidationError[] = [];

  if (typeof raw.enabled !== "boolean") {
    errors.push({
      field: `${mode}.enabled`,
      message: "must be a boolean",
      value: raw.enabled,
    });
  }

  if (raw.rate !== undefined) {
    if (typeof raw.rate !== "number" || raw.rate < 0 || raw.rate > 1) {
      errors.push({
        field: `${mode}.rate`,
        message: "must be a number between 0 and 1",
        value: raw.rate,
      });
    }
  }

  if (mode === "latency") {
    if (raw.min_latency !== undefined) {
      if (typeof raw.min_latency !== "number" || raw.min_latency < 0) {
        errors.push({
          field: `${mode}.min_latency`,
          message: "must be a non-negative number",
          value: raw.min_latency,
        });
      }
    }
    if (raw.max_latency !== undefined) {
      if (typeof raw.max_latency !== "number" || raw.max_latency < 0) {
        errors.push({
          field: `${mode}.max_latency`,
          message: "must be a non-negative number",
          value: raw.max_latency,
        });
      }
    }
    if (
      typeof raw.min_latency === "number" &&
      typeof raw.max_latency === "number" &&
      raw.min_latency > raw.max_latency
    ) {
      errors.push({
        field: `${mode}.max_latency`,
        message: "max_latency must be >= min_latency",
        value: raw.max_latency,
      });
    }
  }

  if (mode === "exception") {
    if (raw.exception_msg !== undefined && typeof raw.exception_msg !== "string") {
      errors.push({
        field: `${mode}.exception_msg`,
        message: "must be a string",
        value: raw.exception_msg,
      });
    }
  }

  if (mode === "statuscode") {
    if (raw.status_code !== undefined) {
      if (typeof raw.status_code !== "number" || raw.status_code < 100 || raw.status_code > 599) {
        errors.push({
          field: `${mode}.status_code`,
          message: "must be an HTTP status code (100-599)",
          value: raw.status_code,
        });
      }
    }
  }

  if (mode === "diskspace") {
    if (raw.disk_space !== undefined) {
      if (typeof raw.disk_space !== "number" || raw.disk_space <= 0) {
        errors.push({
          field: `${mode}.disk_space`,
          message: "must be a positive number (MB)",
          value: raw.disk_space,
        });
      }
    }
  }

  if (mode === "denylist") {
    if (raw.deny_list !== undefined) {
      if (
        !Array.isArray(raw.deny_list) ||
        !raw.deny_list.every((item: unknown) => typeof item === "string")
      ) {
        errors.push({
          field: `${mode}.deny_list`,
          message: "must be an array of strings",
          value: raw.deny_list,
        });
      } else {
        for (let i = 0; i < raw.deny_list.length; i++) {
          try {
            new RegExp(raw.deny_list[i] as string);
          } catch {
            errors.push({
              field: `${mode}.deny_list[${i}]`,
              message: "invalid regular expression",
              value: raw.deny_list[i],
            });
          }
        }
      }
    }
  }

  if (mode === "timeout") {
    if (raw.timeout_buffer_ms !== undefined) {
      if (typeof raw.timeout_buffer_ms !== "number" || raw.timeout_buffer_ms < 0) {
        errors.push({
          field: `${mode}.timeout_buffer_ms`,
          message: "must be a non-negative number",
          value: raw.timeout_buffer_ms,
        });
      }
    }
  }

  if (mode === "corruption") {
    if (raw.body !== undefined && typeof raw.body !== "string") {
      errors.push({
        field: `${mode}.body`,
        message: "must be a string",
        value: raw.body,
      });
    }
  }

  if (raw.match !== undefined) {
    if (!Array.isArray(raw.match)) {
      errors.push({
        field: `${mode}.match`,
        message: "must be an array of match condition objects",
        value: raw.match,
      });
    } else {
      const VALID_OPERATORS = new Set(["eq", "exists", "startsWith", "regex"]);
      for (let i = 0; i < raw.match.length; i++) {
        const condition = raw.match[i] as unknown;
        if (typeof condition !== "object" || condition === null) {
          errors.push({
            field: `${mode}.match[${i}]`,
            message: "must be an object with a string path field",
            value: condition,
          });
          continue;
        }
        const cond = condition as Record<string, unknown>;
        if (typeof cond.path !== "string") {
          errors.push({
            field: `${mode}.match[${i}].path`,
            message: "must be a string",
            value: cond.path,
          });
        }
        const operator = (cond.operator as string) ?? "eq";
        if (cond.operator !== undefined && !VALID_OPERATORS.has(operator)) {
          errors.push({
            field: `${mode}.match[${i}].operator`,
            message: `must be one of: eq, exists, startsWith, regex`,
            value: cond.operator,
          });
        }
        if (operator !== "exists" && typeof cond.value !== "string") {
          errors.push({
            field: `${mode}.match[${i}].value`,
            message: "must be a string (required for all operators except 'exists')",
            value: cond.value,
          });
        }
        if (operator === "regex" && typeof cond.value === "string") {
          try {
            new RegExp(cond.value);
          } catch {
            errors.push({
              field: `${mode}.match[${i}].value`,
              message: "invalid regular expression",
              value: cond.value,
            });
          }
        }
      }
    }
  }

  return errors;
}

/** Parse raw JSON into FailureFlagsConfig. Validates each known flag key. */
export function parseFlags(raw: Record<string, unknown>): FailureFlagsConfig {
  const config: FailureFlagsConfig = {};

  for (const key of Object.keys(raw)) {
    if (!KNOWN_FLAGS.has(key)) {
      continue;
    }

    const mode = key as FailureMode;
    const flagRaw = raw[mode];

    if (typeof flagRaw !== "object" || flagRaw === null || Array.isArray(flagRaw)) {
      warn({ action: "config", mode, message: "must be an object, skipping" });
      continue;
    }

    const flagObj = flagRaw as Record<string, unknown>;
    const validationErrors = validateFlagValue(mode, flagObj);

    if (validationErrors.length > 0) {
      for (const validationError of validationErrors) {
        warn({ action: "config", field: validationError.field, message: validationError.message, value: validationError.value });
      }
      if (validationErrors.some((e) => e.field.endsWith(".enabled"))) {
        warn({ action: "config", mode, message: "skipping flag due to invalid enabled field" });
        continue;
      }
    }

    config[mode] = flagObj as unknown as FlagValue;
  }

  return config;
}

/**
 * Resolve enabled flags into an ordered array of failures to inject.
 * Order: latency, diskspace, denylist (non-terminating), then statuscode, exception (terminating).
 * Defaults rate to 1 when omitted.
 */
export function resolveFailures(config: FailureFlagsConfig): ResolvedFailure[] {
  const failures: ResolvedFailure[] = [];

  for (const mode of FAILURE_MODE_ORDER) {
    const flag = config[mode];
    if (flag === undefined || !flag.enabled) {
      continue;
    }

    failures.push({
      mode,
      rate: Math.max(0, Math.min(1, flag.rate ?? 1)),
      flag,
    });
  }

  return failures;
}

async function fetchFromAppConfig(): Promise<FailureFlagsConfig> {
  const appConfigPort = process.env.AWS_APPCONFIG_EXTENSION_HTTP_PORT ?? "2772";
  const application = process.env.FAILURE_APPCONFIG_APPLICATION;
  const environment = process.env.FAILURE_APPCONFIG_ENVIRONMENT;
  const configuration = process.env.FAILURE_APPCONFIG_CONFIGURATION;

  const url =
    `http://localhost:${appConfigPort}` +
    `/applications/${application}` +
    `/environments/${environment}` +
    `/configurations/${configuration}`;

  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(
      `AppConfig fetch failed: ${response.status} ${response.statusText}`
    );
  }

  const json = (await response.json()) as Record<string, unknown>;
  return parseFlags(json);
}

async function fetchFromSSM(): Promise<FailureFlagsConfig> {
  const parameterName = process.env.FAILURE_INJECTION_PARAM as string;
  const client = getSSMClient();
  const command = new GetParameterCommand({ Name: parameterName });
  const response = await client.send(command);

  const rawValue = response.Parameter?.Value;
  if (rawValue === undefined) {
    throw new Error(`SSM parameter "${parameterName}" has no value`);
  }

  const json = JSON.parse(rawValue) as Record<string, unknown>;
  return parseFlags(json);
}

/** Fetch config from AppConfig or SSM, with caching. */
export async function getConfig(): Promise<FailureFlagsConfig> {
  if (isCacheValid() && configCache !== null) {
    return configCache.config;
  }

  try {
    let config: FailureFlagsConfig;
    let source: string;

    if (process.env.FAILURE_APPCONFIG_CONFIGURATION) {
      config = await fetchFromAppConfig();
      source = "appconfig";
    } else if (process.env.FAILURE_INJECTION_PARAM) {
      config = await fetchFromSSM();
      source = "ssm";
    } else {
      return { ...DEFAULT_FLAGS_CONFIG };
    }

    if (!hasLoggedSource) {
      const cacheTtlMs = getCacheTtlMs();
      log({
        action: "config",
        source,
        cache_ttl_seconds: cacheTtlMs / 1000,
        enabled_flags: Object.keys(config).filter(
          (k) => (config as Record<string, { enabled?: boolean }>)[k]?.enabled,
        ),
      });
      hasLoggedSource = true;
    }

    configCache = {
      config,
      fetchedAt: Date.now(),
    };

    return config;
  } catch (err) {
    error({ action: "config", message: "error fetching config", error: String(err) });
    return { ...DEFAULT_FLAGS_CONFIG };
  }
}

/** Clear the config cache. Useful for testing. @internal */
export function clearConfigCache(): void {
  configCache = null;
  hasLoggedSource = false;
}

/** Replace the SSM client instance. For testing with mocks. @internal */
export function setSSMClient(client: SSMClient): void {
  ssmClient = client;
}
