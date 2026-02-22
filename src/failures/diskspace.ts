import { spawnSync } from "node:child_process";
import type { FlagValue } from "../types.js";
import { log, error } from "../log.js";

/** Fill /tmp with data using dd. Only works on Linux (Lambda runtime); not available on Windows/macOS. */
export function injectDiskSpace(flag: FlagValue): void {
  const diskSpaceMB = flag.disk_space ?? 100;
  log({ mode: "diskspace", action: "inject", disk_space_mb: diskSpaceMB });

  const result = spawnSync("dd", [
    "if=/dev/zero",
    `of=/tmp/diskspace-failure-${Date.now()}.tmp`,
    "count=1000",
    `bs=${diskSpaceMB * 1024}`,
  ]);

  if (result.error) {
    error({ mode: "diskspace", action: "error", message: result.error.message });
  } else if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    error({ mode: "diskspace", action: "error", message: `dd exited with status ${result.status}`, stderr });
  }
}
