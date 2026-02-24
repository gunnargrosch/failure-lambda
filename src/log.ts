const SOURCE = "failure-lambda";

export function log(data: Record<string, unknown>): void {
  console.log(JSON.stringify({ source: SOURCE, level: "info", ...data }));
}

export function warn(data: Record<string, unknown>): void {
  console.warn(JSON.stringify({ source: SOURCE, level: "warn", ...data }));
}

export function error(data: Record<string, unknown>): void {
  console.error(JSON.stringify({ source: SOURCE, level: "error", ...data }));
}
