import type { MatchCondition, MatchOperator } from "./types.js";

/** Cache compiled regexes to avoid recompiling on every invocation */
const regexCache = new Map<string, RegExp>();

function getCachedRegex(pattern: string): RegExp {
  let cached = regexCache.get(pattern);
  if (cached === undefined) {
    cached = new RegExp(pattern);
    regexCache.set(pattern, cached);
  }
  return cached;
}

/** Resolve a dot-separated path against a nested object */
export function getNestedValue(obj: unknown, path: string): unknown {
  let current = obj;
  for (const part of path.split(".")) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Evaluate a single match operator against an actual value */
function matchOperator(actual: unknown, operator: MatchOperator, value?: string): boolean {
  switch (operator) {
    case "exists":
      return actual !== null && actual !== undefined;
    case "startsWith":
      if (actual === null || actual === undefined) return false;
      return String(actual).startsWith(value ?? "");
    case "regex":
      if (actual === null || actual === undefined) return false;
      return getCachedRegex(value ?? "").test(String(actual));
    case "eq":
    default:
      if (actual === null || actual === undefined) return false;
      return String(actual) === value;
  }
}

/** Check whether all match conditions are satisfied by the event */
export function matchesConditions(event: unknown, conditions: MatchCondition[]): boolean {
  return conditions.every((condition) => {
    const actual = getNestedValue(event, condition.path);
    const operator = condition.operator ?? "eq";
    return matchOperator(actual, operator, condition.value);
  });
}
