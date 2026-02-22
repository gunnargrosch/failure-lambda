import type { MatchCondition } from "./types.js";

/** Resolve a dot-separated path against a nested object */
export function getNestedValue(obj: unknown, path: string): unknown {
  let current = obj;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Check whether all match conditions are satisfied by the event */
export function matchesConditions(event: unknown, conditions: MatchCondition[]): boolean {
  return conditions.every(({ path, value }) => {
    const actual = getNestedValue(event, path);
    if (actual === null || actual === undefined) return false;
    return String(actual) === value;
  });
}
