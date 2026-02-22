import type { FlagValue } from "../types.js";

export function injectException(flag: FlagValue): never {
  const message = flag.exception_msg ?? "Injected exception";
  console.log(`[failure-lambda] Injecting exception: ${message}`);
  throw new Error(message);
}
