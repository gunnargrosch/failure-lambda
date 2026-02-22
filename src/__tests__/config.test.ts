import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import {
  getConfig,
  clearConfigCache,
  validateFlagValue,
  parseFlags,
  resolveFailures,
  setSSMClient,
} from "../config.js";

const ssmMock = mockClient(SSMClient);

const VALID_FLAGS_CONFIG = {
  latency: { enabled: true, rate: 0.5, min_latency: 100, max_latency: 400 },
  exception: { enabled: false },
  statuscode: { enabled: false, rate: 1, status_code: 404 },
  diskspace: { enabled: false, rate: 1, disk_space: 100 },
  denylist: { enabled: true, rate: 1, deny_list: ["s3.*.amazonaws.com"] },
};

beforeEach(() => {
  ssmMock.reset();
  clearConfigCache();
  delete process.env.FAILURE_INJECTION_PARAM;
  delete process.env.FAILURE_APPCONFIG_CONFIGURATION;
  delete process.env.FAILURE_APPCONFIG_APPLICATION;
  delete process.env.FAILURE_APPCONFIG_ENVIRONMENT;
  delete process.env.AWS_APPCONFIG_EXTENSION_HTTP_PORT;
  delete process.env.FAILURE_CACHE_TTL;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateFlagValue", () => {
  it("should return no errors for a valid enabled latency flag", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      rate: 0.5,
      min_latency: 100,
      max_latency: 400,
    });
    expect(errors).toHaveLength(0);
  });

  it("should return no errors for a minimal disabled flag", () => {
    const errors = validateFlagValue("latency", { enabled: false });
    expect(errors).toHaveLength(0);
  });

  it("should return error when enabled is not a boolean", () => {
    const errors = validateFlagValue("latency", { enabled: "true" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.enabled");
  });

  it("should return error when enabled is missing", () => {
    const errors = validateFlagValue("latency", {});
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.enabled");
  });

  it("should return error when rate is below 0", () => {
    const errors = validateFlagValue("latency", { enabled: true, rate: -0.5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.rate");
  });

  it("should return error when rate is above 1", () => {
    const errors = validateFlagValue("exception", { enabled: true, rate: 1.5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("exception.rate");
  });

  it("should return error when rate is not a number", () => {
    const errors = validateFlagValue("latency", { enabled: true, rate: "high" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.rate");
  });

  it("should accept rate of exactly 0", () => {
    const errors = validateFlagValue("latency", { enabled: true, rate: 0 });
    expect(errors).toHaveLength(0);
  });

  it("should accept rate of exactly 1", () => {
    const errors = validateFlagValue("latency", { enabled: true, rate: 1 });
    expect(errors).toHaveLength(0);
  });

  it("should return error for negative min_latency", () => {
    const errors = validateFlagValue("latency", { enabled: true, min_latency: -10 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.min_latency");
  });

  it("should return error for negative max_latency", () => {
    const errors = validateFlagValue("latency", { enabled: true, max_latency: -10 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.max_latency");
  });

  it("should return error when min_latency > max_latency", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      min_latency: 500,
      max_latency: 100,
    });
    expect(errors.some((e) => e.message.includes("max_latency must be >= min_latency"))).toBe(true);
  });

  it("should return error for status_code outside 100-599", () => {
    const errors = validateFlagValue("statuscode", { enabled: true, status_code: 99 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("statuscode.status_code");
  });

  it("should return error for status_code above 599", () => {
    const errors = validateFlagValue("statuscode", { enabled: true, status_code: 600 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("statuscode.status_code");
  });

  it("should return error for non-positive disk_space", () => {
    const errors = validateFlagValue("diskspace", { enabled: true, disk_space: 0 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("diskspace.disk_space");
  });

  it("should return error when deny_list is not an array", () => {
    const errors = validateFlagValue("denylist", { enabled: true, deny_list: "not-an-array" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("denylist.deny_list");
  });

  it("should return error when deny_list contains non-strings", () => {
    const errors = validateFlagValue("denylist", { enabled: true, deny_list: [123, "valid"] });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("denylist.deny_list");
  });

  it("should return error for non-string exception_msg", () => {
    const errors = validateFlagValue("exception", { enabled: true, exception_msg: 123 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("exception.exception_msg");
  });

  it("should not validate latency fields on non-latency modes", () => {
    const errors = validateFlagValue("exception", { enabled: true, min_latency: -10 });
    expect(errors).toHaveLength(0);
  });
});

describe("parseFlags", () => {
  it("should parse a complete valid config", () => {
    const config = parseFlags(VALID_FLAGS_CONFIG);
    expect(config.latency?.enabled).toBe(true);
    expect(config.latency?.min_latency).toBe(100);
    expect(config.denylist?.enabled).toBe(true);
    expect(config.exception?.enabled).toBe(false);
  });

  it("should return empty config for empty input", () => {
    const config = parseFlags({});
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("should ignore unknown keys", () => {
    const config = parseFlags({ unknownFlag: { enabled: true }, latency: { enabled: true } });
    expect(config.latency?.enabled).toBe(true);
    expect(Object.keys(config)).toHaveLength(1);
  });

  it("should skip non-object flag values", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = parseFlags({ latency: "not an object" });
    expect(Object.keys(config)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
  });

  it("should skip flags with invalid enabled field", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = parseFlags({ latency: { enabled: "yes" } });
    expect(config.latency).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
  });

  it("should include flags with non-critical validation errors", () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = parseFlags({ latency: { enabled: true, rate: 1.5 } });
    expect(config.latency?.enabled).toBe(true);
  });
});

describe("resolveFailures", () => {
  it("should return empty array for empty config", () => {
    const failures = resolveFailures({});
    expect(failures).toHaveLength(0);
  });

  it("should filter out disabled flags", () => {
    const failures = resolveFailures({
      latency: { enabled: false },
      exception: { enabled: true, exception_msg: "boom" },
    });
    expect(failures).toHaveLength(1);
    expect(failures[0].mode).toBe("exception");
  });

  it("should order failures: non-terminating before terminating", () => {
    const failures = resolveFailures({
      exception: { enabled: true },
      latency: { enabled: true, min_latency: 10, max_latency: 20 },
      statuscode: { enabled: true, status_code: 503 },
      denylist: { enabled: true, deny_list: ["example.com"] },
      diskspace: { enabled: true, disk_space: 50 },
    });

    const modes = failures.map((f) => f.mode);
    expect(modes).toEqual(["latency", "diskspace", "denylist", "statuscode", "exception"]);
  });

  it("should default rate to 1 when omitted", () => {
    const failures = resolveFailures({
      latency: { enabled: true, min_latency: 100, max_latency: 200 },
    });
    expect(failures[0].rate).toBe(1);
  });

  it("should use provided rate", () => {
    const failures = resolveFailures({
      latency: { enabled: true, rate: 0.3 },
    });
    expect(failures[0].rate).toBe(0.3);
  });
});

describe("getConfig with SSM", () => {
  beforeEach(() => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    setSSMClient(new SSMClient({}));
  });

  it("should fetch and parse valid SSM parameter", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: JSON.stringify(VALID_FLAGS_CONFIG),
      },
    });

    const config = await getConfig();
    expect(config.latency?.enabled).toBe(true);
    expect(config.latency?.rate).toBe(0.5);
    expect(config.denylist?.enabled).toBe(true);
  });

  it("should return default config when SSM call fails", async () => {
    ssmMock.on(GetParameterCommand).rejects(new Error("SSM error"));

    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("should return default config when parameter value is invalid JSON", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: "not-json",
      },
    });

    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("should return default config when parameter has no value", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {},
    });

    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe("getConfig with AppConfig", () => {
  beforeEach(() => {
    process.env.FAILURE_APPCONFIG_CONFIGURATION = "myConfig";
    process.env.FAILURE_APPCONFIG_APPLICATION = "myApp";
    process.env.FAILURE_APPCONFIG_ENVIRONMENT = "myEnv";
  });

  it("should fetch from AppConfig with default port", async () => {
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue(VALID_FLAGS_CONFIG),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

    const config = await getConfig();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://localhost:2772/applications/myApp/environments/myEnv/configurations/myConfig"
    );
    expect(config.latency?.enabled).toBe(true);
  });

  it("should use custom port from env var", async () => {
    process.env.AWS_APPCONFIG_EXTENSION_HTTP_PORT = "3000";
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue(VALID_FLAGS_CONFIG),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

    await getConfig();
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("localhost:3000")
    );
  });

  it("should return default config when fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network error"));

    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("should return default config when response is not ok", async () => {
    const mockResponse = {
      ok: false,
      status: 500,
      statusText: "Internal Server Error",
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });

  it("should take priority over SSM when both env vars are set", async () => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        ...VALID_FLAGS_CONFIG,
        latency: { enabled: true, rate: 0.99, min_latency: 100, max_latency: 400 },
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

    const config = await getConfig();
    expect(config.latency?.rate).toBe(0.99);
    expect(globalThis.fetch).toHaveBeenCalled();
  });
});

describe("getConfig with no config source", () => {
  it("should return default empty config", async () => {
    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe("config caching", () => {
  beforeEach(() => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    setSSMClient(new SSMClient({}));
  });

  it("should return cached config on second call within TTL", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    const config1 = await getConfig();
    const config2 = await getConfig();

    expect(config1).toEqual(config2);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
  });

  it("should re-fetch after TTL expires", async () => {
    vi.useFakeTimers();

    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();

    vi.advanceTimersByTime(61_000);

    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({}) },
    });

    const config2 = await getConfig();
    expect(Object.keys(config2)).toHaveLength(0);
    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);

    vi.useRealTimers();
  });

  it("should respect FAILURE_CACHE_TTL env var", async () => {
    vi.useFakeTimers();
    process.env.FAILURE_CACHE_TTL = "10";

    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();

    vi.advanceTimersByTime(11_000);

    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify({}) },
    });

    const config2 = await getConfig();
    expect(Object.keys(config2)).toHaveLength(0);

    vi.useRealTimers();
  });

  it("should disable caching when FAILURE_CACHE_TTL is 0", async () => {
    process.env.FAILURE_CACHE_TTL = "0";

    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();
    await getConfig();

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });

  it("should use default TTL for invalid FAILURE_CACHE_TTL", async () => {
    process.env.FAILURE_CACHE_TTL = "not-a-number";
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();
    await getConfig();

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid FAILURE_CACHE_TTL"));
  });

  it("should force re-fetch after clearConfigCache", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();
    clearConfigCache();
    await getConfig();

    expect(ssmMock.commandCalls(GetParameterCommand)).toHaveLength(2);
  });
});
