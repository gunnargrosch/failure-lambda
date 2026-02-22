import { spawnSync } from "node:child_process";
import type { FlagValue } from "../types.js";

export function injectDiskSpace(flag: FlagValue): void {
  const diskSpaceMB = flag.disk_space ?? 100;
  console.log(`[failure-lambda] Injecting disk space: ${diskSpaceMB}MB`);

  const result = spawnSync("dd", [
    "if=/dev/zero",
    `of=/tmp/diskspace-failure-${Date.now()}.tmp`,
    "count=1000",
    `bs=${diskSpaceMB * 1000}`,
  ]);

  if (result.error) {
    console.error("[failure-lambda] Failed to inject disk space:", result.error);
  }
}
