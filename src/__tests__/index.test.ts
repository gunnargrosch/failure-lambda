import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context, Callback } from "aws-lambda";
import injectFailure from "../index.js";
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
});
