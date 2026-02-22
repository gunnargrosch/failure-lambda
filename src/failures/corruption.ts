import type { FlagValue } from "../types.js";

export function corruptResponse(flag: FlagValue, result: unknown): unknown {
  if (flag.body !== undefined) {
    console.log("[failure-lambda] Injecting response corruption: replacing body");
    if (typeof result === "object" && result !== null && "body" in result) {
      return { ...result, body: flag.body };
    }
    return flag.body;
  }

  console.log("[failure-lambda] Injecting response corruption: mangling body");
  if (typeof result === "object" && result !== null && "body" in result) {
    const obj = result as Record<string, unknown>;
    if (typeof obj.body === "string") {
      return { ...obj, body: mangleString(obj.body) };
    }
  }

  return result;
}

function mangleString(input: string): string {
  if (input.length === 0) return input;
  const truncatePoint = Math.floor(input.length * (0.3 + Math.random() * 0.5));
  return input.slice(0, truncatePoint) + "\uFFFD".repeat(3);
}
