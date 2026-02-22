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
import { log } from "./log.js";

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
  dryRun = false,
): Promise<ShortCircuitResult<TResult> | undefined> {
  if (!dryRun && !failures.some((f) => f.mode === "denylist")) {
    clearDenylist();
  }

  for (const failure of failures) {
    if (failure.mode === "corruption") continue;
    if (failure.flag.match && !matchesConditions(event, failure.flag.match)) continue;
    if (Math.random() >= failure.rate) continue;

    if (dryRun) {
      log({ mode: failure.mode, action: "dryrun", rate: failure.rate });
      continue;
    }

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
export function runPostHandlerInjections<TEvent = unknown, TResult = unknown>(
  failures: ResolvedFailure[],
  event: TEvent,
  result: TResult,
  dryRun = false,
): TResult {
  let current: unknown = result;

  for (const failure of failures) {
    if (failure.mode !== "corruption") continue;
    if (failure.flag.match && !matchesConditions(event, failure.flag.match)) continue;
    if (Math.random() >= failure.rate) continue;

    if (dryRun) {
      log({ mode: failure.mode, action: "dryrun", rate: failure.rate });
      continue;
    }

    current = corruptResponse(failure.flag, current);
  }

  return current as TResult;
}
