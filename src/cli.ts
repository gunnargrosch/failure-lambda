import { parseArgs } from "node:util";
import { resolveConfigSource, resolveRegion, readConfig, writeConfig, mergeFlag, sourceLabel } from "./cli/store.js";
import type { ConfigSource } from "./cli/store.js";
import { promptCommand, promptProfile, promptSaveProfile, promptEnableMode, promptDisableMode, promptConfirmCreate } from "./cli/prompts.js";
import { displayStatus, displayConfigPreview } from "./cli/display.js";
import { loadSettings, saveSettings } from "./cli/settings.js";

declare const __CLI_VERSION__: string | undefined;

let _clack: typeof import("@clack/prompts") | null = null;
async function clack(): Promise<typeof import("@clack/prompts")> {
  if (_clack === null) _clack = await import("@clack/prompts");
  return _clack;
}

const HELP = `
failure-lambda - Manage failure injection configuration

Usage:
  failure-lambda status                Show current configuration
  failure-lambda status --json         Output raw configuration as JSON
  failure-lambda enable [mode]         Enable a failure mode
  failure-lambda disable [mode]        Disable a failure mode
  failure-lambda disable --all         Disable all failure modes

Config source (pick one):
  --param <name>                       SSM Parameter Store parameter name
  --app <id>                           AppConfig application ID
  --env <id>                           AppConfig environment ID
  --profile <id>                       AppConfig configuration profile ID

AWS region:
  --region <region>                    AWS region (e.g. eu-north-1)
  Falls back to AWS_REGION / AWS_DEFAULT_REGION env vars, or prompts interactively.

Environment variables (used if flags not set):
  FAILURE_INJECTION_PARAM              SSM parameter name
  FAILURE_APPCONFIG_APPLICATION        AppConfig application ID
  FAILURE_APPCONFIG_ENVIRONMENT        AppConfig environment ID
  FAILURE_APPCONFIG_CONFIGURATION      AppConfig configuration profile ID

If neither flags nor environment variables are set, you will be prompted interactively.
Saved profiles are stored in ~/.failure-lambda.json.

Options:
  --region <region>                    AWS region (overrides AWS_REGION env var)
  --json                               Output raw JSON (with status command)
  --all                                Disable all modes (with disable command)
  --help                               Show this help
  --version                            Show version

Failure modes:
  latency      Add random latency to invocations
  timeout      Force Lambda timeout
  diskspace    Fill /tmp with data
  denylist     Block outgoing network requests by hostname pattern
  statuscode   Return an HTTP error status code
  exception    Throw an exception
  corruption   Replace the response body
`.trim();

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      param: { type: "string" },
      app: { type: "string" },
      env: { type: "string" },
      profile: { type: "string" },
      region: { type: "string" },
      json: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
    },
  });

  if (values.help) {
    console.log(HELP);
    return;
  }

  if (values.version) {
    console.log(typeof __CLI_VERSION__ !== "undefined" ? __CLI_VERSION__ : "unknown");
    return;
  }

  const commandArg = positionals[0];
  const modeArg = positionals[1];

  if (commandArg && !["status", "enable", "disable"].includes(commandArg)) {
    console.log(HELP);
    process.exitCode = 1;
    return;
  }

  const p = await clack();
  p.intro("failure-lambda");

  const hasFlags = !!(values.param || (values.app && values.env && values.profile) || values.region);

  let region: string;
  let source: ConfigSource;

  if (hasFlags) {
    // CLI flags take priority — no profile selection
    region = await resolveRegion(values.region);
    source = await resolveConfigSource({
      param: values.param,
      app: values.app,
      env: values.env,
      profile: values.profile,
    });
  } else {
    ({ region, source } = await selectOrCreateProfile());
  }

  if (commandArg) {
    await runCommand(commandArg, source, region, { modeArg, disableAll: values.all, json: values.json });
    p.outro("Done");
    return;
  }

  // Interactive loop
  let command = await promptCommand();
  while (command !== "exit") {
    if (command === "switch") {
      ({ region, source } = await selectOrCreateProfile());
    } else {
      await runCommand(command, source, region);
    }
    command = await promptCommand();
  }

  p.outro("Done");
}

async function selectOrCreateProfile(): Promise<{ region: string; source: ConfigSource }> {
  const settings = await loadSettings();
  const savedProfile = await promptProfile(settings);

  if (savedProfile) {
    return { region: savedProfile.region, source: savedProfile.source };
  }

  const region = await resolveRegion();
  const source = await resolveConfigSource({});

  const result = await promptSaveProfile({ region, source }, settings);
  if (result.save && result.name) {
    settings.profiles[result.name] = { region, source };
    await saveSettings(settings);
  }

  return { region, source };
}

async function runCommand(
  command: string,
  source: ConfigSource,
  region: string,
  opts: { modeArg?: string; disableAll?: boolean; json?: boolean } = {},
): Promise<void> {
  const p = await clack();
  const spin = p.spinner();

  if (command === "status") {
    spin.start("Reading configuration...");
    const { config, rawJson, notFound } = await readConfig(source, region);
    spin.stop("Configuration loaded");
    if (opts.json) {
      console.log(rawJson);
      return;
    }
    if (notFound) {
      p.log.warn(`${sourceLabel(source)} does not exist yet.`);
    }
    await displayStatus(config, source, region);
    return;
  }

  if (command === "json") {
    spin.start("Reading configuration...");
    const { config } = await readConfig(source, region);
    spin.stop("Configuration loaded");
    await displayConfigPreview(config);
    return;
  }

  if (command === "enable") {
    spin.start("Reading current configuration...");
    const { config: currentConfig, notFound } = await readConfig(source, region);
    spin.stop("Configuration loaded");

    if (notFound) {
      const create = await promptConfirmCreate(sourceLabel(source));
      if (!create) return;
    }

    const { mode, flag } = await promptEnableMode(currentConfig, opts.modeArg);
    const updatedConfig = mergeFlag(currentConfig, mode, flag);

    await displayConfigPreview(updatedConfig);

    spin.start(`Writing configuration to ${sourceLabel(source)}...`);
    await writeConfig(source, updatedConfig, region);
    spin.stop(`${mode} enabled`);
    return;
  }

  if (command === "disable") {
    spin.start("Reading current configuration...");
    const { config: currentConfig, notFound } = await readConfig(source, region);
    spin.stop("Configuration loaded");

    if (notFound) {
      p.log.warn(`${sourceLabel(source)} does not exist yet. Nothing to disable.`);
      return;
    }

    const updatedConfig = await promptDisableMode(currentConfig, opts.modeArg, opts.disableAll);

    await displayConfigPreview(updatedConfig);

    spin.start(`Writing configuration to ${sourceLabel(source)}...`);
    await writeConfig(source, updatedConfig, region);
    spin.stop(opts.disableAll ? "All modes disabled" : `${opts.modeArg ?? "Mode"} disabled`);
    return;
  }
}

main().catch(async (err: unknown) => {
  const p = await clack();
  p.cancel(err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
