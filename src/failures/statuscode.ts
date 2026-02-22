import type { FlagValue } from "../types.js";

export interface StatusCodeResponse {
  statusCode: number;
}

export function injectStatusCode(flag: FlagValue): StatusCodeResponse {
  const statusCode = flag.status_code ?? 500;
  console.log(`[failure-lambda] Injecting status code: ${statusCode}`);
  return { statusCode };
}
