import type { Context } from "aws-lambda";
import type { FailureLambdaOptions, ResolvedFailure } from "./types.js";
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

interface MiddyRequest<TEvent = unknown, TResult = unknown> {
  event: TEvent;
  context: Context;
  response?: TResult;
  internal?: Record<string, unknown>;
}

interface MiddyMiddleware<TEvent = unknown, TResult = unknown> {
  before: (request: MiddyRequest<TEvent, TResult>) => Promise<TResult | void>;
  after: (request: MiddyRequest<TEvent, TResult>) => Promise<void>;
}

export function failureLambdaMiddleware<TEvent = unknown, TResult = unknown>(
  options?: FailureLambdaOptions,
): MiddyMiddleware<TEvent, TResult> {
  return {
    before: async (request) => {
      const configProvider = options?.configProvider ?? getConfig;
      const flagsConfig = await configProvider();
      const failures = resolveFailures(flagsConfig);

      // Store resolved failures for after phase
      request.internal = { ...request.internal, failureLambdaFailures: failures };

      if (!failures.some((f) => f.mode === "denylist")) {
        clearMitm();
      }

      for (const failure of failures) {
        if (failure.mode === "corruption") continue;
        if (failure.flag.match && !matchesConditions(request.event, failure.flag.match)) continue;
        if (Math.random() >= failure.rate) continue;

        switch (failure.mode) {
          case "latency":
            await injectLatency(failure.flag);
            break;
          case "timeout":
            await injectTimeout(failure.flag, request.context);
            break;
          case "diskspace":
            injectDiskSpace(failure.flag);
            break;
          case "denylist":
            injectDenylist(failure.flag);
            break;
          case "statuscode":
            request.response = injectStatusCode(failure.flag) as unknown as TResult;
            return request.response;
          case "exception":
            injectException(failure.flag);
        }
      }
    },
    after: async (request) => {
      const failures = (request.internal?.failureLambdaFailures ?? []) as ResolvedFailure[];

      for (const failure of failures) {
        if (failure.mode !== "corruption") continue;
        if (failure.flag.match && !matchesConditions(request.event, failure.flag.match)) continue;
        if (Math.random() >= failure.rate) continue;

        request.response = corruptResponse(failure.flag, request.response) as TResult;
      }
    },
  };
}
