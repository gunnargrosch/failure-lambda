import type { Context } from "aws-lambda";
import type { FailureLambdaOptions, ResolvedFailure } from "./types.js";
import { getConfig, resolveFailures } from "./config.js";
import { runPreHandlerInjections, runPostHandlerInjections } from "./orchestration.js";

interface MiddyRequest<TEvent = unknown, TResult = unknown> {
  event: TEvent;
  context: Context;
  response?: TResult;
  internal?: Record<string, unknown>;
}

interface MiddyMiddleware<TEvent = unknown, TResult = unknown> {
  // eslint-disable-next-line @typescript-eslint/no-invalid-void-type -- Middy before hook returns TResult | void
  before: (request: MiddyRequest<TEvent, TResult>) => Promise<TResult | void>;
  after: (request: MiddyRequest<TEvent, TResult>) => Promise<void>;
}

export function failureLambdaMiddleware<TEvent = unknown, TResult = unknown>(
  options?: FailureLambdaOptions,
): MiddyMiddleware<TEvent, TResult> {
  return {
    before: async (request) => {
      if (process.env.FAILURE_LAMBDA_DISABLED === "true") {
        return;
      }

      const configProvider = options?.configProvider ?? getConfig;
      const flagsConfig = await configProvider();
      const failures = resolveFailures(flagsConfig);

      // Store resolved failures for after phase
      request.internal = { ...request.internal, failureLambdaFailures: failures };

      const dryRun = options?.dryRun === true;

      const preResult = await runPreHandlerInjections<TEvent, TResult>(
        failures,
        request.event,
        request.context,
        dryRun,
      );
      if (preResult) {
        request.response = preResult.shortCircuit;
        return preResult.shortCircuit;
      }
    },
    after: async (request) => {
      const failures = (request.internal?.failureLambdaFailures ?? []) as ResolvedFailure[];

      const dryRun = options?.dryRun === true;

      request.response = runPostHandlerInjections(
        failures,
        request.event,
        request.response,
        dryRun,
      );
    },
  };
}
