import { SSMClient, GetParameterCommand, PutParameterCommand } from "@aws-sdk/client-ssm";
import { parseFlags, validateFlagValue } from "../config.js";
import type { FailureFlagsConfig, FailureMode, FlagValue } from "../types.js";
import { promptConfigSource, promptRegion } from "./prompts.js";

export type ConfigSource =
  | { type: "ssm"; parameterName: string }
  | { type: "appconfig"; applicationId: string; environmentId: string; configurationProfileId: string };

interface ParsedFlags {
  param?: string;
  app?: string;
  env?: string;
  profile?: string;
}

export async function resolveConfigSource(flags: ParsedFlags): Promise<ConfigSource> {
  if (flags.param) {
    return { type: "ssm", parameterName: flags.param };
  }

  if (flags.app && flags.env && flags.profile) {
    return {
      type: "appconfig",
      applicationId: flags.app,
      environmentId: flags.env,
      configurationProfileId: flags.profile,
    };
  }

  if (process.env.FAILURE_INJECTION_PARAM) {
    return { type: "ssm", parameterName: process.env.FAILURE_INJECTION_PARAM };
  }

  if (
    process.env.FAILURE_APPCONFIG_APPLICATION &&
    process.env.FAILURE_APPCONFIG_ENVIRONMENT &&
    process.env.FAILURE_APPCONFIG_CONFIGURATION
  ) {
    return {
      type: "appconfig",
      applicationId: process.env.FAILURE_APPCONFIG_APPLICATION,
      environmentId: process.env.FAILURE_APPCONFIG_ENVIRONMENT,
      configurationProfileId: process.env.FAILURE_APPCONFIG_CONFIGURATION,
    };
  }

  return promptConfigSource();
}

export async function resolveRegion(flagRegion?: string): Promise<string> {
  if (flagRegion) {
    return flagRegion;
  }

  const envRegion = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (envRegion) {
    return envRegion;
  }

  return promptRegion();
}

export interface ReadConfigResult {
  config: FailureFlagsConfig;
  rawJson: string;
  notFound?: boolean;
}

export async function readConfig(source: ConfigSource, region: string): Promise<ReadConfigResult> {
  if (source.type === "ssm") {
    return readFromSSM(source.parameterName, region);
  }
  return readFromAppConfig(source, region);
}

export async function writeConfig(source: ConfigSource, config: FailureFlagsConfig, region: string): Promise<void> {
  const json = JSON.stringify(config, null, 2);

  if (source.type === "ssm") {
    await writeToSSM(source.parameterName, json, region);
  } else {
    await writeToAppConfig(source, json, region);
  }
}

async function readFromSSM(parameterName: string, region: string): Promise<ReadConfigResult> {
  const client = new SSMClient({ region });
  try {
    const response = await client.send(new GetParameterCommand({ Name: parameterName }));
    const rawJson = response.Parameter?.Value ?? "{}";
    const parsed = JSON.parse(rawJson) as Record<string, unknown>;
    return { config: parseFlags(parsed), rawJson };
  } catch (err: unknown) {
    if (err instanceof Error && err.name === "ParameterNotFound") {
      return { config: {}, rawJson: "{}", notFound: true };
    }
    throw err;
  }
}

async function readFromAppConfig(
  source: Extract<ConfigSource, { type: "appconfig" }>,
  region: string,
): Promise<ReadConfigResult> {
  const { AppConfigDataClient, StartConfigurationSessionCommand, GetLatestConfigurationCommand } =
    await import("@aws-sdk/client-appconfigdata");
  const client = new AppConfigDataClient({ region });

  const session = await client.send(
    new StartConfigurationSessionCommand({
      ApplicationIdentifier: source.applicationId,
      EnvironmentIdentifier: source.environmentId,
      ConfigurationProfileIdentifier: source.configurationProfileId,
    }),
  );

  const response = await client.send(
    new GetLatestConfigurationCommand({
      ConfigurationToken: session.InitialConfigurationToken,
    }),
  );

  const rawJson = response.Configuration
    ? new TextDecoder().decode(response.Configuration)
    : "{}";

  if (!rawJson || rawJson.trim() === "") {
    return { config: {}, rawJson: "{}" };
  }

  const parsed = JSON.parse(rawJson) as Record<string, unknown>;
  return { config: parseFlags(parsed), rawJson };
}

async function writeToSSM(parameterName: string, json: string, region: string): Promise<void> {
  const client = new SSMClient({ region });
  await client.send(
    new PutParameterCommand({
      Name: parameterName,
      Value: json,
      Type: "String",
      Overwrite: true,
    }),
  );
}

async function writeToAppConfig(
  source: Extract<ConfigSource, { type: "appconfig" }>,
  json: string,
  region: string,
): Promise<void> {
  const { AppConfigClient, CreateHostedConfigurationVersionCommand, StartDeploymentCommand } =
    await import("@aws-sdk/client-appconfig");
  const client = new AppConfigClient({ region });

  const versionResponse = await client.send(
    new CreateHostedConfigurationVersionCommand({
      ApplicationId: source.applicationId,
      ConfigurationProfileId: source.configurationProfileId,
      Content: new TextEncoder().encode(json),
      ContentType: "application/json",
    }),
  );

  await client.send(
    new StartDeploymentCommand({
      ApplicationId: source.applicationId,
      EnvironmentId: source.environmentId,
      ConfigurationProfileId: source.configurationProfileId,
      ConfigurationVersion: String(versionResponse.VersionNumber),
      DeploymentStrategyId: "AppConfig.AllAtOnce",
    }),
  );
}

export function mergeFlag(
  config: FailureFlagsConfig,
  mode: FailureMode,
  flag: FlagValue,
): FailureFlagsConfig {
  const updated = { ...config, [mode]: flag };
  const errors = validateFlagValue(mode, flag as unknown as Record<string, unknown>);
  if (errors.length > 0) {
    throw new Error(
      `Validation failed:\n${errors.map((e) => `  ${e.field}: ${e.message}`).join("\n")}`,
    );
  }
  return updated;
}

export function sourceLabel(source: ConfigSource): string {
  if (source.type === "ssm") {
    return `SSM Parameter: ${source.parameterName}`;
  }
  return `AppConfig: app=${source.applicationId} env=${source.environmentId} profile=${source.configurationProfileId}`;
}
