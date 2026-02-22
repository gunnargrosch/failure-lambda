import Mitm from "mitm";
import type { FlagValue } from "../types.js";

/** Module-level mitm instance persists across invocations within a Lambda container */
let mitmInstance: Mitm.MitmInstance | null = null;

export function clearMitm(): void {
  if (mitmInstance !== null) {
    mitmInstance.disable();
  }
}

export function injectDenylist(flag: FlagValue): void {
  const denylistPatterns = flag.deny_list ?? [];
  console.log(
    `[failure-lambda] Injecting denylist for: ${denylistPatterns.join(", ")}`
  );

  if (mitmInstance === null) {
    mitmInstance = Mitm();
  }
  mitmInstance.enable();

  const compiledPatterns = denylistPatterns.map(
    (pattern) => new RegExp(pattern)
  );

  mitmInstance.on("connect", (socket: Mitm.MitmSocket, opts: Mitm.MitmConnectOpts) => {
    const host = opts.host ?? "";
    const shouldBlock = compiledPatterns.some((regex) => regex.test(host));

    if (shouldBlock) {
      console.log(`[failure-lambda] Blocked connection to ${host}`);
      socket.end();
    } else {
      socket.bypass();
    }
  });

  // Remove previously attached handlers, keeping only the most recent
  const connectEvents = mitmInstance._events?.connect;
  if (Array.isArray(connectEvents)) {
    while (Array.isArray(mitmInstance._events?.connect)) {
      mitmInstance.removeListener("connect", mitmInstance._events.connect[0]);
    }
  }
}

/** Reset mitm state entirely. For testing. @internal */
export function resetMitm(): void {
  if (mitmInstance !== null) {
    mitmInstance.disable();
    mitmInstance = null;
  }
}
