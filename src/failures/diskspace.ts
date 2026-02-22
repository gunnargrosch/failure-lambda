import { spawnSync } from "node:child_process";
import { readdirSync, unlinkSync } from "node:fs";
import type { FlagValue } from "../types.js";
import { log, warn, error } from "../log.js";

const DISKSPACE_PREFIX = "diskspace-failure-";

/** Fill /tmp with data using dd. Only works on Linux (Lambda runtime); not available on Windows/macOS. */
export function injectDiskSpace(flag: FlagValue): void {
  const diskSpaceMB = flag.disk_space ?? 100;
  log({ mode: "diskspace", action: "inject", disk_space_mb: diskSpaceMB });

  // bs=diskSpaceMB*1024 bytes per block, count=1024 blocks → diskSpaceMB * 1024 * 1024 = exact MB
  const result = spawnSync("dd", [
    "if=/dev/zero",
    `of=/tmp/${DISKSPACE_PREFIX}${Date.now()}.tmp`,
    "count=1024",
    `bs=${diskSpaceMB * 1024}`,
  ]);

  if (result.error) {
    error({ mode: "diskspace", action: "error", message: result.error.message });
  } else if (result.status !== 0) {
    const stderr = result.stderr?.toString().trim();
    error({ mode: "diskspace", action: "error", message: `dd exited with status ${result.status}`, stderr });
  }
}

/** Remove diskspace failure files from /tmp. */
export function clearDiskSpace(): void {
  try {
    const files = readdirSync("/tmp").filter((f) => f.startsWith(DISKSPACE_PREFIX));
    for (const file of files) {
      unlinkSync(`/tmp/${file}`);
    }
    if (files.length > 0) {
      log({ mode: "diskspace", action: "clear", files_removed: files.length });
    }
  } catch (e) {
    warn({ mode: "diskspace", action: "clear_error", message: (e as Error).message });
  }
}
