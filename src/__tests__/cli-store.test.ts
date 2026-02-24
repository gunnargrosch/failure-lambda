import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import {
  AppConfigDataClient,
  StartConfigurationSessionCommand,
  GetLatestConfigurationCommand,
} from "@aws-sdk/client-appconfigdata";
import {
  AppConfigClient,
  CreateHostedConfigurationVersionCommand,
  StartDeploymentCommand,
} from "@aws-sdk/client-appconfig";
import { resolveConfigSource, resolveRegion, readConfig, writeConfig, mergeFlag, sourceLabel } from "../cli/store.js";
import type { ConfigSource } from "../cli/store.js";

const ssmMock = mockClient(SSMClient);
const appConfigDataMock = mockClient(AppConfigDataClient);
const appConfigMock = mockClient(AppConfigClient);

vi.mock("../cli/prompts.js", () => ({
  promptConfigSource: vi.fn(),
  promptRegion: vi.fn(),
}));


beforeEach(() => {
  ssmMock.reset();
  appConfigDataMock.reset();
  appConfigMock.reset();
  delete process.env.FAILURE_INJECTION_PARAM;
  delete process.env.FAILURE_APPCONFIG_APPLICATION;
  delete process.env.FAILURE_APPCONFIG_ENVIRONMENT;
  delete process.env.FAILURE_APPCONFIG_CONFIGURATION;
  delete process.env.AWS_REGION;
  delete process.env.AWS_DEFAULT_REGION;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("resolveConfigSource", () => {
  it("should use --param flag for SSM", async () => {
    const source = await resolveConfigSource({ param: "/my/param" });
    expect(source).toEqual({ type: "ssm", parameterName: "/my/param" });
  });

  it("should use --app/--env/--profile flags for AppConfig", async () => {
    const source = await resolveConfigSource({
      app: "app1",
      env: "env1",
      profile: "prof1",
    });
    expect(source).toEqual({
      type: "appconfig",
      applicationId: "app1",
      environmentId: "env1",
      configurationProfileId: "prof1",
    });
  });

  it("should fall back to FAILURE_INJECTION_PARAM env var", async () => {
    process.env.FAILURE_INJECTION_PARAM = "/env/param";
    const source = await resolveConfigSource({});
    expect(source).toEqual({ type: "ssm", parameterName: "/env/param" });
  });

  it("should fall back to FAILURE_APPCONFIG_* env vars", async () => {
    process.env.FAILURE_APPCONFIG_APPLICATION = "envApp";
    process.env.FAILURE_APPCONFIG_ENVIRONMENT = "envEnv";
    process.env.FAILURE_APPCONFIG_CONFIGURATION = "envProf";
    const source = await resolveConfigSource({});
    expect(source).toEqual({
      type: "appconfig",
      applicationId: "envApp",
      environmentId: "envEnv",
      configurationProfileId: "envProf",
    });
  });

  it("should prefer CLI flags over env vars", async () => {
    process.env.FAILURE_INJECTION_PARAM = "/env/param";
    const source = await resolveConfigSource({ param: "/flag/param" });
    expect(source).toEqual({ type: "ssm", parameterName: "/flag/param" });
  });

  it("should call promptConfigSource when nothing is set", async () => {
    const { promptConfigSource } = await import("../cli/prompts.js");
    const mockPrompt = vi.mocked(promptConfigSource);
    mockPrompt.mockResolvedValue({ type: "ssm", parameterName: "/prompted/param" });

    const source = await resolveConfigSource({});
    expect(source).toEqual({ type: "ssm", parameterName: "/prompted/param" });
    expect(mockPrompt).toHaveBeenCalled();
  });
});

describe("resolveRegion", () => {
  it("should use --region flag", async () => {
    const region = await resolveRegion("eu-west-1");
    expect(region).toBe("eu-west-1");
  });

  it("should fall back to AWS_REGION env var", async () => {
    process.env.AWS_REGION = "us-east-1";
    const region = await resolveRegion();
    expect(region).toBe("us-east-1");
  });

  it("should fall back to AWS_DEFAULT_REGION env var", async () => {
    process.env.AWS_DEFAULT_REGION = "ap-southeast-1";
    const region = await resolveRegion();
    expect(region).toBe("ap-southeast-1");
  });

  it("should prefer --region flag over env vars", async () => {
    process.env.AWS_REGION = "us-east-1";
    const region = await resolveRegion("eu-north-1");
    expect(region).toBe("eu-north-1");
  });

  it("should call promptRegion when nothing is set", async () => {
    const { promptRegion } = await import("../cli/prompts.js");
    const mockPrompt = vi.mocked(promptRegion);
    mockPrompt.mockResolvedValue("eu-north-1");

    const region = await resolveRegion();
    expect(region).toBe("eu-north-1");
    expect(mockPrompt).toHaveBeenCalled();
  });
});

describe("readConfig", () => {
  it("should read from SSM", async () => {
    const config = { latency: { enabled: true, percentage: 50, min_latency: 100, max_latency: 400 } };
    ssmMock.on(GetParameterCommand).resolves({
      Parameter: { Value: JSON.stringify(config) },
    });

    const source: ConfigSource = { type: "ssm", parameterName: "/test/param" };
    const result = await readConfig(source, "eu-north-1");
    expect(result.config.latency?.enabled).toBe(true);
    expect(result.config.latency?.percentage).toBe(50);
  });

  it("should return empty config for missing SSM parameter", async () => {
    const notFoundError = new Error("Parameter not found");
    notFoundError.name = "ParameterNotFound";
    ssmMock.on(GetParameterCommand).rejects(notFoundError);

    const source: ConfigSource = { type: "ssm", parameterName: "/missing/param" };
    const result = await readConfig(source, "eu-north-1");
    expect(result.config).toEqual({});
    expect(result.rawJson).toBe("{}");
    expect(result.notFound).toBe(true);
  });

  it("should read from AppConfig", async () => {
    const config = { exception: { enabled: true, percentage: 100, exception_msg: "test" } };
    appConfigDataMock.on(StartConfigurationSessionCommand).resolves({
      InitialConfigurationToken: "token123",
    });
    appConfigDataMock.on(GetLatestConfigurationCommand).resolves({
      Configuration: new TextEncoder().encode(JSON.stringify(config)),
    });

    const source: ConfigSource = {
      type: "appconfig",
      applicationId: "app1",
      environmentId: "env1",
      configurationProfileId: "prof1",
    };
    const result = await readConfig(source, "eu-north-1");
    expect(result.config.exception?.enabled).toBe(true);
    expect(result.config.exception?.exception_msg).toBe("test");
  });

  it("should return empty config for empty AppConfig response", async () => {
    appConfigDataMock.on(StartConfigurationSessionCommand).resolves({
      InitialConfigurationToken: "token123",
    });
    appConfigDataMock.on(GetLatestConfigurationCommand).resolves({
      Configuration: undefined,
    });

    const source: ConfigSource = {
      type: "appconfig",
      applicationId: "app1",
      environmentId: "env1",
      configurationProfileId: "prof1",
    };
    const result = await readConfig(source, "eu-north-1");
    expect(result.config).toEqual({});
  });
});

describe("writeConfig", () => {
  it("should write to SSM with overwrite", async () => {
    ssmMock.on(PutParameterCommand).resolves({});

    const source: ConfigSource = { type: "ssm", parameterName: "/test/param" };
    const config = { latency: { enabled: true, percentage: 100, min_latency: 100, max_latency: 400 } };

    await writeConfig(source, config, "eu-north-1");

    const calls = ssmMock.commandCalls(PutParameterCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input.Name).toBe("/test/param");
    expect(calls[0].args[0].input.Overwrite).toBe(true);
    expect(JSON.parse(calls[0].args[0].input.Value ?? "")).toEqual(config);
  });

  it("should write to AppConfig and start deployment", async () => {
    appConfigMock.on(CreateHostedConfigurationVersionCommand).resolves({
      VersionNumber: 5,
    });
    appConfigMock.on(StartDeploymentCommand).resolves({});

    const source: ConfigSource = {
      type: "appconfig",
      applicationId: "app1",
      environmentId: "env1",
      configurationProfileId: "prof1",
    };
    const config = { exception: { enabled: false } };

    await writeConfig(source, config, "eu-north-1");

    const createCalls = appConfigMock.commandCalls(CreateHostedConfigurationVersionCommand);
    expect(createCalls).toHaveLength(1);
    expect(createCalls[0].args[0].input.ApplicationId).toBe("app1");
    expect(createCalls[0].args[0].input.ConfigurationProfileId).toBe("prof1");

    const deployCalls = appConfigMock.commandCalls(StartDeploymentCommand);
    expect(deployCalls).toHaveLength(1);
    expect(deployCalls[0].args[0].input.ApplicationId).toBe("app1");
    expect(deployCalls[0].args[0].input.EnvironmentId).toBe("env1");
    expect(deployCalls[0].args[0].input.ConfigurationVersion).toBe("5");
    expect(deployCalls[0].args[0].input.DeploymentStrategyId).toBe("AppConfig.AllAtOnce");
  });
});

describe("mergeFlag", () => {
  it("should merge a valid flag into config", () => {
    const config = { latency: { enabled: true, percentage: 100, min_latency: 100, max_latency: 400 } };
    const result = mergeFlag(config, "exception", { enabled: true, percentage: 50, exception_msg: "test" });
    expect(result.latency?.enabled).toBe(true);
    expect(result.exception?.enabled).toBe(true);
    expect(result.exception?.exception_msg).toBe("test");
  });

  it("should throw on invalid flag", () => {
    expect(() =>
      mergeFlag({}, "latency", { enabled: true, percentage: 200 }),
    ).toThrow("Validation failed");
  });
});

describe("sourceLabel", () => {
  it("should format SSM source", () => {
    expect(sourceLabel({ type: "ssm", parameterName: "/my/param" })).toBe(
      "SSM Parameter: /my/param",
    );
  });

  it("should format AppConfig source", () => {
    const label = sourceLabel({
      type: "appconfig",
      applicationId: "a",
      environmentId: "e",
      configurationProfileId: "p",
    });
    expect(label).toBe("AppConfig: app=a env=e profile=p");
  });
});
