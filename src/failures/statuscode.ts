import type { FlagValue } from "../types.js";
import { log } from "../log.js";

export interface StatusCodeResponse {
  statusCode: number;
}

export function injectStatusCode(flag: FlagValue): StatusCodeResponse {
  const statusCode = flag.status_code ?? 500;
  log({ mode: "statuscode", action: "inject", status_code: statusCode });
  return { statusCode };
}
