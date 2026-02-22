import type { Context } from "aws-lambda";
import type { ResolvedFailure } from "./types.js";
import {
  injectLatency,
  injectException,
  injectStatusCode,
  injectDiskSpace,
  injectDenylist,
  injectTimeout,
  corruptResponse,
  clearDenylist,
} from "./failures/index.js";
import { matchesConditions } from "./matching.js";

export interface ShortCircuitResult<TResult = unknown> {
  shortCircuit: TResult;
}

/**
 * Run pre-handler failure injections.
 *
 * Returns `{ shortCircuit }` if a terminating mode (statuscode/exception) fires,
 * or `undefined` if the handler should proceed normally.
 */
export async function runPreHandlerInjections<TEvent = unknown, TResult = unknown>(
  failures: ResolvedFailure[],
  event: TEvent,
  context: Context,
): Promise<ShortCircuitResult<TResult> | undefined> {
  if (!failures.some((f) => f.mode === "denylist")) {
    clearDenylist();
  }

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
        return { shortCircuit: injectStatusCode(failure.flag) as unknown as TResult };
      case "exception":
        injectException(failure.flag);
    }
  }

  return undefined;
}

/**
 * Run post-handler failure injections (corruption).
 *
 * Returns the (potentially modified) result.
 */
export function runPostHandlerInjections<TEvent = unknown>(
  failures: ResolvedFailure[],
  event: TEvent,
  result: unknown,
): unknown {
  for (const failure of failures) {
    if (failure.mode !== "corruption") continue;
    if (failure.flag.match && !matchesConditions(event, failure.flag.match)) continue;
    if (Math.random() >= failure.rate) continue;

    result = corruptResponse(failure.flag, result);
  }

  return result;
}
