import { describe, it, expect, vi, afterEach } from "vitest";
import type { Context } from "aws-lambda";
import { failureLambdaMiddleware } from "../middy.js";
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

function createConfigProvider(config: FailureFlagsConfig): () => Promise<FailureFlagsConfig> {
  return () => Promise.resolve(config);
}

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.FAILURE_LAMBDA_DISABLED;
});

describe("FAILURE_LAMBDA_DISABLED kill switch (middy)", () => {
  it("should bypass all injection when FAILURE_LAMBDA_DISABLED=true", async () => {
    process.env.FAILURE_LAMBDA_DISABLED = "true";

    const middleware = failureLambdaMiddleware({
      configProvider: createConfigProvider({
        exception: { enabled: true, percentage: 100, exception_msg: "Should not throw" },
      }),
    });

    const request = {
      event: {},
      context: mockContext,
      response: { statusCode: 200, body: "original" },
      internal: {},
    } as { event: unknown; context: Context; response?: unknown; internal?: Record<string, unknown> };

    await middleware.before(request);
    expect(request.response).toEqual({ statusCode: 200, body: "original" });
  });
});

describe("dryRun option (middy)", () => {
  it("should log failures without injecting them", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const middleware = failureLambdaMiddleware({
      dryRun: true,
      configProvider: createConfigProvider({
        exception: { enabled: true, percentage: 100, exception_msg: "Should not throw" },
      }),
    });

    const request = { event: {}, context: mockContext, internal: {} };
    await middleware.before(request);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"action":"dryrun"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"exception"'));
  });
});

describe("failureLambdaMiddleware", () => {
  describe("before phase", () => {
    it("should inject pre-handler failures", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          latency: { enabled: true, percentage: 100, min_latency: 0, max_latency: 0 },
        }),
      });

      const request = { event: {}, context: mockContext, internal: {} };
      await middleware.before(request);

      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
    });

    it("should short-circuit on statuscode by setting response", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          statuscode: { enabled: true, percentage: 100, status_code: 503 },
        }),
      });

      const request = { event: {}, context: mockContext, internal: {} } as {
        event: unknown;
        context: Context;
        response?: unknown;
        internal?: Record<string, unknown>;
      };

      const returnValue = await middleware.before(request);

      expect(request.response).toMatchObject({ statusCode: 503 });
      expect(returnValue).toMatchObject({ statusCode: 503 });
    });

    it("should throw on exception mode", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          exception: { enabled: true, percentage: 100, exception_msg: "Middy boom" },
        }),
      });

      const request = { event: {}, context: mockContext, internal: {} };
      await expect(middleware.before(request)).rejects.toThrow("Middy boom");
    });

    it("should skip corruption in before phase", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          corruption: { enabled: true, percentage: 100, body: "bad" },
        }),
      });

      const request = { event: {}, context: mockContext, internal: {} } as {
        event: unknown;
        context: Context;
        response?: unknown;
        internal?: Record<string, unknown>;
      };

      await middleware.before(request);
      expect(request.response).toBeUndefined();
    });

    it("should pass through when all flags are disabled", async () => {
      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          latency: { enabled: false },
          exception: { enabled: false },
        }),
      });

      const request = { event: {}, context: mockContext, internal: {} } as {
        event: unknown;
        context: Context;
        response?: unknown;
        internal?: Record<string, unknown>;
      };

      await middleware.before(request);
      expect(request.response).toBeUndefined();
    });
  });

  describe("after phase", () => {
    it("should apply corruption to response", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          corruption: { enabled: true, percentage: 100, body: '{"corrupted": true}' },
        }),
      });

      const request = {
        event: {},
        context: mockContext,
        response: { statusCode: 200, body: "original" },
        internal: {},
      } as {
        event: unknown;
        context: Context;
        response?: unknown;
        internal?: Record<string, unknown>;
      };

      // before stores failures in internal
      await middleware.before(request);
      // after applies corruption
      await middleware.after(request);

      expect(request.response).toEqual({ statusCode: 200, body: '{"corrupted": true}' });
    });

    it("should not corrupt when no failures stored", async () => {
      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({}),
      });

      const request = {
        event: {},
        context: mockContext,
        response: { statusCode: 200, body: "original" },
        internal: {},
      } as {
        event: unknown;
        context: Context;
        response?: unknown;
        internal?: Record<string, unknown>;
      };

      await middleware.before(request);
      await middleware.after(request);

      expect(request.response).toEqual({ statusCode: 200, body: "original" });
    });
  });

  describe("onError hook", () => {
    it("should log error and clear denylist/diskspace on error", async () => {
      const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({}),
      });

      const request = {
        event: {},
        context: mockContext,
        error: new Error("handler failed"),
        internal: {},
      } as {
        event: unknown;
        context: Context;
        response?: unknown;
        error?: Error;
        internal?: Record<string, unknown>;
      };

      await middleware.onError(request);

      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"action":"error"'),
      );
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('"message":"handler failed"'),
      );
    });

    it("should handle missing error gracefully", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({}),
      });

      const request = {
        event: {},
        context: mockContext,
        internal: {},
      } as {
        event: unknown;
        context: Context;
        response?: unknown;
        error?: Error;
        internal?: Record<string, unknown>;
      };

      // Should not throw even with no error on request
      await expect(middleware.onError(request)).resolves.toBeUndefined();
    });
  });

  describe("event matching", () => {
    it("should respect match conditions in before phase", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
        configProvider: createConfigProvider({
          exception: {
            enabled: true,
            percentage: 100,
            exception_msg: "Matched!",
            match: [{ path: "httpMethod", value: "GET" }],
          },
        }),
      });

      // Match succeeds
      const request1 = { event: { httpMethod: "GET" }, context: mockContext, internal: {} };
      await expect(middleware.before(request1)).rejects.toThrow("Matched!");

      // Match fails
      const request2 = { event: { httpMethod: "POST" }, context: mockContext, internal: {} };
      await middleware.before(request2); // Should not throw
    });

    it("should respect match conditions in after phase", async () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      vi.spyOn(console, "log").mockImplementation(() => {});

      const middleware = failureLambdaMiddleware({
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
      const request1 = {
        event: { type: "api" },
        context: mockContext,
        response: { statusCode: 200, body: "ok" },
        internal: {},
      } as { event: unknown; context: Context; response?: unknown; internal?: Record<string, unknown> };

      await middleware.before(request1);
      await middleware.after(request1);
      expect(request1.response).toEqual({ statusCode: 200, body: "corrupted" });

      // Match fails
      const request2 = {
        event: { type: "sqs" },
        context: mockContext,
        response: { statusCode: 200, body: "ok" },
        internal: {},
      } as { event: unknown; context: Context; response?: unknown; internal?: Record<string, unknown> };

      await middleware.before(request2);
      await middleware.after(request2);
      expect(request2.response).toEqual({ statusCode: 200, body: "ok" });
    });
  });
});
