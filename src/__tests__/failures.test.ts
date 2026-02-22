import { describe, it, expect, vi, afterEach } from "vitest";
import { injectLatency } from "../failures/latency.js";
import { injectException } from "../failures/exception.js";
import { injectStatusCode } from "../failures/statuscode.js";
import { injectTimeout } from "../failures/timeout.js";
import { corruptResponse } from "../failures/corruption.js";
import type { FlagValue } from "../types.js";
import type { Context } from "aws-lambda";

vi.mock("node:child_process", () => ({
  spawnSync: vi.fn(() => ({
    pid: 0,
    output: [],
    stdout: Buffer.from(""),
    stderr: Buffer.from(""),
    status: 0,
    signal: null,
  })),
}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("injectLatency", () => {
  it("should delay execution for the configured duration", async () => {
    const flag: FlagValue = {
      enabled: true,
      min_latency: 10,
      max_latency: 10,
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const start = Date.now();
    await injectLatency(flag);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(5);
  });

  it("should use random value between min and max", async () => {
    const flag: FlagValue = {
      enabled: true,
      min_latency: 100,
      max_latency: 500,
    };

    vi.spyOn(Math, "random").mockReturnValue(0.5);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await injectLatency(flag);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":300'));
  }, 1000);

  it("should default to 0 when min/max are undefined", async () => {
    const flag: FlagValue = { enabled: true };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await injectLatency(flag);

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"latency_ms":0'));
  });
});

describe("injectException", () => {
  it("should throw Error with configured message", () => {
    const flag: FlagValue = {
      enabled: true,
      exception_msg: "Custom error message",
    };

    expect(() => injectException(flag)).toThrow("Custom error message");
  });

  it("should use default message when exception_msg is undefined", () => {
    const flag: FlagValue = { enabled: true };

    expect(() => injectException(flag)).toThrow("Injected exception");
  });

  it("should log before throwing", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const flag: FlagValue = {
      enabled: true,
      exception_msg: "Test",
    };

    expect(() => injectException(flag)).toThrow();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"exception"'));
  });
});

describe("injectStatusCode", () => {
  it("should return configured status code", () => {
    const flag: FlagValue = {
      enabled: true,
      status_code: 503,
    };

    const result = injectStatusCode(flag);
    expect(result).toEqual({ statusCode: 503 });
  });

  it("should default to 500 when status_code is undefined", () => {
    const flag: FlagValue = { enabled: true };

    const result = injectStatusCode(flag);
    expect(result).toEqual({ statusCode: 500 });
  });

  it("should log the injected status code", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const flag: FlagValue = {
      enabled: true,
      status_code: 429,
    };

    injectStatusCode(flag);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"status_code":429'));
  });
});

describe("injectDiskSpace", () => {
  it("should call spawnSync with correct dd arguments", async () => {
    const { spawnSync } = await import("node:child_process");
    const spawnMock = vi.mocked(spawnSync);
    spawnMock.mockClear();

    const { injectDiskSpace } = await import("../failures/diskspace.js");

    const flag: FlagValue = {
      enabled: true,
      disk_space: 200,
    };

    injectDiskSpace(flag);

    expect(spawnMock).toHaveBeenCalledWith("dd", [
      "if=/dev/zero",
      expect.stringMatching(/^of=\/tmp\/diskspace-failure-\d+\.tmp$/),
      "count=1024",
      "bs=204800",
    ]);
  });

  it("should default to 100MB when disk_space is undefined", async () => {
    const { spawnSync } = await import("node:child_process");
    const spawnMock = vi.mocked(spawnSync);
    spawnMock.mockClear();

    const { injectDiskSpace } = await import("../failures/diskspace.js");

    const flag: FlagValue = { enabled: true };

    injectDiskSpace(flag);

    expect(spawnMock).toHaveBeenCalledWith("dd", expect.arrayContaining(["bs=102400"]));
  });

  it("should log error when spawnSync fails", async () => {
    const { spawnSync } = await import("node:child_process");
    const spawnMock = vi.mocked(spawnSync);
    const spawnError = new Error("spawn failed");
    spawnMock.mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from(""),
      status: null,
      signal: null,
      error: spawnError,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { injectDiskSpace } = await import("../failures/diskspace.js");
    const flag: FlagValue = {
      enabled: true,
      disk_space: 50,
    };

    injectDiskSpace(flag);

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"mode":"diskspace"'));
  });

  it("should log error when dd exits with non-zero status", async () => {
    const { spawnSync } = await import("node:child_process");
    const spawnMock = vi.mocked(spawnSync);
    spawnMock.mockReturnValueOnce({
      pid: 0,
      output: [],
      stdout: Buffer.from(""),
      stderr: Buffer.from("No space left on device"),
      status: 1,
      signal: null,
    });

    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { injectDiskSpace } = await import("../failures/diskspace.js");
    injectDiskSpace({ enabled: true, disk_space: 50 });

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('"dd exited with status 1"'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No space left on device"));
  });
});

describe("injectTimeout", () => {
  it("should sleep for remaining minus buffer", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockContext = {
      getRemainingTimeInMillis: () => 5000,
    } as Context;

    const flag: FlagValue = { enabled: true, timeout_buffer_ms: 500 };

    const promise = injectTimeout(flag, mockContext);
    vi.advanceTimersByTime(4500);
    await promise;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sleep_ms":4500'));

    vi.useRealTimers();
  });

  it("should default buffer to 0 when timeout_buffer_ms is undefined", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockContext = {
      getRemainingTimeInMillis: () => 3000,
    } as Context;

    const flag: FlagValue = { enabled: true };

    const promise = injectTimeout(flag, mockContext);
    vi.advanceTimersByTime(3000);
    await promise;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sleep_ms":3000'));

    vi.useRealTimers();
  });

  it("should clamp to 0 when buffer exceeds remaining time", async () => {
    vi.useFakeTimers();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const mockContext = {
      getRemainingTimeInMillis: () => 100,
    } as Context;

    const flag: FlagValue = { enabled: true, timeout_buffer_ms: 500 };

    const promise = injectTimeout(flag, mockContext);
    await vi.advanceTimersByTimeAsync(0);
    await promise;

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"sleep_ms":0'));

    vi.useRealTimers();
  });
});

describe("corruptResponse", () => {
  it("should replace body with configured string when result has body", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const flag: FlagValue = { enabled: true, body: '{"error": "corrupted"}' };

    const result = corruptResponse(flag, { statusCode: 200, body: "original" });

    expect(result).toEqual({ statusCode: 200, body: '{"error": "corrupted"}' });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"method":"replace"'));
  });

  it("should wrap in { body } when result has no body field", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flag: FlagValue = { enabled: true, body: '{"error": "corrupted"}' };

    const result = corruptResponse(flag, "raw string");

    expect(result).toEqual({ body: '{"error": "corrupted"}' });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"response has no body field'));
  });

  it("should mangle body when no replacement body is configured", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(Math, "random").mockReturnValue(0.5);

    const flag: FlagValue = { enabled: true };
    const original = "This is a long response body that will be mangled";

    const result = corruptResponse(flag, { statusCode: 200, body: original }) as Record<string, unknown>;

    expect(result.statusCode).toBe(200);
    expect(typeof result.body).toBe("string");
    expect((result.body as string).length).toBeLessThan(original.length + 10);
    expect((result.body as string)).toContain("\uFFFD");
  });

  it("should return result as-is when mangling and result has no body, with warning", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flag: FlagValue = { enabled: true };

    const original = { statusCode: 200, data: "no body field" };
    const result = corruptResponse(flag, original);

    expect(result).toEqual(original);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"response has no string body field to mangle'));
  });

  it("should handle empty body string in mangle mode", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const flag: FlagValue = { enabled: true };

    const result = corruptResponse(flag, { statusCode: 200, body: "" }) as Record<string, unknown>;

    expect(result.body).toBe("");
  });

  it("should wrap in { body } for null result in replace mode", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const flag: FlagValue = { enabled: true, body: "replaced" };

    const result = corruptResponse(flag, null);

    expect(result).toEqual({ body: "replaced" });
  });

  it("should warn and return unchanged for primitive result in mangle mode", () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const flag: FlagValue = { enabled: true };

    const result = corruptResponse(flag, 42);

    expect(result).toBe(42);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"response has no string body field to mangle'));
  });
});
