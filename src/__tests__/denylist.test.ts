import { describe, it, expect, vi, afterEach } from "vitest";
import dns from "node:dns";
import { injectDenylist, clearDenylist, resetDenylist } from "../failures/denylist.js";
import type { FlagValue } from "../types.js";

/** Wrap dns.lookup in a promise for easier testing */
function lookupAsync(hostname: string, options?: dns.LookupOptions | number): Promise<{ address: string; family: number }> {
  return new Promise((resolve, reject) => {
    const cb = (err: NodeJS.ErrnoException | null, address: string, family: number) => {
      if (err) reject(err);
      else resolve({ address, family });
    };
    if (options !== undefined) {
      dns.lookup(hostname, options as dns.LookupOptions, cb);
    } else {
      dns.lookup(hostname, cb);
    }
  });
}

afterEach(() => {
  resetDenylist();
  vi.restoreAllMocks();
});

describe("injectDenylist", () => {
  it("should block matching hostnames with ENOTFOUND", async () => {
    const flag: FlagValue = {
      enabled: true,
      deny_list: ["s3\\..*\\.amazonaws\\.com"],
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist(flag);

    const err = await lookupAsync("s3.us-east-1.amazonaws.com").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe("ENOTFOUND");
    expect(err.hostname).toBe("s3.us-east-1.amazonaws.com");
    expect(err.syscall).toBe("getaddrinfo");
  });

  it("should allow non-matching hostnames through", async () => {
    const flag: FlagValue = {
      enabled: true,
      deny_list: ["blocked\\.example\\.com"],
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist(flag);

    // localhost always resolves — verifies pass-through to original dns.lookup
    const result = await lookupAsync("localhost");
    expect(result.address).toBeDefined();
  });

  it("should handle multiple deny patterns", async () => {
    const flag: FlagValue = {
      enabled: true,
      deny_list: ["s3\\..*", "dynamodb\\..*"],
    };
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist(flag);

    const err1 = await lookupAsync("s3.us-east-1.amazonaws.com").catch((e) => e);
    expect(err1.code).toBe("ENOTFOUND");

    const err2 = await lookupAsync("dynamodb.us-east-1.amazonaws.com").catch((e) => e);
    expect(err2.code).toBe("ENOTFOUND");

    // Non-matching should pass through
    const result = await lookupAsync("localhost");
    expect(result.address).toBeDefined();
  });

  it("should replace patterns on subsequent calls (not accumulate)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["first\\.example\\.com"] });

    const err1 = await lookupAsync("first.example.com").catch((e) => e);
    expect(err1.code).toBe("ENOTFOUND");

    logSpy.mockClear();

    // Second call replaces patterns
    injectDenylist({ enabled: true, deny_list: ["second\\.example\\.com"] });

    // first.example.com should no longer trigger our blocker log
    await lookupAsync("first.example.com").catch(() => {});
    expect(logSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('"hostname":"first.example.com"'),
    );

    // second.example.com should be blocked by our blocker
    const err2 = await lookupAsync("second.example.com").catch((e) => e);
    expect(err2.code).toBe("ENOTFOUND");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"hostname":"second.example.com"'),
    );
  });

  it("should block nothing when deny_list is empty", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: [] });

    const result = await lookupAsync("localhost");
    expect(result.address).toBeDefined();
  });

  it("should block nothing when deny_list is undefined", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true });

    const result = await lookupAsync("localhost");
    expect(result.address).toBeDefined();
  });

  it("should invoke blocked callback asynchronously", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["blocked\\.com"] });

    let callbackCalled = false;
    dns.lookup("blocked.com", () => {
      callbackCalled = true;
    });

    // Callback should NOT have been called synchronously
    expect(callbackCalled).toBe(false);
  });

  it("should work with family number overload", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["blocked\\.com"] });

    const err = await lookupAsync("blocked.com", 4).catch((e) => e);
    expect(err.code).toBe("ENOTFOUND");
  });

  it("should work with options object overload", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["blocked\\.com"] });

    const err = await lookupAsync("blocked.com", { family: 4 }).catch((e) => e);
    expect(err.code).toBe("ENOTFOUND");
  });

  it("should log blocked hostname", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["blocked\\.com"] });
    await lookupAsync("blocked.com").catch(() => {});

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"hostname":"blocked.com"'));
  });

  it("should skip invalid regex patterns and log warning", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["(invalid[", "blocked\\.com"] });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('"invalid regex'),
    );

    // Valid pattern should still work
    const err = await lookupAsync("blocked.com").catch((e) => e);
    expect(err.code).toBe("ENOTFOUND");

    // Non-matching should pass through
    const result = await lookupAsync("localhost");
    expect(result.address).toBeDefined();
  });

  it("should not crash when all patterns are invalid", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["(invalid[", "also(bad"] });

    // Nothing should be blocked
    const result = await lookupAsync("localhost");
    expect(result.address).toBeDefined();
  });

  it("should log injected patterns", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({
      enabled: true,
      deny_list: ["s3\\..*\\.amazonaws\\.com", "dynamodb\\..*"],
    });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"mode":"denylist"'),
    );
  });
});

describe("clearDenylist", () => {
  it("should restore original dns.lookup", async () => {
    const originalRef = dns.lookup;
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["blocked\\.com"] });
    expect(dns.lookup).not.toBe(originalRef);

    clearDenylist();
    expect(dns.lookup).toBe(originalRef);
  });

  it("should be safe to call when not active", () => {
    const originalRef = dns.lookup;

    clearDenylist();

    expect(dns.lookup).toBe(originalRef);
  });
});

describe("resetDenylist", () => {
  it("should fully reset state", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});

    injectDenylist({ enabled: true, deny_list: ["blocked\\.com"] });
    resetDenylist();

    // After reset, injectDenylist should work fresh
    injectDenylist({ enabled: true, deny_list: ["other\\.com"] });

    const err = await lookupAsync("other.com").catch((e) => e);
    expect(err.code).toBe("ENOTFOUND");
    expect(err.hostname).toBe("other.com");

    // blocked.com should not be blocked
    const err2 = await lookupAsync("blocked.com").catch((e) => e);
    expect(err2.hostname).not.toBe("blocked.com");
  });
});
