import type { FlagValue } from "../types.js";
import { log } from "../log.js";

export function injectException(flag: FlagValue): never {
  const message = flag.exception_msg ?? "Injected exception";
  log({ mode: "exception", action: "inject", exception_msg: message });
  throw new Error(message);
}
