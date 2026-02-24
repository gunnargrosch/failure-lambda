# failure-lambda

[![npm version](https://img.shields.io/npm/v/failure-lambda.svg)](https://www.npmjs.com/package/failure-lambda)
[![CI](https://github.com/gunnargrosch/failure-lambda/actions/workflows/ci.yml/badge.svg)](https://github.com/gunnargrosch/failure-lambda/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/failure-lambda.svg)](LICENSE)
[![node](https://img.shields.io/node/v/failure-lambda.svg)](package.json)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue.svg)](https://www.typescriptlang.org/)

failure-lambda lets you inject faults into AWS Lambda functions to test how they behave under real-world failure conditions.

| Path | Runtimes | How | When to use |
|------|----------|-----|-------------|
| [npm package](#getting-started-npm-package) | Node.js 20+ | Wrap handler or use Middy middleware | Programmatic control, Node.js only |
| [Lambda Layer](#getting-started-lambda-layer) | Any managed runtime | Add layer + 2 env vars | Zero code changes, any runtime |

Both paths support the same [failure modes](#failure-modes) and are controlled via SSM Parameter Store or AppConfig.

## Table of Contents

- [Getting Started: npm Package](#getting-started-npm-package)
- [Getting Started: Lambda Layer](#getting-started-lambda-layer)
- [Failure Modes](#failure-modes)
- [Configuration](#configuration)
- [Configuration Sources](#configuration-sources)
- [Environment Variables](#environment-variables)
- [CLI](#cli)
- [Logging](#logging)
- [Advanced Usage](#advanced-usage)
- [Examples](#examples)
- [Migration from 0.x](#migration-from-0x)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Getting Started: npm Package

### 1. Install

```bash
npm install failure-lambda
```

**Requirements:** Node.js >= 20 — Lambda runtimes `nodejs20.x`, `nodejs22.x`, or `nodejs24.x`.

### 2. Wrap your handler

```ts
import failureLambda from "failure-lambda";

export const handler = failureLambda(async (event, context) => {
  // your handler logic
  return { statusCode: 200, body: "OK" };
});
```

CommonJS:

```js
const failureLambda = require("failure-lambda");

exports.handler = failureLambda(async (event, context) => {
  return { statusCode: 200, body: "OK" };
});
```

### 3. Create the SSM parameter

```bash
aws ssm put-parameter --region eu-west-1 --name failureLambdaConfig --type String --overwrite --value '{
  "latency": {"enabled": false, "min_latency": 100, "max_latency": 400},
  "exception": {"enabled": false, "exception_msg": "Exception message!"},
  "statuscode": {"enabled": false, "status_code": 404},
  "diskspace": {"enabled": false, "disk_space": 100},
  "denylist": {"enabled": false, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]},
  "timeout": {"enabled": false, "timeout_buffer_ms": 500},
  "corruption": {"enabled": false, "body": "{\"error\": \"corrupted\"}"}
}'
```

### 4. Set the environment variable

Add to your Lambda function:

```bash
FAILURE_INJECTION_PARAM=failureLambdaConfig
```

### 5. Add IAM permission

Grant your Lambda execution role `ssm:GetParameter` on the parameter.

### 6. Deploy and test

Enable a failure mode by updating the SSM parameter (or use the [CLI](#cli)):

```bash
failure-lambda enable latency --param failureLambdaConfig --region eu-west-1
```

> **Using AppConfig instead of SSM?** See [Configuration Sources](#configuration-sources) for setup steps. AppConfig provides deployment strategies and automatic rollback but requires more setup than SSM.

> **Bundling tip:** The only runtime dependency is `@aws-sdk/client-ssm`, which the Lambda runtime already provides. If you use esbuild (SAM, CDK), mark `@aws-sdk/*` as external: `External: ["@aws-sdk/*"]`.

### Using Middy?

If you use [Middy](https://middy.js.org/) (v4+), use the middleware variant instead of wrapping your handler:

```ts
import middy from "@middy/core";
import { failureLambdaMiddleware } from "failure-lambda/middy";

export const handler = middy()
  .use(failureLambdaMiddleware())
  .handler(async (event, context) => {
    return { statusCode: 200, body: "OK" };
  });
```

The middleware runs pre-handler failures in its `before` phase and post-handler failures (corruption) in its `after` phase. It supports the same `configProvider` and `dryRun` options as the wrapper.

## Getting Started: Lambda Layer

The Lambda Layer enables fault injection with **zero code changes** — no imports, no wrapper, no middleware. Add the layer to your function, set two environment variables, and your existing handler gets chaos engineering capabilities automatically.

### 1. Download the layer zip

Get `failure-lambda-layer-x86_64.zip` or `failure-lambda-layer-aarch64.zip` from the [latest GitHub release](https://github.com/gunnargrosch/failure-lambda/releases/latest).

### 2. Publish the layer to your account

```bash
aws lambda publish-layer-version \
  --layer-name failure-lambda \
  --zip-file fileb://failure-lambda-layer-aarch64.zip \
  --compatible-architectures arm64 \
  --region eu-west-1
```

### 3. Add the layer to your function

Add the layer ARN returned by the previous command to your Lambda function's layers.

### 4. Set the environment variables

```bash
AWS_LAMBDA_EXEC_WRAPPER=/opt/failure-lambda-wrapper
FAILURE_INJECTION_PARAM=failureLambdaConfig
```

### 5. Create the SSM parameter

```bash
aws ssm put-parameter --region eu-west-1 --name failureLambdaConfig --type String --overwrite --value '{
  "latency": {"enabled": false, "min_latency": 100, "max_latency": 400},
  "exception": {"enabled": false, "exception_msg": "Exception message!"},
  "statuscode": {"enabled": false, "status_code": 404},
  "diskspace": {"enabled": false, "disk_space": 100},
  "denylist": {"enabled": false, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]},
  "timeout": {"enabled": false, "timeout_buffer_ms": 500},
  "corruption": {"enabled": false, "body": "{\"error\": \"corrupted\"}"}
}'
```

### 6. Add IAM permission

Grant your Lambda execution role `ssm:GetParameter` on the parameter.

### 7. Deploy and test

Enable a failure mode by updating the SSM parameter (or use the [CLI](#cli)):

```bash
failure-lambda enable latency --param failureLambdaConfig --region eu-west-1
```

> **Using AppConfig instead of SSM?** See [Configuration Sources](#configuration-sources). Also add the [AppConfig Lambda extension layer](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions-versions.html) to your function.

### Supported Runtimes

The layer works with all managed Lambda runtimes that support `AWS_LAMBDA_EXEC_WRAPPER`:

- **Node.js:** nodejs24.x, nodejs22.x, nodejs20.x
- **Python:** python3.14, python3.13, python3.12, python3.11, python3.10
- **Java:** java25, java21, java17, java11, java8.al2
- **.NET:** dotnet10, dotnet8
- **Ruby:** ruby3.4, ruby3.3, ruby3.2

Both x86_64 and arm64 architectures are supported.

### SAM Example

```yaml
Parameters:
  FailureLambdaLayerArn:
    Type: String
    Description: ARN of the failure-lambda layer (from aws lambda publish-layer-version)

Resources:
  MyFunction:
    Type: AWS::Serverless::Function
    Properties:
      Handler: index.handler
      Runtime: nodejs20.x
      CodeUri: src/
      Layers:
        - !Ref FailureLambdaLayerArn
      Environment:
        Variables:
          AWS_LAMBDA_EXEC_WRAPPER: /opt/failure-lambda-wrapper
          FAILURE_INJECTION_PARAM: /my-app/failure-config
      Policies:
        - SSMParameterReadPolicy:
            ParameterName: /my-app/failure-config
```

See `layer/template.yaml` for a full example that builds the layer from source with both x86_64 and arm64 variants.

### How It Works

The layer includes a Rust proxy that sits between the Lambda runtime and the Lambda Runtime API:

1. The wrapper script (`/opt/failure-lambda-wrapper`) starts the proxy and redirects `AWS_LAMBDA_RUNTIME_API` to it
2. On each invocation, the proxy reads your failure configuration from SSM Parameter Store or AppConfig
3. Based on the active flags, the proxy injects faults before or after forwarding the invocation to your handler
4. For `denylist` mode, an LD_PRELOAD shared library intercepts `getaddrinfo()` calls to block DNS resolution for matching hostnames

Your handler code is completely unchanged — the proxy is transparent.

### Limitations

- **Managed runtimes only:** Relies on `AWS_LAMBDA_EXEC_WRAPPER`, which is silently ignored on OS-only runtimes (`provided.al2023`, `provided.al2`).
- **DNS denylist:** Uses LD_PRELOAD on `getaddrinfo()`, which does not work with runtimes that use statically linked DNS. The Node.js npm package uses `dns.lookup` monkey-patching instead, which is more reliable for Node.js. All other failure modes work regardless of runtime.
- **No kill switch:** `FAILURE_LAMBDA_DISABLED` is not implemented in the layer proxy. To disable injection, set all flags to `enabled: false` in the configuration.

To build the layer from source instead of downloading, see `layer/build.sh`.

## Failure Modes

| Mode | Description |
|------|-------------|
| `latency` | Adds random delay between `min_latency` and `max_latency` ms |
| `timeout` | Sleeps until Lambda timeout minus a configurable buffer |
| `exception` | Throws an error with a configurable message |
| `statuscode` | Returns a response with a configurable HTTP status code, skipping the handler |
| `diskspace` | Fills `/tmp` with a configurable amount of data |
| `denylist` | Blocks outgoing network connections to hostnames matching regex patterns |
| `corruption` | Replaces or mangles the handler's response body *(post-handler)* |

Multiple modes can be active simultaneously. Each mode is an independent feature flag with its own `percentage` (probability of injection).

To enable a single mode with minimal config:

```json
{"latency": {"enabled": true, "min_latency": 200, "max_latency": 500}}
```

### Injection Order

When multiple modes are enabled, pre-handler failures run first, then the handler executes, then post-handler failures modify the response:

**Pre-handler** (before the handler):
1. `latency` — adds delay, then continues
2. `timeout` — sleeps until Lambda timeout minus buffer, then continues
3. `diskspace` — fills `/tmp`, then continues
4. `denylist` — blocks matching network hosts, then continues
5. `statuscode` — returns status code response, **skips handler**
6. `exception` — throws error, **skips handler**

**Post-handler** (after the handler returns):
7. `corruption` — corrupts or replaces the handler's response

Each flag's `percentage` is rolled independently.

## Configuration

Each failure mode is an independent feature flag. This format is used by both SSM Parameter Store and AppConfig.

```json
{
  "latency": { "enabled": false, "percentage": 100, "min_latency": 100, "max_latency": 400 },
  "exception": { "enabled": false, "percentage": 100, "exception_msg": "Exception message!" },
  "statuscode": { "enabled": false, "percentage": 100, "status_code": 404 },
  "diskspace": { "enabled": false, "percentage": 100, "disk_space": 100 },
  "denylist": { "enabled": false, "percentage": 50, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"] },
  "timeout": { "enabled": false, "percentage": 100, "timeout_buffer_ms": 500 },
  "corruption": { "enabled": false, "percentage": 30, "body": "{\"error\": \"corrupted\"}" }
}
```

When a flag is disabled, only `{"enabled": false}` is needed — attributes are optional. When enabled, `percentage` defaults to `100` if omitted.

### Flag Attributes

| Flag | Attribute | Type | Description |
|------|-----------|------|-------------|
| *all* | `enabled` | `boolean` | Enable/disable this failure mode |
| *all* | `percentage` | `integer` | Percentage of invocations to inject (0–100). Default: `100` |
| *all* | `match` | `object[]` | Event-based targeting conditions (see below) |
| `latency` | `min_latency` | `number` | Minimum latency in ms |
| `latency` | `max_latency` | `number` | Maximum latency in ms |
| `exception` | `exception_msg` | `string` | Error message thrown |
| `statuscode` | `status_code` | `number` | HTTP status code returned (100-599) |
| `diskspace` | `disk_space` | `number` | MB of disk to fill in `/tmp` (1–10240) |
| `denylist` | `deny_list` | `string[]` | Regex patterns; matching hosts are blocked. Patterns with nested quantifiers are rejected to prevent ReDoS. |
| `timeout` | `timeout_buffer_ms` | `number` | Buffer in ms before Lambda timeout. Default: `0` |
| `corruption` | `body` | `string` | Replacement response body. If omitted, body is mangled. |

### Event-Based Targeting

Use match conditions to restrict injection to specific requests — e.g. only affect production traffic or specific API routes. Each condition specifies a dot-separated `path` into the event. All conditions must match for the flag to fire.

```json
{
  "corruption": {
    "enabled": true,
    "percentage": 30,
    "body": "{\"error\": \"corrupted\"}",
    "match": [
      { "path": "requestContext.http.method", "value": "GET" },
      { "path": "requestContext.stage", "value": "prod" }
    ]
  }
}
```

This example only corrupts GET requests to the `prod` stage. Flags without `match` apply to all invocations.

#### Match Operators

Each condition supports an optional `operator` field (defaults to `"eq"`):

| Operator | Description | `value` required? |
|----------|-------------|-------------------|
| `eq` | Exact string equality (default) | Yes |
| `exists` | Path exists and is not null/undefined (falsy values like `0`, `""`, `false` are considered to exist) | No |
| `startsWith` | Value starts with the given prefix | Yes |
| `regex` | Value matches the regular expression | Yes |

```json
{
  "latency": {
    "enabled": true,
    "percentage": 100,
    "min_latency": 200,
    "max_latency": 500,
    "match": [
      { "path": "requestContext.http.path", "operator": "startsWith", "value": "/api" },
      { "path": "headers.x-debug", "operator": "exists" },
      { "path": "requestContext.http.method", "operator": "regex", "value": "^(GET|HEAD)$" }
    ]
  }
}
```

> **Header casing:** API Gateway lowercases all header keys in the Lambda event (e.g. `X-Chaos-Enabled` becomes `x-chaos-enabled`). Always use lowercase header names in match paths: `headers.x-debug`, not `headers.X-Debug`.

## Configuration Sources

Configuration is cached in memory to reduce latency and API calls. The cache persists within a single Lambda container and resets on cold starts.

- **SSM Parameter Store:** Defaults to a 60-second cache TTL (configurable via `FAILURE_CACHE_TTL`). The parameter name must match `FAILURE_INJECTION_PARAM`.
- **AppConfig:** Cache is **auto-disabled** (TTL defaults to 0) because the AppConfig Lambda extension already handles caching at its own poll interval (`AWS_APPCONFIG_EXTENSION_POLL_INTERVAL_SECONDS`, default 45s). Double-caching adds unnecessary staleness when updating configuration. You can override this by setting `FAILURE_CACHE_TTL` explicitly, but a warning will be logged.

### AWS AppConfig Feature Flags

AppConfig provides deployment strategies and automatic rollback but requires more setup than SSM. AppConfig's native `AWS.AppConfig.FeatureFlags` profile type is a natural fit — each failure mode maps to a feature flag with typed attributes and built-in validation.

1. Create an Application, Environment, and Configuration Profile (type: `AWS.AppConfig.FeatureFlags`) in the AppConfig console.
2. Define flags for each failure mode (`latency`, `exception`, `statuscode`, `diskspace`, `denylist`, `timeout`, `corruption`) with their attributes.
3. Deploy a version of the configuration.
4. Add the [AWS AppConfig Lambda extension layer](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions.html) to your Lambda function.
5. Add environment variables: `FAILURE_APPCONFIG_APPLICATION`, `FAILURE_APPCONFIG_ENVIRONMENT`, and `FAILURE_APPCONFIG_CONFIGURATION` (see [Environment Variables](#environment-variables)).
6. Add permissions for your Lambda function to access the AppConfig resources (`appconfig:StartConfigurationSession` and `appconfig:GetLatestConfiguration`).

The AppConfig extension returns the feature flags in the same JSON shape the library expects — no transformation needed.

> **AppConfig writes via CLI:** When using AppConfig as the config source, `enable` and `disable` commands create a new hosted configuration version and immediately deploy it using the `AppConfig.AllAtOnce` strategy. This bypasses any custom deployment strategy you may have configured — use the CLI for development and testing, not production rollouts.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAILURE_INJECTION_PARAM` | For SSM | SSM Parameter Store parameter name |
| `FAILURE_APPCONFIG_APPLICATION` | For AppConfig | AppConfig application name |
| `FAILURE_APPCONFIG_ENVIRONMENT` | For AppConfig | AppConfig environment name |
| `FAILURE_APPCONFIG_CONFIGURATION` | For AppConfig | AppConfig configuration profile name |
| `AWS_APPCONFIG_EXTENSION_HTTP_PORT` | No | AppConfig extension port (default: `2772`) |
| `FAILURE_CACHE_TTL` | No | Config cache TTL in seconds (default: `60` for SSM, `0` for AppConfig) |
| `FAILURE_LAMBDA_DISABLED` | No | Set to `"true"` to bypass all failure injection (kill switch). Not supported by the Lambda Layer. |

## CLI

The `failure-lambda` CLI lets you manage failure injection configuration from your terminal without manually constructing JSON or running multi-step AWS commands.

```bash
npx failure-lambda
```

Or install globally:

```bash
npm install -g failure-lambda
failure-lambda
```

### Commands

```
failure-lambda status              Show current configuration
failure-lambda status --json       Show current configuration as raw JSON
failure-lambda enable [mode]       Enable a failure mode
failure-lambda disable [mode]      Disable a failure mode
failure-lambda disable --all       Disable all failure modes
```

When run without a command, the CLI enters an interactive loop where you can run commands repeatedly until you choose to exit.

### Flags

| Flag | Description |
|------|-------------|
| `--param <name>` | SSM Parameter Store parameter name |
| `--app <id>` | AppConfig application ID |
| `--env <id>` | AppConfig environment ID |
| `--profile <id>` | AppConfig configuration profile ID |
| `--region <region>` | AWS region (falls back to `AWS_REGION` / `AWS_DEFAULT_REGION`) |
| `--json` | Output raw JSON (with `status` command) |
| `--all` | Disable all modes (with `disable` command) |
| `--help` | Show help |
| `--version` | Show version |

The same `FAILURE_INJECTION_PARAM` and `FAILURE_APPCONFIG_*` environment variables used by the library are also recognized by the CLI. If neither flags nor environment variables are set, the CLI prompts interactively.

> **AppConfig writes:** When targeting AppConfig, `enable` and `disable` create a new hosted configuration version and deploy it immediately with `AllAtOnce`. Use the CLI for development and testing, not production rollouts.

### Saved Profiles

The CLI can save named profiles to `~/.failure-lambda.json` so you don't need to re-enter connection details. On first run you'll be prompted to save your configuration. On subsequent runs, you can select a saved profile or create a new one.

Profiles store the AWS region and configuration source (SSM parameter name or AppConfig IDs). You can switch between profiles during an interactive session via the "Switch configuration" menu option.

### Usage Examples

Check the current status of a configuration:

```bash
failure-lambda status --param /my-app/failure-config --region eu-north-1
```

Enable latency injection interactively (prompts for percentage, min/max latency):

```bash
failure-lambda enable latency --param /my-app/failure-config
```

Disable all failure modes:

```bash
failure-lambda disable --all --param /my-app/failure-config
```

Use AppConfig as the configuration source:

```bash
failure-lambda status --app myApp --env myEnv --profile myProfile --region eu-north-1
```

Run in fully interactive mode (no flags needed if you have saved profiles):

```bash
failure-lambda
```

## Logging

All log output is structured JSON, making it easy to query in CloudWatch Logs Insights or any log aggregation tool. Every entry includes a `source` and `level` field, plus mode-specific details:

```json
{"source":"failure-lambda","level":"info","action":"config","config_source":"ssm","cache_ttl_seconds":60,"enabled_flags":["latency","denylist"]}
{"source":"failure-lambda","level":"info","mode":"latency","action":"inject","latency_ms":237,"min_latency":100,"max_latency":400}
{"source":"failure-lambda","level":"info","mode":"denylist","action":"block","hostname":"s3.us-east-1.amazonaws.com"}
{"source":"failure-lambda","level":"info","mode":"statuscode","action":"inject","status_code":503}
{"source":"failure-lambda","level":"warn","mode":"corruption","message":"response has no body field; wrapping in { body }"}
```

Example CloudWatch Logs Insights query:

```
fields @timestamp, mode, action
| filter source = "failure-lambda"
| sort @timestamp desc
```

## Advanced Usage

### Named Imports

```ts
import { injectFailure, getConfig, validateFlagValue, resolveFailures, parseFlags, getNestedValue, matchesConditions } from "failure-lambda";
import type { FlagValue, FailureFlagsConfig, ResolvedFailure, FailureMode, MatchCondition, MatchOperator } from "failure-lambda";

export const handler = injectFailure(async (event, context) => {
  // your handler logic
});
```

### Custom Config Provider

For testing or custom configuration backends, provide your own config provider:

```ts
import { injectFailure } from "failure-lambda";
import type { FailureFlagsConfig } from "failure-lambda";

const myConfigProvider = async (): Promise<FailureFlagsConfig> => {
  return {
    latency: { enabled: true, percentage: 50, min_latency: 200, max_latency: 500 },
    exception: { enabled: false },
  };
};

export const handler = injectFailure(
  async (event, context) => {
    return { statusCode: 200, body: "OK" };
  },
  { configProvider: myConfigProvider }
);
```

**Note:** A custom `configProvider` bypasses the built-in SSM/AppConfig caching — your provider is called on every invocation. If you use this in production, implement your own caching.

### Dry Run Mode

Log which failures would fire without actually injecting them. Useful for validating your configuration in production before enabling real fault injection:

```ts
import { injectFailure } from "failure-lambda";

export const handler = injectFailure(
  async (event, context) => {
    return { statusCode: 200, body: "OK" };
  },
  { dryRun: true }
);
```

In dry run mode, the library evaluates all enabled flags, rolls the percentage dice, checks match conditions, and logs a `"dryrun"` action for each failure that would have fired — but never actually injects faults. The handler always runs normally.

```json
{"source":"failure-lambda","level":"info","mode":"latency","action":"dryrun","percentage":50}
{"source":"failure-lambda","level":"info","mode":"exception","action":"dryrun","percentage":100}
```

The Middy middleware also supports `{ dryRun: true }`.

### Config Validation

```ts
import { validateFlagValue } from "failure-lambda";

const errors = validateFlagValue("latency", {
  enabled: true,
  percentage: 150, // invalid: must be 0-100
});
// errors: [{ field: "latency.percentage", message: "must be an integer between 0 and 100", value: 150 }]
```

### Resolving Active Failures

```ts
import { resolveFailures } from "failure-lambda";
import type { FailureFlagsConfig } from "failure-lambda";

const config: FailureFlagsConfig = {
  latency: { enabled: true, percentage: 50, min_latency: 100, max_latency: 400 },
  exception: { enabled: false },
  denylist: { enabled: true, deny_list: ["s3.*.amazonaws.com"] },
};

const failures = resolveFailures(config);
// [
//   { mode: "latency", percentage: 50, flag: { enabled: true, ... } },
//   { mode: "denylist", percentage: 100, flag: { enabled: true, ... } },
// ]
```

## Examples

The `examples` directory contains sample applications for deploying failure-lambda with different tools and runtimes. The SAM example is the most complete — it covers both SSM and AppConfig, and includes both a wrapper handler and a Middy middleware handler.

### Lambda Layer (SAM)

The `examples/layer/` directory contains a SAM template with example Node.js and Python functions. Download and publish the layer first following the [getting started steps](#getting-started-lambda-layer), then deploy passing in the layer ARN:

```bash
cd examples/layer
sam build
sam deploy --guided --parameter-overrides FailureLambdaLayerArn=<your-layer-arn>
```

### AWS SAM

The SAM example supports both SSM and AppConfig via a `ConfigSource` parameter, and includes both a wrapper handler (`/`) and a Middy middleware handler (`/middy`):

```bash
cd examples/sam
npm install
sam build

# Deploy with SSM (default)
sam deploy --guided

# Deploy with AppConfig Feature Flags (provide your region's layer ARN)
sam deploy --guided --parameter-overrides \
  ConfigSource=AppConfig \
  AppConfigExtensionLayerArn=arn:aws:lambda:eu-west-1:434848589818:layer:AWS-AppConfig-Extension:128
```

Find the AppConfig extension layer ARN for your region at the [AWS documentation](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions-versions.html).

### AWS CDK

```bash
cd examples/cdk
npm install
cdk deploy
```

### Serverless Framework

```bash
cd examples/sls
npm install
sls deploy
```

## Migration from 0.x

### Breaking Changes

- **Node.js 20+ required.** Lambda runtimes `nodejs14.x`, `nodejs16.x`, and `nodejs18.x` are no longer supported.
- **AWS SDK v3.** The library now uses `@aws-sdk/client-ssm` instead of `aws-sdk` v2. No user action needed — IAM permissions remain the same.
- **`node-fetch` removed.** If your code depended on `node-fetch` being available transitively, install it separately.
- **ESM-first package.** The package now ships as ESM with a CJS fallback. Both `import` and `require()` continue to work.
- **New configuration format.** The flat `{isEnabled, failureMode, rate, ...}` config is replaced by a feature-flag model where each failure mode is an independent flag. See [Configuration](#configuration) above.

### New Features

- **TypeScript.** Full type definitions included out of the box.
- **Multiple simultaneous failures.** Enable latency + denylist + diskspace all at once.
- **AppConfig Feature Flags.** Native support for `AWS.AppConfig.FeatureFlags` profile type.
- **Configuration caching.** SSM responses are cached (60s default TTL), reducing latency and API costs. AppConfig caching is handled by the extension layer.
- **Config validation.** Invalid configuration is caught and logged with clear error messages.
- **Named exports.** `injectFailure`, `getConfig`, `validateFlagValue`, `resolveFailures`, `parseFlags` available as named imports.
- **Custom config provider.** Pass `{ configProvider }` option for testing or custom backends.

### Config Migration

Old format:

```json
{"isEnabled": true, "failureMode": "latency", "rate": 1, "minLatency": 100, "maxLatency": 400}
```

New format:

```json
{
  "latency": {"enabled": true, "percentage": 100, "min_latency": 100, "max_latency": 400}
}
```

### Upgrading

```bash
npm install failure-lambda@1
```

The wrapper API is unchanged — `failureLambda(handler)` works exactly as before. Update your SSM parameter or AppConfig configuration to the new format.

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/gunnargrosch/failure-lambda/issues) or submit a pull request.

## Acknowledgments

Inspired by [Yan Cui's articles on latency injection for AWS Lambda](https://hackernoon.com/chaos-engineering-and-aws-lambda-latency-injection-ddeb4ff8d983) and [Adrian Hornsby's chaos injection library for Python](https://github.com/adhorn/aws-lambda-chaos-injection/).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed list of changes.

## License

[MIT](LICENSE)
