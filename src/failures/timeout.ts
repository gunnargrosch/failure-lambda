import type { Context } from "aws-lambda";
import type { FlagValue } from "../types.js";
import { log } from "../log.js";

export async function injectTimeout(flag: FlagValue, context: Context): Promise<void> {
  const bufferMs = flag.timeout_buffer_ms ?? 0;
  const remaining = context.getRemainingTimeInMillis();
  const sleepMs = Math.max(0, remaining - bufferMs);

  log({ mode: "timeout", action: "inject", sleep_ms: sleepMs, buffer_ms: bufferMs, remaining_ms: remaining });
  await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
}
