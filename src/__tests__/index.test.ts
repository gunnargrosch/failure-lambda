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

  describe("per-flag rate rolling", () => {
    it("should skip injection when random >= rate", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, rate: 0.5, exception_msg: "Should not throw" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 200 });
      expect(handler).toHaveBeenCalled();
    });

    it("should always inject when rate is 1", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, rate: 1, exception_msg: "Always fail" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Always fail");
    });

    it("should default rate to 1 when omitted", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.99);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          exception: { enabled: true, exception_msg: "Default rate" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Default rate");
    });

    it("should roll rate independently per flag", async () => {
      let callCount = 0;
      vi.spyOn(Math, "random").mockImplementation(() => {
        callCount++;
        // First call (latency, rate 1): return 0 → inject
        // Second call (latency random): return 0.5
        // Third call (exception, rate 0.3): return 0.5 → skip (0.5 >= 0.3)
        return callCount <= 2 ? 0 : 0.5;
      });

      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn().mockResolvedValue({ statusCode: 200 });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, rate: 1, min_latency: 0, max_latency: 0 },
          exception: { enabled: true, rate: 0.3, exception_msg: "Should not throw" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 0ms latency");
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
          latency: { enabled: true, rate: 1, min_latency: 10, max_latency: 10 },
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
          exception: { enabled: true, rate: 1, exception_msg: "Chaos!" },
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
          statuscode: { enabled: true, rate: 1, status_code: 503 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 503 });
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
          latency: { enabled: true, rate: 1, min_latency: 0, max_latency: 0 },
          diskspace: { enabled: true, rate: 1, disk_space: 50 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 0ms latency");
      expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting disk space: 50MB");
      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200 });
    });

    it("should inject non-terminating failures before statuscode short-circuits", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, rate: 1, min_latency: 0, max_latency: 0 },
          statuscode: { enabled: true, rate: 1, status_code: 503 },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      // Latency should have been injected first
      expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 0ms latency");
      // Then statuscode short-circuits
      expect(result).toEqual({ statusCode: 503 });
      expect(handler).not.toHaveBeenCalled();
    });

    it("should inject non-terminating failures before exception short-circuits", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          latency: { enabled: true, rate: 1, min_latency: 0, max_latency: 0 },
          exception: { enabled: true, rate: 1, exception_msg: "Boom" },
        }),
      });

      await expect(wrapped({}, mockContext, mockCallback)).rejects.toThrow("Boom");

      // Latency should have been injected first
      expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 0ms latency");
      expect(handler).not.toHaveBeenCalled();
    });

    it("should execute statuscode before exception when both enabled", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const handler = vi.fn();
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          statuscode: { enabled: true, rate: 1, status_code: 418 },
          exception: { enabled: true, rate: 1, exception_msg: "Should not reach" },
        }),
      });

      // statuscode comes before exception in ordering, so it short-circuits first
      const result = await wrapped({}, mockContext, mockCallback);
      expect(result).toEqual({ statusCode: 418 });
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
        statuscode: { enabled: true, rate: 1, status_code: 418 },
      };
      vi.spyOn(Math, "random").mockReturnValue(0);

      const handler = vi.fn();
      const customProvider = vi.fn().mockResolvedValue(customConfig);
      const wrapped = injectFailure(handler, { configProvider: customProvider });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(customProvider).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 418 });
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
          timeout: { enabled: true, rate: 1, timeout_buffer_ms: 500 },
        }),
      });

      const promise = wrapped({}, mockContext, mockCallback);
      await vi.advanceTimersByTimeAsync(29500);
      const result = await promise;

      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining("[failure-lambda] Injecting timeout"),
      );
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
          corruption: { enabled: true, rate: 1, body: '{"corrupted": true}' },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(handler).toHaveBeenCalled();
      expect(result).toEqual({ statusCode: 200, body: '{"corrupted": true}' });
    });

    it("should not corrupt when rate check fails", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0.9);
      const handler = vi.fn().mockResolvedValue({ statusCode: 200, body: "original" });
      const wrapped = injectFailure(handler, {
        configProvider: createConfigProvider({
          corruption: { enabled: true, rate: 0.5, body: "corrupted" },
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
          latency: { enabled: true, rate: 1, min_latency: 0, max_latency: 0 },
          corruption: { enabled: true, rate: 1, body: "corrupted" },
        }),
      });

      const result = await wrapped({}, mockContext, mockCallback);

      expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 0ms latency");
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
            rate: 1,
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
            rate: 1,
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
          exception: { enabled: true, rate: 1, exception_msg: "No match" },
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
            rate: 1,
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
            rate: 1,
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
});
