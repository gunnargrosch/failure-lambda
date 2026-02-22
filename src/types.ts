import type { Context, Callback } from "aws-lambda";

/** The supported failure injection modes */
export type FailureMode =
  | "latency"
  | "exception"
  | "statuscode"
  | "diskspace"
  | "denylist"
  | "timeout"
  | "corruption";

/**
 * Ordered list of all failure modes.
 * Non-terminating pre-handler first, then terminating, then post-handler (corruption) last.
 */
export const FAILURE_MODE_ORDER: readonly FailureMode[] = [
  "latency",
  "timeout",
  "diskspace",
  "denylist",
  "statuscode",
  "exception",
  "corruption",
];

/** Match operators for event-based targeting */
export type MatchOperator = "eq" | "exists" | "startsWith" | "regex";

/** Condition for event-based targeting */
export interface MatchCondition {
  /** Dot-separated path into the event object (e.g. "requestContext.http.method") */
  path: string;
  /** Expected string value at the path. Required for all operators except "exists". */
  value?: string;
  /** Comparison operator. Defaults to "eq". */
  operator?: MatchOperator;
}

/** A single feature flag's value */
export interface FlagValue {
  enabled: boolean;
  /** Probability of injection per invocation (0.0 to 1.0). Defaults to 1. */
  rate?: number;
  /** Minimum latency in ms (latency mode) */
  min_latency?: number;
  /** Maximum latency in ms (latency mode) */
  max_latency?: number;
  /** Error message to throw (exception mode) */
  exception_msg?: string;
  /** HTTP status code to return (statuscode mode) */
  status_code?: number;
  /** MB of disk to fill in /tmp (diskspace mode) */
  disk_space?: number;
  /** Array of regex patterns for hosts to block (denylist mode) */
  deny_list?: string[];
  /** Buffer in ms before Lambda timeout (timeout mode). Default: 0 */
  timeout_buffer_ms?: number;
  /** Replacement body string (corruption mode) */
  body?: string;
  /** Event-based targeting conditions. All conditions must match for the flag to fire. */
  match?: MatchCondition[];
}

/** The full config: a map of failure mode names to their flag values */
export type FailureFlagsConfig = Partial<Record<FailureMode, FlagValue>>;

/** A failure resolved and ready to inject */
export interface ResolvedFailure {
  mode: FailureMode;
  rate: number;
  flag: FlagValue;
}

/** Default: empty config, all modes disabled */
export const DEFAULT_FLAGS_CONFIG: FailureFlagsConfig = {};

/**
 * Generic Lambda handler type. Intentionally broad to support any
 * event source (API Gateway, SQS, SNS, EventBridge, etc.).
 */
export type LambdaHandler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  context: Context,
  callback: Callback<TResult>,
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Lambda handlers may return void or Promise
) => void | Promise<TResult>;

/** Options for the injectFailure wrapper */
export interface FailureLambdaOptions {
  /** Override the config source (useful for testing or custom config backends) */
  configProvider?: () => Promise<FailureFlagsConfig>;
  /** Log which failures would fire without actually injecting them */
  dryRun?: boolean;
}

/** Internal: cached config entry */
export interface CachedConfig {
  config: FailureFlagsConfig;
  fetchedAt: number;
}

/** Validation error detail */
export interface ConfigValidationError {
  field: string;
  message: string;
  value: unknown;
}
