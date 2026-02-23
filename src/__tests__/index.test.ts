import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context, Callback } from "aws-lambda";
import injectFailure, { getNestedValue, matchesConditions } from "../index.js";
import type { FailureFlagsConfig } from "../types.js";

const mockContext: Context = {
  callbackWaitsForEmptyEventLoop: true,
  functionName: "test",
  functionVersion: "1",
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789:function:test",
  memoryLimitInMB: "128",
  awsRequestId: "test-id",
  logGroupName: "/aws/lambda/test",
  logStreamName: "stream",
  getRemainingTimeInMillis: () => 30000,
  done: () => {},
  fail: () => {},
  succeed: () => {},
};

const mockCallback: Callback = () => {};

function createConfigProvider(config: FailureFlagsConfig): () => Promise<FailureFlagsConfig> {
  return () => Promise.resolve(config);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FAILURE_LAMBDA_DISABLED;
});

describe("FAILURE_LAMBDA_DISABLED kill switch", () => {
  it("should bypass all injection when FAILURE_LAMBDA_DISABLED=true", async () => {
    process.env.FAILURE_LAMBDA_DISABLED = "true";
    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = injectFailure(handler, {
      configProvider: createConfigProvider({
        exception: { enabled: true, percentage: 100, exception_msg: "Should not throw" },
      }),
    });

    const result = await wrapped({}, mockContext, mockCallback);
    expect(result).toEqual({ statusCode: 200 });
    expect(handler).toHaveBeenCalled();
  });

  it("should not bypass when FAILURE_LAMBDA_DISABLED is not 'true'", async () => {
    process.env.FAILURE_LAMBDA_DISABLED = "false";
    vi.spyOn(Math, "random").mockReturnValue(0);
    const handler = vi.fn();
    const wrapped = injectFailure(handler, {
      configProvider: createConfigProvider({
        exception: { enabled: true, percentage: 100, exception_msg: "Should throw" },
      }),
    });

    await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Should throw");
  });
});

describe("dryRun option", () => {
  it("should log failures without injecting them", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
    const wrapped = injectFailure(handler, {
      dryRun: true,
      configProvider: createConfigProvider({
        exception: { enabled: true, percentage: 100, exception_msg: "Should not throw" },
        latency: { enabled: true, percentage: 50, min_latency: 100, max_latency: 400 },
      }),
    });

    const result = await wrapped({}, mockContext, mockCallback);

    expect(result).toEqual({ statusCode: 200 });
    expect(handler).toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"dryrun"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"latency"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"exception"'));
  });

  it("should log corruption dryrun without modifying response", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: "original" });
    const wrapped = injectFailure(handler, {
      dryRun: true,
      configProvider: createConfigProvider({
        corruption: { enabled: true, percentage: 100, body: "corrupted" },
      }),
    });

    const result = await wrapped({}, mockContext, mockCallback);

    expect(result).toEqual({ statusCode: 200, body: "original" });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"corruption"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"dryrun"'));
  });
});

describe("injectFailure wrapper", () => {
  describe("passthrough behavior", () => {
    it("should call handler normally when all flags are disabled", async () => {
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: false },
          exception: { enabled: false },
        }),
      });

      const result = await wrapped({ test: true }, mockContext, mockCallback);

      expect(handler).toHaveBeenCalledWith({ test: true }, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200 });
    });

    it("should call handler normally when config is empty", async () => {
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({}),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200 });
    });

    it("should pass through handler return value", async () => {
      const expectedResult = { statusCode: 200, body: "hello" };
      const handler = vi.fn().mockResolvedValue(expectedResult);
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({}),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual(expectedResult);
    });
  });

  describe("per-flag percentage rolling", () => {
    it("should skip injection when random roll >= percentage", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, percentage: 50, exception_msg: "Should not throw" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200 });
      expect(handler).toHaveBeenCalled();
    });

    it("should always inject when percentage is 100", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, percentage: 100, exception_msg: "Always fail" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Always fail");
    });

    it("should default percentage to 100 when omitted", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, exception_msg: "Default percentage" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Default percentage");
    });

    it("should roll percentage independently per flag", async () => {
      let callCount = 0;
      vi.spyOn(Math, "random").mockImplementation(() => {
        callCount++;
        // First call (latency, percentage 100): return 0 → inject (0 < 100)
        // Second call (latency random): return 0.5
        // Third call (exception, percentage 30): return 0.5 → skip (50 >= 30)
        return callCount <= 2 ? 0 : 0.5;
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 0, max_latency: 0 },
          exception: { enabled: true, percentage: 30, exception_msg: "Should not throw" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200 });
    });
  });

  describe("single failure mode injection", () => {
    it("should inject latency then call handler", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 10, max_latency: 10 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200 });
    });

    it("should throw exception and not call handler", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, percentage: 100, exception_msg: "Chaos!" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Chaos!");
      expect(handler).not.toHaveBeenCalled();
    });

    it("should return status code and not call handler", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          statuscode: { enabled: true, percentage: 100, status_code: 503 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toMatchObject({ statusCode: 503 });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("multiple simultaneous failures", () => {
    it("should inject latency and diskspace before calling handler", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 0, max_latency: 0 },
          diskspace: { enabled: true, percentage: 100, disk_space: 50 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"disk_space_mb":50'));
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200 });
    });

    it("should inject non-terminating failures before statuscode short-circuits", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 0, max_latency: 0 },
          statuscode: { enabled: true, percentage: 100, status_code: 503 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      // Latency should have been injected first
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
      // Then statuscode short-circuits
      expect(result).toMatchObject({ statusCode: 503 });
      expect(handler).not.toHaveBeenCalled();
    });

    it("should inject non-terminating failures before exception short-circuits", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 0, max_latency: 0 },
          exception: { enabled: true, percentage: 100, exception_msg: "Boom" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Boom");

      // Latency should have been injected first
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
      expect(handler).not.toHaveBeenCalled();
    });

    it("should execute statuscode before exception when both enabled", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          statuscode: { enabled: true, percentage: 100, status_code: 418 },
          exception: { enabled: true, percentage: 100, exception_msg: "Should not reach" },
        }),
      });

      // statuscode comes before exception in ordering, so it short-circuits first
      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toMatchObject({ statusCode: 418 });
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("error handling", () => {
    it("should propagate handler errors", async () => {
      const handler = vi.fn().mockRejectedValue(new Error("Handler failed"));
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({}),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Handler failed");
    });

    it("should propagate config provider errors", async () => {
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const failingProvider = () => Promise.reject(new Error("Config fetch failed"));
      const wrapped = injectFailure(handler, {
        configProvider: failingProvider,
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Config fetch failed");
    });
  });

  describe("custom config provider", () => {
    it("should use the provided configProvider", async () => {
      const customConfig: FailureFlagsConfig = {
        statuscode: { enabled: true, percentage: 100, status_code: 418 },
      };
      vi.spyOn(Math, "random").mockReturnValue(0);

      const handler = vi.fn();
      const customProvider = vi.fn().mockResolvedValue(customConfig);
      const wrapped = injectFailure(handler, { configProvider: customProvider });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(customProvider).toHaveBeenCalled();
      expect(result).toMatchObject({ statusCode: 418 });
    });
  });

  describe("timeout mode", () => {
    it("should inject timeout with context", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          timeout: { enabled: true, percentage: 100, timeout_buffer_ms: 500 },
        }),
      });

      const promise = wrapped({}, mockContext, mockCallback);
      await vi.advanceTimersByTimeAsync(29500);
      const result = await promise;

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('"mode":"timeout"'),
      );
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200 });

      vi.useRealTimers();
    });

    it("should account for time consumed by earlier modes like latency", async () => {
      vi.useFakeTimers();
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      // Date.now() advances with fake timers, so remaining time decreases naturally
      const startTime = Date.now();
      const contextWithDecreasingTime = {
        ...mockContext,
        getRemainingTimeInMillis: () => 30000 - (Date.now() - startTime),
      };

      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 1000, max_latency: 1000 },
          timeout: { enabled: true, percentage: 100, timeout_buffer_ms: 500 },
        }),
      });

      const promise = wrapped({}, contextWithDecreasingTime, mockCallback);

      // Advance past latency (1000ms), then timeout reads remaining as 29000
      // and sleeps for 29000 - 500 = 28500ms. Total: 1000 + 28500 = 29500ms.
      await vi.advanceTimersByTimeAsync(29500);
      const result = await promise;

      // Verify both modes were injected
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"latency"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"timeout"'));
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sleep_ms":28500'));
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200 });

      vi.useRealTimers();
    });
  });

  describe("corruption mode (post-handler)", () => {
    it("should corrupt response after handler returns", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: "original" });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          corruption: { enabled: true, percentage: 100, body: '{"corrupted": true}' },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200, body: '{"corrupted": true}' });
    });

    it("should not corrupt when percentage check fails", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: "original" });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          corruption: { enabled: true, percentage: 50, body: "corrupted" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200, body: "original" });
    });
  });

  describe("mixed pre/post-handler failures", () => {
    it("should apply latency before handler and corruption after", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: "original" });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 0, max_latency: 0 },
          corruption: { enabled: true, percentage: 100, body: "corrupted" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200, body: "corrupted" });
    });
  });

  describe("event matching", () => {
    it("should inject when match conditions are satisfied", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: {
            enabled: true,
            percentage: 100,
            exception_msg: "Matched!",
            match: [{ path: "requestContext.http.method", value: "GET" }],
          },
        }),
      });

      const event = { requestContext: { http: { method: "GET" } } };
      await expect(wrapped(event, mockContext, mockCallback)).rejects.toThrow("Matched!");
    });

    it("should skip injection when match conditions fail", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: {
            enabled: true,
            percentage: 100,
            exception_msg: "Should not throw",
            match: [{ path: "requestContext.http.method", value: "GET" }],
          },
        }),
      });

      const event = { requestContext: { http: { method: "POST" } } };
      const result = await wrapped(event, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200 });
      expect(handler).toHaveBeenCalled();
    });

    it("should inject when no match conditions are set", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, percentage: 100, exception_msg: "No match" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("No match");
    });

    it("should apply event matching to corruption mode", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: "ok" });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          corruption: {
            enabled: true,
            percentage: 100,
            body: "corrupted",
            match: [{ path: "type", value: "api" }],
          },
        }),
      });

      // Match succeeds
      const result1 = await wrapped({ type: "api" }, mockContext, mockCallback);
      expect(result1).toEqual({ statusCode: 200, body: "corrupted" });

      // Match fails
      handler.mockResolvedValue({ statusCode: 200, body: "ok" });
      const result2 = await wrapped({ type: "sqs" }, mockContext, mockCallback);
      expect(result2).toEqual({ statusCode: 200, body: "ok" });
    });

    it("should require all match conditions to pass", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: {
            enabled: true,
            percentage: 100,
            exception_msg: "multi-match",
            match: [
              { path: "source", value: "api" },
              { path: "method", value: "GET" },
            ],
          },
        }),
      });

      // Only one condition matches — should not inject
      const result = await wrapped({ source: "api", method: "POST" }, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200 });
    });
  });
});

describe("getNestedValue", () => {
  it("should resolve a dot-separated path", () => {
    const obj = { a: { b: { c: "deep" } } };
    expect(getNestedValue(obj, "a.b.c")).toBe("deep");
  });

  it("should return undefined for missing paths", () => {
    expect(getNestedValue({ a: 1 }, "a.b.c")).toBeUndefined();
  });

  it("should return undefined for null/undefined input", () => {
    expect(getNestedValue(null, "a")).toBeUndefined();
    expect(getNestedValue(undefined, "a")).toBeUndefined();
  });

  it("should handle top-level properties", () => {
    expect(getNestedValue({ foo: "bar" }, "foo")).toBe("bar");
  });
});

describe("matchesConditions", () => {
  it("should return true when all conditions match", () => {
    const event = { method: "GET", source: "api" };
    expect(matchesConditions(event, [
      { path: "method", value: "GET" },
      { path: "source", value: "api" },
    ])).toBe(true);
  });

  it("should return false when any condition fails", () => {
    const event = { method: "POST", source: "api" };
    expect(matchesConditions(event, [
      { path: "method", value: "GET" },
      { path: "source", value: "api" },
    ])).toBe(false);
  });

  it("should return true for empty conditions array", () => {
    expect(matchesConditions({}, [])).toBe(true);
  });

  it("should coerce non-string values to strings for comparison", () => {
    expect(matchesConditions({ count: 42 }, [{ path: "count", value: "42" }])).toBe(true);
  });

  it("should not match null actual value against 'null' string", () => {
    expect(matchesConditions({ foo: null }, [{ path: "foo", value: "null" }])).toBe(false);
  });

  it("should not match undefined (missing path) against 'undefined' string", () => {
    expect(matchesConditions({}, [{ path: "missing", value: "undefined" }])).toBe(false);
  });

  it("should not match when path resolves to undefined", () => {
    expect(matchesConditions({ a: { b: 1 } }, [{ path: "a.c", value: "1" }])).toBe(false);
  });

  it("should support 'exists' operator", () => {
    expect(matchesConditions({ a: "hello" }, [{ path: "a", operator: "exists" }])).toBe(true);
    expect(matchesConditions({ a: 0 }, [{ path: "a", operator: "exists" }])).toBe(true);
    expect(matchesConditions({ a: "" }, [{ path: "a", operator: "exists" }])).toBe(true);
    expect(matchesConditions({}, [{ path: "a", operator: "exists" }])).toBe(false);
    expect(matchesConditions({ a: null }, [{ path: "a", operator: "exists" }])).toBe(false);
    expect(matchesConditions({ a: undefined }, [{ path: "a", operator: "exists" }])).toBe(false);
  });

  it("should support 'startsWith' operator", () => {
    expect(matchesConditions({ path: "/api/users" }, [
      { path: "path", operator: "startsWith", value: "/api" },
    ])).toBe(true);
    expect(matchesConditions({ path: "/web/users" }, [
      { path: "path", operator: "startsWith", value: "/api" },
    ])).toBe(false);
    expect(matchesConditions({}, [
      { path: "path", operator: "startsWith", value: "/api" },
    ])).toBe(false);
  });

  it("should support 'regex' operator", () => {
    expect(matchesConditions({ method: "GET" }, [
      { path: "method", operator: "regex", value: "^(GET|HEAD)$" },
    ])).toBe(true);
    expect(matchesConditions({ method: "POST" }, [
      { path: "method", operator: "regex", value: "^(GET|HEAD)$" },
    ])).toBe(false);
    expect(matchesConditions({}, [
      { path: "method", operator: "regex", value: "^GET$" },
    ])).toBe(false);
  });

  it("should default to 'eq' when operator is omitted", () => {
    expect(matchesConditions({ a: "hello" }, [{ path: "a", value: "hello" }])).toBe(true);
    expect(matchesConditions({ a: "hello" }, [{ path: "a", operator: "eq", value: "hello" }])).toBe(true);
  });
});
