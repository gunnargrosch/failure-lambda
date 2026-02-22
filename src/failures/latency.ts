import type { FlagValue } from "../types.js";

export async function injectLatency(flag: FlagValue): Promise<void> {
  const minLatency = flag.min_latency ?? 0;
  const maxLatency = flag.max_latency ?? 0;
  const latencyRange = maxLatency - minLatency;
  const injectedLatency = Math.floor(minLatency + Math.random() * latencyRange);

  console.log(`[failure-lambda] Injecting ${injectedLatency}ms latency`);
  await new Promise<void>((resolve) => setTimeout(resolve, injectedLatency));
}
