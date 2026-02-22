import type { Context } from "aws-lambda";
import type { FlagValue } from "../types.js";

export async function injectTimeout(flag: FlagValue, context: Context): Promise<void> {
  const bufferMs = flag.timeout_buffer_ms ?? 0;
  const remaining = context.getRemainingTimeInMillis();
  const sleepMs = Math.max(0, remaining - bufferMs);

  console.log(
    `[failure-lambda] Injecting timeout: sleeping ${sleepMs}ms (buffer: ${bufferMs}ms, remaining: ${remaining}ms)`,
  );
  await new Promise<void>((resolve) => setTimeout(resolve, sleepMs));
}
