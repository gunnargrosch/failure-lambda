import type { FlagValue } from "../types.js";
import { log, warn } from "../log.js";

export function corruptResponse(flag: FlagValue, result: unknown): unknown {
  if (flag.body !== undefined) {
    log({ mode: "corruption", action: "inject", method: "replace" });
    if (typeof result === "object" && result !== null && "body" in result) {
      return { ...result, body: flag.body };
    }
    warn({ mode: "corruption", message: "response has no body field; wrapping in { body }" });
    return { body: flag.body };
  }

  log({ mode: "corruption", action: "inject", method: "mangle" });
  if (typeof result === "object" && result !== null && "body" in result) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.body === "string") {
      return { ...obj, body: mangleString(obj.body) };
    }
  }

  warn({ mode: "corruption", message: "response has no string body field to mangle; returning unchanged" });
  return result;
}

function mangleString(input: string): string {
  if (input.length === 0) return input;
  const truncatePoint = Math.floor(input.length * (0.3 + Math.random() * 0.5));
  return input.slice(0, truncatePoint) + "\uFFFD".repeat(3);
}
