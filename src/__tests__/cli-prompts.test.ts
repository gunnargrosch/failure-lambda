import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { FailureFlagsConfig } from "../types.js";

vi.mock("@clack/prompts", () => ({
  select: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
}));

import * as p from "@clack/prompts";
import { promptCommand, promptProfile, promptSaveProfile, promptEnableMode, promptDisableMode, promptConfigSource, promptRegion } from "../cli/prompts.js";
import type { Settings } from "../cli/settings.js";

const mockSelect = vi.mocked(p.select);
const mockText = vi.mocked(p.text);
const mockConfirm = vi.mocked(p.confirm);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("promptCommand", () => {
  it("should prompt for command", async () => {
    mockSelect.mockResolvedValueOnce("enable");

    const command = await promptCommand();
    expect(command).toBe("enable");
  });
});

describe("promptProfile", () => {
  it("should return null when no profiles exist", async () => {
    const settings: Settings = { profiles: {} };
    const result = await promptProfile(settings);
    expect(result).toBeNull();
  });

  it("should return selected profile", async () => {
    const settings: Settings = {
      profiles: {
        "test-stack": {
          region: "eu-north-1",
          source: { type: "ssm", parameterName: "/test/config" },
        },
      },
    };
    mockSelect.mockResolvedValueOnce("test-stack");
    const result = await promptProfile(settings);
    expect(result).toEqual(settings.profiles["test-stack"]);
  });

  it("should return null when 'New configuration' is selected", async () => {
    const settings: Settings = {
      profiles: {
        "test-stack": {
          region: "eu-north-1",
          source: { type: "ssm", parameterName: "/test/config" },
        },
      },
    };
    mockSelect.mockResolvedValueOnce("__new__");
    const result = await promptProfile(settings);
    expect(result).toBeNull();
  });
});

describe("promptSaveProfile", () => {
  it("should return save false when declined", async () => {
    mockConfirm.mockResolvedValueOnce(false);
    const result = await promptSaveProfile(
      { region: "eu-north-1", source: { type: "ssm", parameterName: "/test/config" } },
      { profiles: {} },
    );
    expect(result).toEqual({ save: false });
  });

  it("should return name when confirmed", async () => {
    mockConfirm.mockResolvedValueOnce(true);
    mockText.mockResolvedValueOnce("my-stack");
    const result = await promptSaveProfile(
      { region: "eu-north-1", source: { type: "ssm", parameterName: "/test/config" } },
      { profiles: {} },
    );
    expect(result).toEqual({ save: true, name: "my-stack" });
  });
});

describe("promptRegion", () => {
  it("should prompt for region", async () => {
    mockText.mockResolvedValueOnce("eu-north-1");

    const region = await promptRegion();
    expect(region).toBe("eu-north-1");
  });
});

describe("promptConfigSource", () => {
  it("should prompt for SSM parameter name", async () => {
    mockSelect.mockResolvedValueOnce("ssm");
    mockText.mockResolvedValueOnce("/my/param");

    const source = await promptConfigSource();
    expect(source).toEqual({ type: "ssm", parameterName: "/my/param" });
  });

  it("should prompt for AppConfig IDs", async () => {
    mockSelect.mockResolvedValueOnce("appconfig");
    mockText.mockResolvedValueOnce("app1");
    mockText.mockResolvedValueOnce("env1");
    mockText.mockResolvedValueOnce("prof1");

    const source = await promptConfigSource();
    expect(source).toEqual({
      type: "appconfig",
      applicationId: "app1",
      environmentId: "env1",
      configurationProfileId: "prof1",
    });
  });
});

describe("promptEnableMode", () => {
  it("should prompt for mode when not provided", async () => {
    mockSelect.mockResolvedValueOnce("latency");
    mockText
      .mockResolvedValueOnce("50")
      .mockResolvedValueOnce("200")
      .mockResolvedValueOnce("600");
    mockConfirm.mockResolvedValueOnce(false);

    const config: FailureFlagsConfig = {};
    const result = await promptEnableMode(config);

    expect(result.mode).toBe("latency");
    expect(result.flag.enabled).toBe(true);
    expect(result.flag.percentage).toBe(50);
    expect(result.flag.min_latency).toBe(200);
    expect(result.flag.max_latency).toBe(600);
  });

  it("should use requested mode directly", async () => {
    mockText
      .mockResolvedValueOnce("100")
      .mockResolvedValueOnce("Test error");
    mockConfirm.mockResolvedValueOnce(false);

    const config: FailureFlagsConfig = {};
    const result = await promptEnableMode(config, "exception");

    expect(result.mode).toBe("exception");
    expect(result.flag.exception_msg).toBe("Test error");
  });

  it("should throw for unknown mode", async () => {
    await expect(promptEnableMode({}, "invalid")).rejects.toThrow("Unknown mode: invalid");
  });

  it("should prompt for match conditions when confirmed", async () => {
    mockText
      .mockResolvedValueOnce("100")
      .mockResolvedValueOnce("500");
    mockConfirm
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);
    mockText
      .mockResolvedValueOnce("requestContext.http.method");
    mockSelect.mockResolvedValueOnce("eq");
    mockText.mockResolvedValueOnce("GET");

    const result = await promptEnableMode({}, "statuscode");

    expect(result.flag.match).toHaveLength(1);
    expect(result.flag.match?.[0].path).toBe("requestContext.http.method");
    expect(result.flag.match?.[0].operator).toBe("eq");
    expect(result.flag.match?.[0].value).toBe("GET");
  });

  it("should prompt for timeout mode params", async () => {
    mockText
      .mockResolvedValueOnce("100")
      .mockResolvedValueOnce("250");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptEnableMode({}, "timeout");
    expect(result.flag.timeout_buffer_ms).toBe(250);
  });

  it("should prompt for diskspace mode params", async () => {
    mockText
      .mockResolvedValueOnce("80")
      .mockResolvedValueOnce("50");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptEnableMode({}, "diskspace");
    expect(result.flag.disk_space).toBe(50);
    expect(result.flag.percentage).toBe(80);
  });

  it("should prompt for denylist mode params", async () => {
    mockText
      .mockResolvedValueOnce("100")
      .mockResolvedValueOnce("s3.*.amazonaws.com, dynamodb.*.amazonaws.com");
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptEnableMode({}, "denylist");
    expect(result.flag.deny_list).toEqual(["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]);
  });

  it("should prompt for corruption mode params", async () => {
    mockText
      .mockResolvedValueOnce("30")
      .mockResolvedValueOnce('{"error": "corrupted"}');
    mockConfirm.mockResolvedValueOnce(false);

    const result = await promptEnableMode({}, "corruption");
    expect(result.flag.body).toBe('{"error": "corrupted"}');
  });
});

describe("promptDisableMode", () => {
  it("should disable all modes with --all", async () => {
    const config: FailureFlagsConfig = {
      latency: { enabled: true, percentage: 100, min_latency: 100, max_latency: 400 },
      exception: { enabled: true, percentage: 100, exception_msg: "test" },
      statuscode: { enabled: false, percentage: 100, status_code: 404 },
    };

    const result = await promptDisableMode(config, undefined, true);
    expect(result.latency?.enabled).toBe(false);
    expect(result.exception?.enabled).toBe(false);
    expect(result.statuscode?.enabled).toBe(false);
  });

  it("should disable a specific mode", async () => {
    const config: FailureFlagsConfig = {
      latency: { enabled: true, percentage: 100, min_latency: 100, max_latency: 400 },
    };

    const result = await promptDisableMode(config, "latency");
    expect(result.latency?.enabled).toBe(false);
    expect(result.latency?.min_latency).toBe(100);
  });

  it("should prompt for mode to disable when not specified", async () => {
    mockSelect.mockResolvedValueOnce("exception");

    const config: FailureFlagsConfig = {
      latency: { enabled: true, percentage: 100, min_latency: 100, max_latency: 400 },
      exception: { enabled: true, percentage: 100, exception_msg: "test" },
    };

    const result = await promptDisableMode(config);
    expect(result.exception?.enabled).toBe(false);
    expect(result.latency?.enabled).toBe(true);
  });

  it("should throw when no modes are enabled and no mode specified", async () => {
    const config: FailureFlagsConfig = {
      latency: { enabled: false },
    };

    await expect(promptDisableMode(config)).rejects.toThrow("No modes are currently enabled");
  });

  it("should throw for unknown mode", async () => {
    await expect(promptDisableMode({}, "invalid")).rejects.toThrow("Unknown mode: invalid");
  });

  it("should handle disabling a mode that has no existing config", async () => {
    const result = await promptDisableMode({}, "latency");
    expect(result.latency?.enabled).toBe(false);
  });

  it("should disable all modes when 'Disable all' is selected interactively", async () => {
    mockSelect.mockResolvedValueOnce("__all__");

    const config: FailureFlagsConfig = {
      latency: { enabled: true, percentage: 100, min_latency: 100, max_latency: 400 },
      exception: { enabled: true, percentage: 100, exception_msg: "test" },
    };

    const result = await promptDisableMode(config);
    expect(result.latency?.enabled).toBe(false);
    expect(result.exception?.enabled).toBe(false);
  });
});
