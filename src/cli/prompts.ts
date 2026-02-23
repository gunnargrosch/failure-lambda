import * as p from "@clack/prompts";
import { FAILURE_MODE_ORDER } from "../types.js";
import type { FailureMode, FlagValue, FailureFlagsConfig, MatchCondition, MatchOperator } from "../types.js";
import type { ConfigSource } from "./store.js";
import { sourceLabel } from "./store.js";
import type { SavedProfile, Settings } from "./settings.js";

/** Unwrap a prompt result, throwing on cancel so callers don't need to check every time */
function unwrapOrCancel<T>(result: T | symbol): T {
  if (p.isCancel(result)) {
    p.cancel("Operation cancelled.");
    process.exit(0);
  }
  return result;
}

const MODE_DESCRIPTIONS: Record<FailureMode, string> = {
  latency: "Add random latency to invocations",
  timeout: "Force Lambda timeout",
  diskspace: "Fill /tmp with data",
  denylist: "Block outgoing network requests by hostname pattern",
  statuscode: "Return an HTTP error status code",
  exception: "Throw an exception",
  corruption: "Replace the response body",
};

export type Command = "status" | "enable" | "disable" | "switch" | "exit";

export async function promptCommand(): Promise<Command> {
  return unwrapOrCancel(
    await p.select({
      message: "What do you want to do?",
      options: [
        { value: "status" as const, label: "Status", hint: "Show current configuration" },
        { value: "enable" as const, label: "Enable", hint: "Enable a failure mode" },
        { value: "disable" as const, label: "Disable", hint: "Disable a failure mode" },
        { value: "switch" as const, label: "Switch configuration", hint: "Select a different saved profile" },
        { value: "exit" as const, label: "Exit" },
      ],
    }),
  );
}

const NEW_CONFIG = "__new__" as const;

export async function promptProfile(
  settings: Settings,
): Promise<SavedProfile | null> {
  const entries = Object.entries(settings.profiles);
  if (entries.length === 0) {
    return null;
  }

  const choice = unwrapOrCancel(
    await p.select<string | typeof NEW_CONFIG>({
      message: "Select a saved configuration",
      options: [
        ...entries.map(([name, profile]) => ({
          value: name,
          label: name,
          hint: `${profile.region} - ${sourceLabel(profile.source)}`,
        })),
        { value: NEW_CONFIG, label: "New configuration", hint: "Enter new region and config source" },
      ],
    }),
  );

  if (choice === NEW_CONFIG) {
    return null;
  }

  return settings.profiles[choice];
}

export async function promptSaveProfile(
  profile: SavedProfile,
  settings: Settings,
): Promise<{ save: boolean; name?: string }> {
  const save = unwrapOrCancel(
    await p.confirm({
      message: "Save this configuration for next time?",
      initialValue: true,
    }),
  );

  if (!save) {
    return { save: false };
  }

  const existingNames = Object.keys(settings.profiles);
  const defaultName = profile.source.type === "ssm"
    ? `ssm-${profile.source.parameterName.split("/").filter(Boolean).join("-")}`
    : `appconfig-${profile.source.applicationId}`;

  const name = unwrapOrCancel(
    await p.text({
      message: "Profile name",
      defaultValue: defaultName,
      placeholder: defaultName,
      validate: (value) => {
        const resolved = value || defaultName;
        if (existingNames.includes(resolved.trim())) return `Profile "${resolved.trim()}" already exists`;
        return undefined;
      },
    }),
  );

  return { save: true, name: name.trim() };
}

export async function promptConfirmCreate(label: string): Promise<boolean> {
  return unwrapOrCancel(
    await p.confirm({
      message: `${label} does not exist. Create it?`,
      initialValue: true,
    }),
  );
}

export async function promptRegion(): Promise<string> {
  const region = unwrapOrCancel(
    await p.text({
      message: "AWS region",
      defaultValue: "eu-north-1",
      placeholder: "eu-north-1",
    }),
  );
  return region;
}

export async function promptConfigSource(): Promise<ConfigSource> {
  const sourceType = unwrapOrCancel(
    await p.select({
      message: "Where is your failure-lambda configuration stored?",
      options: [
        { value: "ssm" as const, label: "SSM Parameter Store" },
        { value: "appconfig" as const, label: "AppConfig" },
      ],
    }),
  );

  if (sourceType === "ssm") {
    const parameterName = unwrapOrCancel(
      await p.text({
        message: "SSM parameter name",
        placeholder: "/my-app/failure-config",
        validate: (value) => {
          if (!value || value.trim() === "") return "Parameter name is required";
          return undefined;
        },
      }),
    );
    return { type: "ssm", parameterName };
  }

  const applicationId = unwrapOrCancel(
    await p.text({
      message: "AppConfig application ID",
      validate: (value) => {
        if (!value || value.trim() === "") return "Application ID is required";
        return undefined;
      },
    }),
  );

  const environmentId = unwrapOrCancel(
    await p.text({
      message: "AppConfig environment ID",
      validate: (value) => {
        if (!value || value.trim() === "") return "Environment ID is required";
        return undefined;
      },
    }),
  );

  const configurationProfileId = unwrapOrCancel(
    await p.text({
      message: "AppConfig configuration profile ID",
      validate: (value) => {
        if (!value || value.trim() === "") return "Configuration profile ID is required";
        return undefined;
      },
    }),
  );

  return { type: "appconfig", applicationId, environmentId, configurationProfileId };
}

export async function promptEnableMode(
  currentConfig: FailureFlagsConfig,
  requestedMode?: string,
): Promise<{ mode: FailureMode; flag: FlagValue }> {
  let mode: FailureMode;

  if (requestedMode) {
    if (!FAILURE_MODE_ORDER.includes(requestedMode as FailureMode)) {
      throw new Error(
        `Unknown mode: ${requestedMode}. Valid modes: ${FAILURE_MODE_ORDER.join(", ")}`,
      );
    }
    mode = requestedMode as FailureMode;
  } else {
    mode = unwrapOrCancel(
      await p.select({
        message: "Which failure mode do you want to enable?",
        options: FAILURE_MODE_ORDER.map((m) => ({
          value: m,
          label: m,
          hint: `${MODE_DESCRIPTIONS[m]}${currentConfig[m]?.enabled ? " (currently enabled)" : ""}`,
        })),
      }),
    );
  }

  const currentFlag = currentConfig[mode];

  const percentageStr = unwrapOrCancel(
    await p.text({
      message: "Injection percentage (0 to 100)",
      defaultValue: String(currentFlag?.percentage ?? 100),
      placeholder: String(currentFlag?.percentage ?? 100),
      validate: (value) => {
        if (!value) return undefined;
        const n = Number(value);
        if (Number.isNaN(n) || !Number.isInteger(n) || n < 0 || n > 100) return "Must be an integer between 0 and 100";
        return undefined;
      },
    }),
  );
  const percentage = Number(percentageStr);

  const flag: FlagValue = { enabled: true, percentage };
  await promptModeSpecificParams(mode, flag, currentFlag);

  const addMatch = unwrapOrCancel(
    await p.confirm({
      message: "Add event-based match conditions?",
      initialValue: false,
    }),
  );

  if (addMatch) {
    flag.match = await promptMatchConditions();
  }

  return { mode, flag };
}

async function promptModeSpecificParams(
  mode: FailureMode,
  flag: FlagValue,
  current?: FlagValue,
): Promise<void> {
  switch (mode) {
    case "latency": {
      const minStr = unwrapOrCancel(
        await p.text({
          message: "Minimum latency (ms)",
          defaultValue: String(current?.min_latency ?? 100),
          placeholder: String(current?.min_latency ?? 100),
          validate: (v) => {
            if (!v) return undefined;
            const n = Number(v);
            if (Number.isNaN(n) || n < 0) return "Must be a non-negative number";
            return undefined;
          },
        }),
      );
      const maxStr = unwrapOrCancel(
        await p.text({
          message: "Maximum latency (ms)",
          defaultValue: String(current?.max_latency ?? 400),
          placeholder: String(current?.max_latency ?? 400),
          validate: (v) => {
            if (!v) return undefined;
            const n = Number(v);
            if (Number.isNaN(n) || n < 0) return "Must be a non-negative number";
            return undefined;
          },
        }),
      );
      flag.min_latency = Number(minStr);
      flag.max_latency = Number(maxStr);
      break;
    }
    case "timeout": {
      const bufferStr = unwrapOrCancel(
        await p.text({
          message: "Timeout buffer (ms before Lambda timeout)",
          defaultValue: String(current?.timeout_buffer_ms ?? 500),
          placeholder: String(current?.timeout_buffer_ms ?? 500),
          validate: (v) => {
            if (!v) return undefined;
            const n = Number(v);
            if (Number.isNaN(n) || n < 0) return "Must be a non-negative number";
            return undefined;
          },
        }),
      );
      flag.timeout_buffer_ms = Number(bufferStr);
      break;
    }
    case "diskspace": {
      const sizeStr = unwrapOrCancel(
        await p.text({
          message: "Disk space to fill (MB)",
          defaultValue: String(current?.disk_space ?? 100),
          placeholder: String(current?.disk_space ?? 100),
          validate: (v) => {
            if (!v) return undefined;
            const n = Number(v);
            if (Number.isNaN(n) || n <= 0 || n > 10240) return "Must be between 1 and 10240 (MB)";
            return undefined;
          },
        }),
      );
      flag.disk_space = Number(sizeStr);
      break;
    }
    case "denylist": {
      const patternsStr = unwrapOrCancel(
        await p.text({
          message: "Deny list patterns (comma-separated regex)",
          defaultValue: current?.deny_list?.join(", ") ?? "s3.*.amazonaws.com, dynamodb.*.amazonaws.com",
          placeholder: "s3.*.amazonaws.com, dynamodb.*.amazonaws.com",
        }),
      );
      flag.deny_list = patternsStr.split(",").map((s) => s.trim()).filter(Boolean);
      break;
    }
    case "statuscode": {
      const codeStr = unwrapOrCancel(
        await p.text({
          message: "HTTP status code to return",
          defaultValue: String(current?.status_code ?? 404),
          placeholder: String(current?.status_code ?? 404),
          validate: (v) => {
            if (!v) return undefined;
            const n = Number(v);
            if (Number.isNaN(n) || n < 100 || n > 599) return "Must be an HTTP status code (100-599)";
            return undefined;
          },
        }),
      );
      flag.status_code = Number(codeStr);
      break;
    }
    case "exception": {
      const msg = unwrapOrCancel(
        await p.text({
          message: "Exception message",
          defaultValue: current?.exception_msg ?? "Injected exception",
          placeholder: "Injected exception",
        }),
      );
      flag.exception_msg = msg;
      break;
    }
    case "corruption": {
      const body = unwrapOrCancel(
        await p.text({
          message: "Replacement response body (leave empty for default)",
          defaultValue: current?.body ?? "",
          placeholder: '{"error": "corrupted"}',
        }),
      );
      if (body) {
        flag.body = body;
      }
      break;
    }
  }
}

async function promptMatchConditions(): Promise<MatchCondition[]> {
  const conditions: MatchCondition[] = [];

  let addMore = true;
  while (addMore) {
    const path = unwrapOrCancel(
      await p.text({
        message: "Event path (dot-separated, e.g. requestContext.http.method)",
        validate: (v) => {
          if (!v || v.trim() === "") return "Path is required";
          return undefined;
        },
      }),
    );

    const operator = unwrapOrCancel(
      await p.select<MatchOperator>({
        message: "Match operator",
        options: [
          { value: "eq", label: "eq", hint: "Exact string match" },
          { value: "startsWith", label: "startsWith", hint: "Starts with prefix" },
          { value: "regex", label: "regex", hint: "Regular expression match" },
          { value: "exists", label: "exists", hint: "Path exists (any value)" },
        ],
      }),
    );

    const condition: MatchCondition = { path, operator };

    if (operator !== "exists") {
      const value = unwrapOrCancel(
        await p.text({
          message: "Expected value",
          validate: (v) => {
            if (!v || v.trim() === "") return "Value is required";
            return undefined;
          },
        }),
      );
      condition.value = value;
    }

    conditions.push(condition);

    addMore = unwrapOrCancel(
      await p.confirm({
        message: "Add another match condition?",
        initialValue: false,
      }),
    );
  }

  return conditions;
}

export async function promptDisableMode(
  currentConfig: FailureFlagsConfig,
  requestedMode?: string,
  disableAll?: boolean,
): Promise<FailureFlagsConfig> {
  if (disableAll) {
    const updated = { ...currentConfig };
    for (const mode of FAILURE_MODE_ORDER) {
      if (updated[mode]) {
        updated[mode] = { ...updated[mode], enabled: false };
      }
    }
    return updated;
  }

  if (requestedMode) {
    if (!FAILURE_MODE_ORDER.includes(requestedMode as FailureMode)) {
      throw new Error(
        `Unknown mode: ${requestedMode}. Valid modes: ${FAILURE_MODE_ORDER.join(", ")}`,
      );
    }
    const mode = requestedMode as FailureMode;
    const flag = currentConfig[mode];
    if (!flag) {
      return { ...currentConfig, [mode]: { enabled: false } };
    }
    return { ...currentConfig, [mode]: { ...flag, enabled: false } };
  }

  const enabledModes = FAILURE_MODE_ORDER.filter((m) => currentConfig[m]?.enabled);
  if (enabledModes.length === 0) {
    throw new Error("No modes are currently enabled.");
  }

  const ALL = "__all__" as const;
  const choice = unwrapOrCancel(
    await p.select<FailureMode | typeof ALL>({
      message: "Which failure mode do you want to disable?",
      options: [
        ...enabledModes.map((m) => ({
          value: m,
          label: m,
          hint: MODE_DESCRIPTIONS[m],
        })),
        { value: ALL, label: "Disable all", hint: `All ${enabledModes.length} enabled modes` },
      ],
    }),
  );

  if (choice === ALL) {
    const updated = { ...currentConfig };
    for (const mode of enabledModes) {
      updated[mode] = { ...updated[mode], enabled: false };
    }
    return updated;
  }

  const flag = currentConfig[choice];
  return { ...currentConfig, [choice]: { ...flag, enabled: false } };
}
