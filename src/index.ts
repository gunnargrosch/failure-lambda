import type { Context, Callback } from "aws-lambda";
import type { FailureFlagsConfig, LambdaHandler, FailureLambdaOptions } from "./types.js";
import { getConfig, resolveFailures } from "./config.js";
import {
  injectLatency,
  injectException,
  injectStatusCode,
  injectDiskSpace,
  injectDenylist,
  injectTimeout,
  corruptResponse,
  clearMitm,
} from "./failures/index.js";
import { matchesConditions } from "./matching.js";

// Re-export types for consumers
export type {
  FailureMode,
  FlagValue,
  FailureFlagsConfig,
  ResolvedFailure,
  LambdaHandler,
  FailureLambdaOptions,
  ConfigValidationError,
  MatchCondition,
} from "./types.js";
export { getConfig, clearConfigCache, validateFlagValue, parseFlags, resolveFailures } from "./config.js";
export { getNestedValue, matchesConditions } from "./matching.js";

/**
 * Wraps a Lambda handler with failure injection.
 *
 * Each failure mode is an independent feature flag. Multiple failures can
 * be active simultaneously. Pre-handler modes run before the handler
 * (latency, timeout, diskspace, denylist, statuscode, exception).
 * Post-handler modes (corruption) run after the handler returns.
 *
 * Flags with `match` conditions only fire when the event satisfies all conditions.
 *
 * @example
 * ```ts
 * import failureLambda from "failure-lambda";
 *
 * export const handler = failureLambda(async (event, context) => {
 *   // your handler logic
 * });
 * ```
 */
function injectFailure<TEvent = unknown, TResult = unknown>(
  handler: LambdaHandler<TEvent, TResult>,
  options?: FailureLambdaOptions,
): LambdaHandler<TEvent, TResult> {
  return async function wrappedHandler(
    event: TEvent,
    context: Context,
    callback: Callback<TResult>,
  ): Promise<TResult> {
    try {
      const configProvider = options?.configProvider ?? getConfig;
      const flagsConfig: FailureFlagsConfig = await configProvider();
      const failures = resolveFailures(flagsConfig);

      // Clear mitm unless denylist is among active failures
      if (!failures.some((f) => f.mode === "denylist")) {
        clearMitm();
      }

      // --- Pre-handler injection ---
      for (const failure of failures) {
        if (failure.mode === "corruption") continue;
        if (failure.flag.match && !matchesConditions(event, failure.flag.match)) continue;
        if (Math.random() >= failure.rate) continue;

        switch (failure.mode) {
          case "latency":
            await injectLatency(failure.flag);
            break;
          case "timeout":
            await injectTimeout(failure.flag, context);
            break;
          case "diskspace":
            injectDiskSpace(failure.flag);
            break;
          case "denylist":
            injectDenylist(failure.flag);
            break;
          case "statuscode":
            return injectStatusCode(failure.flag) as unknown as TResult;
          case "exception":
            injectException(failure.flag);
        }
      }

      // --- Handler ---
      let result: unknown = await handler(event, context, callback);

      // --- Post-handler injection ---
      for (const failure of failures) {
        if (failure.mode !== "corruption") continue;
        if (failure.flag.match && !matchesConditions(event, failure.flag.match)) continue;
        if (Math.random() >= failure.rate) continue;

        result = corruptResponse(failure.flag, result);
      }

      return result as TResult;
    } catch (error) {
      console.error("[failure-lambda]", error);
      clearMitm();
      throw error;
    }
  };
}

// Default export for backwards compatibility: failureLambda(handler)
export default injectFailure;

// Named export for explicit imports
export { injectFailure };
