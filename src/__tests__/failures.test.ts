import { describe, it, expect, vi, afterEach } from "vitest";
import { injectLatency } from "../failures/latency.js";
import { injectException } from "../failures/exception.js";
import { injectStatusCode } from "../failures/statuscode.js";
import type { FlagValue } from "../types.js";

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

    expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 300ms latency");
  }, 1000);

  it("should default to 0 when min/max are undefined", async () => {
    const flag: FlagValue = { enabled: true };
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    await injectLatency(flag);

    expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting 0ms latency");
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
    expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting exception: Test");
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
    expect(logSpy).toHaveBeenCalledWith("[failure-lambda] Injecting status code: 429");
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
      "count=1000",
      "bs=200000",
    ]);
  });

  it("should default to 100MB when disk_space is undefined", async () => {
    const { spawnSync } = await import("node:child_process");
    const spawnMock = vi.mocked(spawnSync);
    spawnMock.mockClear();

    const { injectDiskSpace } = await import("../failures/diskspace.js");

    const flag: FlagValue = { enabled: true };

    injectDiskSpace(flag);

    expect(spawnMock).toHaveBeenCalledWith("dd", expect.arrayContaining(["bs=100000"]));
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

    expect(errorSpy).toHaveBeenCalledWith(
      "[failure-lambda] Failed to inject disk space:",
      spawnError
    );
  });
});
