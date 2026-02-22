import dns from "node:dns";
import type { FlagValue } from "../types.js";

/** Capture the original dns.lookup once at module load (once per Lambda cold start) */
const originalLookup = dns.lookup;

/** Whether our wrapper is currently installed on dns.lookup */
let isActive = false;

/** Current compiled regex patterns (replaced on each injectDenylist call) */
let activePatterns: RegExp[] = [];

/** Restore dns.lookup and clear denylist patterns */
export function clearDenylist(): void {
  if (isActive) {
    dns.lookup = originalLookup;
    isActive = false;
    activePatterns = [];
  }
}

export function injectDenylist(flag: FlagValue): void {
  const denylistPatterns = flag.deny_list ?? [];
  console.log(
    `[failure-lambda] Injecting denylist for: ${denylistPatterns.join(", ")}`,
  );

  activePatterns = denylistPatterns.map((pattern) => new RegExp(pattern));

  if (!isActive) {
    dns.lookup = function blockedLookup(
      hostname: string,
      ...args: unknown[]
    ): void {
      const callback = args[args.length - 1] as (
        err: NodeJS.ErrnoException | null,
        address?: string,
        family?: number,
      ) => void;
      const rest = args.slice(0, -1);

      if (activePatterns.some((regex) => regex.test(hostname))) {
        console.log(`[failure-lambda] Blocked connection to ${hostname}`);
        const err = new Error(
          `getaddrinfo ENOTFOUND ${hostname}`,
        ) as NodeJS.ErrnoException & { hostname?: string };
        err.code = "ENOTFOUND";
        err.hostname = hostname;
        err.syscall = "getaddrinfo";
        process.nextTick(() => callback(err));
        return;
      }

      (originalLookup as Function).call(dns, hostname, ...rest, callback);
    } as typeof dns.lookup;

    isActive = true;
  }
}

/** Reset denylist state entirely. For testing. @internal */
export function resetDenylist(): void {
  dns.lookup = originalLookup;
  isActive = false;
  activePatterns = [];
}
