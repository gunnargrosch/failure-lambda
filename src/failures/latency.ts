import type { FlagValue } from "../types.js";
import { log } from "../log.js";

export async function injectLatency(flag: FlagValue): Promise<void> {
  const minLatency = flag.min_latency ?? 0;
  const maxLatency = flag.max_latency ?? 0;
  const latencyRange = Math.max(0, maxLatency - minLatency);
  const injectedLatency = Math.floor(minLatency + Math.random() * latencyRange);

  log({ mode: "latency", action: "inject", latency_ms: injectedLatency, min_latency: minLatency, max_latency: maxLatency });
  await new Promise<void>((resolve) => setTimeout(resolve, injectedLatency));
}
