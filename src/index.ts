import type { Context, Callback } from "aws-lambda";
import type { FailureFlagsConfig, LambdaHandler, FailureLambdaOptions } from "./types.js";
import { getConfig, resolveFailures } from "./config.js";
import {
  injectLatency,
  injectException,
  injectStatusCode,
  injectDiskSpace,
  injectDenylist,
  clearMitm,
} from "./failures/index.js";

// Re-export types for consumers
export type {
  FailureMode,
  FlagValue,
  FailureFlagsConfig,
  ResolvedFailure,
  LambdaHandler,
  FailureLambdaOptions,
  ConfigValidationError,
} from "./types.js";
export { getConfig, clearConfigCache, validateFlagValue, parseFlags, resolveFailures } from "./config.js";

/**
 * Wraps a Lambda handler with failure injection.
 *
 * Each failure mode is an independent feature flag. Multiple failures can
 * be active simultaneously. Non-terminating modes (latency, diskspace,
 * denylist) run first, then terminating modes (statuscode, exception)
 * short-circuit before the handler.
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

      // Inject each enabled failure (order: latency, diskspace, denylist, statuscode, exception)
      for (const failure of failures) {
        if (Math.random() >= failure.rate) {
          continue;
        }

        switch (failure.mode) {
          case "latency":
            await injectLatency(failure.flag);
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

      const result = await handler(event, context, callback);
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
