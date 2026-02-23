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
  isUnsafeRegex,
} from "../config.js";

const ssmMock = mockClient(SSMClient);

const VALID_FLAGS_CONFIG = {
  latency: { enabled: true, percentage: 50, min_latency: 100, max_latency: 400 },
  exception: { enabled: false },
  statuscode: { enabled: false, percentage: 100, status_code: 404 },
  diskspace: { enabled: false, percentage: 100, disk_space: 100 },
  denylist: { enabled: true, percentage: 100, deny_list: ["s3.*.amazonaws.com"] },
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
      percentage: 50,
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

  it("should return error when percentage is below 0", () => {
    const errors = validateFlagValue("latency", { enabled: true, percentage: -1 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.percentage");
  });

  it("should return error when percentage is above 100", () => {
    const errors = validateFlagValue("exception", { enabled: true, percentage: 150 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("exception.percentage");
  });

  it("should return error when percentage is not a number", () => {
    const errors = validateFlagValue("latency", { enabled: true, percentage: "high" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.percentage");
  });

  it("should return error when percentage is a decimal", () => {
    const errors = validateFlagValue("latency", { enabled: true, percentage: 50.5 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.percentage");
  });

  it("should accept percentage of exactly 0", () => {
    const errors = validateFlagValue("latency", { enabled: true, percentage: 0 });
    expect(errors).toHaveLength(0);
  });

  it("should accept percentage of exactly 100", () => {
    const errors = validateFlagValue("latency", { enabled: true, percentage: 100 });
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

  it("should return error for disk_space exceeding 10240 MB", () => {
    const errors = validateFlagValue("diskspace", { enabled: true, disk_space: 10241 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("diskspace.disk_space");
    expect(errors[0].message).toContain("10240");
  });

  it("should accept disk_space at the 10240 MB cap", () => {
    const errors = validateFlagValue("diskspace", { enabled: true, disk_space: 10240 });
    expect(errors).toHaveLength(0);
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

  it("should return error for invalid regex in deny_list", () => {
    const errors = validateFlagValue("denylist", {
      enabled: true,
      deny_list: ["valid\\.pattern", "(invalid["],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("denylist.deny_list[1]");
    expect(errors[0].message).toBe("invalid regular expression");
  });

  it("should accept valid regex patterns in deny_list", () => {
    const errors = validateFlagValue("denylist", {
      enabled: true,
      deny_list: ["s3\\..*\\.amazonaws\\.com", "^dynamodb\\."],
    });
    expect(errors).toHaveLength(0);
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

  it("should return no errors for valid timeout flag", () => {
    const errors = validateFlagValue("timeout", { enabled: true, timeout_buffer_ms: 500 });
    expect(errors).toHaveLength(0);
  });

  it("should return error for negative timeout_buffer_ms", () => {
    const errors = validateFlagValue("timeout", { enabled: true, timeout_buffer_ms: -100 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("timeout.timeout_buffer_ms");
  });

  it("should return error for non-number timeout_buffer_ms", () => {
    const errors = validateFlagValue("timeout", { enabled: true, timeout_buffer_ms: "fast" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("timeout.timeout_buffer_ms");
  });

  it("should accept timeout_buffer_ms of 0", () => {
    const errors = validateFlagValue("timeout", { enabled: true, timeout_buffer_ms: 0 });
    expect(errors).toHaveLength(0);
  });

  it("should return no errors for valid corruption flag with body", () => {
    const errors = validateFlagValue("corruption", { enabled: true, body: '{"error": true}' });
    expect(errors).toHaveLength(0);
  });

  it("should return no errors for corruption flag without body", () => {
    const errors = validateFlagValue("corruption", { enabled: true });
    expect(errors).toHaveLength(0);
  });

  it("should return error for non-string corruption body", () => {
    const errors = validateFlagValue("corruption", { enabled: true, body: 123 });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("corruption.body");
  });

  it("should return no errors for valid match conditions", () => {
    const errors = validateFlagValue("corruption", {
      enabled: true,
      match: [{ path: "requestContext.http.method", value: "GET" }],
    });
    expect(errors).toHaveLength(0);
  });

  it("should return error when match is not an array", () => {
    const errors = validateFlagValue("latency", { enabled: true, match: "not-array" });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match");
  });

  it("should return error for match condition missing path", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ value: "GET" }],
    });
    expect(errors.some((e) => e.field === "latency.match[0].path")).toBe(true);
  });

  it("should return error for match condition missing value with eq operator", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo" }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match[0].value");
  });

  it("should return error for non-object match condition", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: ["not-an-object"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match[0]");
  });

  it("should validate match conditions on any mode", () => {
    const errors = validateFlagValue("exception", {
      enabled: true,
      match: [{ path: "method", value: "GET" }],
    });
    expect(errors).toHaveLength(0);
  });

  it("should accept valid match operators", () => {
    for (const operator of ["eq", "exists", "startsWith", "regex"]) {
      const condition = operator === "exists"
        ? { path: "foo", operator }
        : { path: "foo", operator, value: "bar" };
      const errors = validateFlagValue("latency", {
        enabled: true,
        match: [condition],
      });
      expect(errors).toHaveLength(0);
    }
  });

  it("should return error for unknown match operator", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo", operator: "greaterThan", value: "5" }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match[0].operator");
  });

  it("should not require value for exists operator", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo", operator: "exists" }],
    });
    expect(errors).toHaveLength(0);
  });

  it("should require value for startsWith operator", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo", operator: "startsWith" }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match[0].value");
  });

  it("should return error for invalid regex in match value", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo", operator: "regex", value: "(invalid[" }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match[0].value");
    expect(errors[0].message).toBe("invalid regular expression");
  });

  it("should accept valid regex in match value", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo", operator: "regex", value: "^(GET|POST)$" }],
    });
    expect(errors).toHaveLength(0);
  });

  it("should return error for unsafe regex in deny_list (nested quantifiers)", () => {
    const errors = validateFlagValue("denylist", {
      enabled: true,
      deny_list: ["(a+)+"],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("denylist.deny_list[0]");
    expect(errors[0].message).toContain("unsafe pattern");
  });

  it("should return error for unsafe regex in match value (nested quantifiers)", () => {
    const errors = validateFlagValue("latency", {
      enabled: true,
      match: [{ path: "foo", operator: "regex", value: "(a+)+" }],
    });
    expect(errors).toHaveLength(1);
    expect(errors[0].field).toBe("latency.match[0].value");
    expect(errors[0].message).toContain("unsafe pattern");
  });
});

describe("isUnsafeRegex", () => {
  it("should detect (a+)+", () => {
    expect(isUnsafeRegex("(a+)+")).toBe(true);
  });

  it("should detect (a+)*", () => {
    expect(isUnsafeRegex("(a+)*")).toBe(true);
  });

  it("should detect (a*)+", () => {
    expect(isUnsafeRegex("(a*)+")).toBe(true);
  });

  it("should detect (a*)*", () => {
    expect(isUnsafeRegex("(a*)*")).toBe(true);
  });

  it("should detect (a+){2,}", () => {
    expect(isUnsafeRegex("(a+){2,}")).toBe(true);
  });

  it("should detect nested groups with quantifiers ((a+)b)+", () => {
    expect(isUnsafeRegex("((a+)b)+")).toBe(true);
  });

  it("should allow simple quantifiers without nesting", () => {
    expect(isUnsafeRegex("a+")).toBe(false);
    expect(isUnsafeRegex("(abc)+")).toBe(false);
    expect(isUnsafeRegex("a*b+c?")).toBe(false);
  });

  it("should allow common hostname patterns", () => {
    expect(isUnsafeRegex("s3\\..*\\.amazonaws\\.com")).toBe(false);
    expect(isUnsafeRegex("^dynamodb\\.")).toBe(false);
    expect(isUnsafeRegex("^(GET|POST|PUT|DELETE)$")).toBe(false);
  });

  it("should allow escaped characters inside groups", () => {
    expect(isUnsafeRegex("(\\d+)")).toBe(false);
    expect(isUnsafeRegex("(\\w+\\.)+")).toBe(true);
  });

  it("should ignore quantifiers inside character classes", () => {
    expect(isUnsafeRegex("([a+])+")).toBe(false);
  });

  it("should reject overly long patterns", () => {
    expect(isUnsafeRegex("a".repeat(513))).toBe(true);
  });

  it("should accept patterns at the length limit", () => {
    expect(isUnsafeRegex("a".repeat(512))).toBe(false);
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

  it("should warn when 0.x config format is detected", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = parseFlags({ isEnabled: true, failureMode: "latency", rate: 1, minLatency: 100, maxLatency: 400 });
    expect(Object.keys(config)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("0.x configuration format"));
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
    const config = parseFlags({ latency: { enabled: true, percentage: 100.5 } });
    expect(config.latency?.enabled).toBe(true);
  });

  it("should parse timeout flag", () => {
    const config = parseFlags({ timeout: { enabled: true, timeout_buffer_ms: 200 } });
    expect(config.timeout?.enabled).toBe(true);
    expect(config.timeout?.timeout_buffer_ms).toBe(200);
  });

  it("should parse corruption flag", () => {
    const config = parseFlags({
      corruption: { enabled: true, body: '{"error": true}', match: [{ path: "method", value: "GET" }] },
    });
    expect(config.corruption?.enabled).toBe(true);
    expect(config.corruption?.body).toBe('{"error": true}');
    expect(config.corruption?.match).toHaveLength(1);
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

  it("should default percentage to 100 when omitted", () => {
    const failures = resolveFailures({
      latency: { enabled: true, min_latency: 100, max_latency: 200 },
    });
    expect(failures[0].percentage).toBe(100);
  });

  it("should use provided percentage", () => {
    const failures = resolveFailures({
      latency: { enabled: true, percentage: 30 },
    });
    expect(failures[0].percentage).toBe(30);
  });

  it("should clamp percentage above 100 to 100", () => {
    const failures = resolveFailures({
      latency: { enabled: true, percentage: 150 },
    });
    expect(failures[0].percentage).toBe(100);
  });

  it("should clamp percentage below 0 to 0", () => {
    const failures = resolveFailures({
      latency: { enabled: true, percentage: -10 },
    });
    expect(failures[0].percentage).toBe(0);
  });

  it("should include timeout and corruption in correct order", () => {
    const failures = resolveFailures({
      corruption: { enabled: true },
      timeout: { enabled: true, timeout_buffer_ms: 500 },
      latency: { enabled: true, min_latency: 10, max_latency: 20 },
      exception: { enabled: true },
    });

    const modes = failures.map((f) => f.mode);
    expect(modes).toEqual(["latency", "timeout", "exception", "corruption"]);
  });

  it("should place corruption last in full ordering", () => {
    const failures = resolveFailures({
      exception: { enabled: true },
      latency: { enabled: true },
      timeout: { enabled: true },
      diskspace: { enabled: true },
      denylist: { enabled: true },
      statuscode: { enabled: true },
      corruption: { enabled: true },
    });

    const modes = failures.map((f) => f.mode);
    expect(modes).toEqual(["latency", "timeout", "diskspace", "denylist", "statuscode", "exception", "corruption"]);
  });
});

describe("getConfig with SSM", () => {
  beforeEach(() => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    setSSMClient(new SSMClient({}));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  it("should fetch and parse valid SSM parameter", async () => {
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: {
        Value: JSON.stringify(VALID_FLAGS_CONFIG),
      },
    });

    const config = await getConfig();
    expect(config.latency?.enabled).toBe(true);
    expect(config.latency?.percentage).toBe(50);
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
    vi.spyOn(console, "log").mockImplementation(() => {});
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
    vi.spyOn(console, "log").mockImplementation(() => {});
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
    vi.spyOn(console, "log").mockImplementation(() => {});
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    const mockResponse = {
      ok: true,
      json: vi.fn().mockResolvedValue({
        ...VALID_FLAGS_CONFIG,
        latency: { enabled: true, percentage: 99, min_latency: 100, max_latency: 400 },
      }),
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(mockResponse as unknown as Response);

    const config = await getConfig();
    expect(config.latency?.percentage).toBe(99);
    expect(globalThis.fetch).toHaveBeenCalled();
  });

  it("should auto-disable library cache when using AppConfig", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => VALID_FLAGS_CONFIG,
      } as unknown as Response;
    });

    // No FAILURE_CACHE_TTL set — should default to 0 for AppConfig
    await getConfig();
    await getConfig();

    expect(callCount).toBe(2);
  });

  it("should respect explicit FAILURE_CACHE_TTL even with AppConfig", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FAILURE_CACHE_TTL = "30";
    let callCount = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        json: async () => VALID_FLAGS_CONFIG,
      } as unknown as Response;
    });

    await getConfig();
    await getConfig();

    // Should cache — only 1 fetch
    expect(callCount).toBe(1);
  });

  it("should warn when explicit cache TTL is set with AppConfig", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.FAILURE_CACHE_TTL = "30";
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => VALID_FLAGS_CONFIG,
    } as unknown as Response);

    await getConfig();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("AppConfig extension already caches"),
    );
  });
});

describe("getConfig with no config source", () => {
  it("should return default empty config", async () => {
    const config = await getConfig();
    expect(Object.keys(config)).toHaveLength(0);
  });
});

describe("config source logging", () => {
  it("should log config source on first SSM fetch", async () => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    setSSMClient(new SSMClient({}));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"source":"ssm"'),
    );
  });

  it("should log config source on first AppConfig fetch", async () => {
    process.env.FAILURE_APPCONFIG_CONFIGURATION = "myConfig";
    process.env.FAILURE_APPCONFIG_APPLICATION = "myApp";
    process.env.FAILURE_APPCONFIG_ENVIRONMENT = "myEnv";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => VALID_FLAGS_CONFIG,
    } as unknown as Response);

    await getConfig();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"source":"appconfig"'),
    );
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"action":"config"'),
    );
  });

  it("should log enabled flags on first fetch", async () => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    setSSMClient(new SSMClient({}));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('"enabled_flags"'),
    );
  });

  it("should only log config source once per cold start", async () => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    process.env.FAILURE_CACHE_TTL = "0";
    setSSMClient(new SSMClient({}));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(VALID_FLAGS_CONFIG) },
    });

    await getConfig();
    await getConfig();
    await getConfig();

    const sourceLogCalls = logSpy.mock.calls.filter(
      (call) => typeof call[0] === "string" && call[0].includes('"source":"ssm"'),
    );
    expect(sourceLogCalls).toHaveLength(1);
  });
});

describe("config caching", () => {
  beforeEach(() => {
    process.env.FAILURE_INJECTION_PARAM = "testParam";
    setSSMClient(new SSMClient({}));
    vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("FAILURE_CACHE_TTL"));
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
