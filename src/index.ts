import type { Context, Callback } from "aws-lambda";
import type { FailureFlagsConfig, LambdaHandler, FailureLambdaOptions } from "./types.js";
import { getConfig, resolveFailures } from "./config.js";
import { error as logError } from "./log.js";
import { clearDenylist } from "./failures/index.js";
import { runPreHandlerInjections, runPostHandlerInjections } from "./orchestration.js";

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
  MatchOperator,
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
    if (process.env.FAILURE_LAMBDA_DISABLED === "true") {
      return await handler(event, context, callback) as TResult;
    }

    try {
      const configProvider = options?.configProvider ?? getConfig;
      const flagsConfig: FailureFlagsConfig = await configProvider();
      const failures = resolveFailures(flagsConfig);

      const dryRun = options?.dryRun === true;

      const preResult = await runPreHandlerInjections<TEvent, TResult>(failures, event, context, dryRun);
      if (preResult) {
        return preResult.shortCircuit;
      }

      const result = await handler(event, context, callback) as TResult;

      return runPostHandlerInjections(failures, event, result, dryRun);
    } catch (err) {
      logError({ action: "error", message: err instanceof Error ? err.message : String(err) });
      clearDenylist();
      throw err;
    }
  };
}

// Default export for backwards compatibility: failureLambda(handler)
export default injectFailure;

// Named export for explicit imports
export { injectFailure };
