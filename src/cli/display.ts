import * as p from "@clack/prompts";
import { FAILURE_MODE_ORDER } from "../types.js";
import type { FailureFlagsConfig, FailureMode, FlagValue } from "../types.js";
import type { ConfigSource } from "./store.js";
import { sourceLabel } from "./store.js";

function modeDetail(mode: FailureMode, flag: FlagValue): string {
  const parts: string[] = [`${flag.percentage ?? 100}%`];

  switch (mode) {
    case "latency":
      parts.push(`${flag.min_latency ?? 100}-${flag.max_latency ?? 400}ms`);
      break;
    case "timeout":
      parts.push(`buffer=${flag.timeout_buffer_ms ?? 0}ms`);
      break;
    case "diskspace":
      parts.push(`${flag.disk_space ?? 100}MB`);
      break;
    case "denylist":
      if (flag.deny_list?.length) {
        parts.push(`patterns=[${flag.deny_list.join(", ")}]`);
      }
      break;
    case "statuscode":
      parts.push(`code=${flag.status_code ?? 404}`);
      break;
    case "exception":
      parts.push(`msg="${flag.exception_msg ?? "Error"}"`);
      break;
    case "corruption":
      if (flag.body) {
        const preview = flag.body.length > 40 ? flag.body.slice(0, 40) + "..." : flag.body;
        parts.push(`body="${preview}"`);
      }
      break;
  }

  if (flag.match?.length) {
    parts.push(`match=[${flag.match.length} condition${flag.match.length > 1 ? "s" : ""}]`);
  }

  return parts.join(", ");
}

export function displayStatus(config: FailureFlagsConfig, source: ConfigSource, region: string): void {
  p.log.info(`Region: ${region}`);
  p.log.info(`Source: ${sourceLabel(source)}`);

  const lines: string[] = [];
  let enabledCount = 0;

  for (const mode of FAILURE_MODE_ORDER) {
    const flag = config[mode];
    if (flag?.enabled) {
      enabledCount++;
      lines.push(`  ${mode}: enabled (${modeDetail(mode, flag)})`);
    } else {
      lines.push(`  ${mode}: disabled`);
    }
  }

  p.log.message(lines.join("\n"));
  p.log.info(`${enabledCount} of ${FAILURE_MODE_ORDER.length} modes enabled`);
}

export function displayConfigPreview(config: FailureFlagsConfig): void {
  const json = JSON.stringify(config, null, 2);
  p.note(json, "Configuration preview");
}
