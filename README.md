# failure-lambda

[![npm version](https://img.shields.io/npm/v/failure-lambda.svg)](https://www.npmjs.com/package/failure-lambda)
[![CI](https://github.com/gunnargrosch/failure-lambda/actions/workflows/ci.yml/badge.svg)](https://github.com/gunnargrosch/failure-lambda/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/failure-lambda.svg)](LICENSE)
[![node](https://img.shields.io/node/v/failure-lambda.svg)](package.json)

Failure injection for AWS Lambda — chaos engineering made simple. Wrap your handler and control failure injection with feature flags via SSM Parameter Store or AWS AppConfig.

> **v1.0.0** is a major release with breaking changes. See [Migration from 0.x](#migration-from-0x).

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Failure Modes](#failure-modes)
- [Configuration](#configuration)
- [Configuration Sources](#configuration-sources)
- [Environment Variables](#environment-variables)
- [Logging](#logging)
- [Advanced Usage](#advanced-usage)
- [Examples](#examples)
- [Migration from 0.x](#migration-from-0x)
- [Contributing](#contributing)
- [Acknowledgments](#acknowledgments)
- [License](#license)

## Installation

```bash
npm install failure-lambda
```

**Requirements:** Node.js >= 18 — Lambda runtimes `nodejs18.x`, `nodejs20.x`, or `nodejs22.x`.

## Quick Start

### ESM (recommended)

```ts
import failureLambda from "failure-lambda";

export const handler = failureLambda(async (event, context) => {
  // your handler logic
  return { statusCode: 200, body: "OK" };
});
```

### CommonJS

```js
const failureLambda = require("failure-lambda");

exports.handler = failureLambda(async (event, context) => {
  // your handler logic
  return { statusCode: 200, body: "OK" };
});
```

### Named imports

```ts
import { injectFailure, getConfig, validateFlagValue, resolveFailures } from "failure-lambda";
import type { FlagValue, FailureFlagsConfig, ResolvedFailure, FailureMode, MatchCondition, MatchOperator } from "failure-lambda";

export const handler = injectFailure(async (event, context) => {
  // your handler logic
});
```

### Middy middleware

If you use [Middy](https://middy.js.org/) (v4+), integrate via the `failure-lambda/middy` subpath export instead of wrapping your handler:

```ts
import middy from "@middy/core";
import { failureLambdaMiddleware } from "failure-lambda/middy";

export const handler = middy()
  .use(failureLambdaMiddleware())
  .handler(async (event, context) => {
    return { statusCode: 200, body: "OK" };
  });
```

The middleware runs pre-handler failures in its `before` phase and post-handler failures (corruption) in its `after` phase. It supports the same `configProvider` option as the wrapper.

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

Multiple modes can be active simultaneously. Each mode is an independent feature flag with its own `rate` (probability of injection).

## Configuration

Each failure mode is an independent feature flag. This format is used by both SSM Parameter Store and AppConfig.

```json
{
  "latency": { "enabled": true, "rate": 1, "min_latency": 100, "max_latency": 400 },
  "exception": { "enabled": false, "rate": 1, "exception_msg": "Exception message!" },
  "statuscode": { "enabled": false, "rate": 1, "status_code": 404 },
  "diskspace": { "enabled": false, "rate": 1, "disk_space": 100 },
  "denylist": { "enabled": true, "rate": 0.5, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"] },
  "timeout": { "enabled": false, "rate": 1, "timeout_buffer_ms": 500 },
  "corruption": { "enabled": false, "rate": 0.3, "body": "{\"error\": \"corrupted\"}" }
}
```

When a flag is disabled, only `{"enabled": false}` is needed — attributes are optional. When enabled, `rate` defaults to `1` if omitted.

### Flag Attributes

| Flag | Attribute | Type | Description |
|------|-----------|------|-------------|
| *all* | `enabled` | `boolean` | Enable/disable this failure mode |
| *all* | `rate` | `number` | Probability of injection (0-1). Default: `1` |
| *all* | `match` | `object[]` | Event-based targeting conditions (see below) |
| `latency` | `min_latency` | `number` | Minimum latency in ms |
| `latency` | `max_latency` | `number` | Maximum latency in ms |
| `exception` | `exception_msg` | `string` | Error message thrown |
| `statuscode` | `status_code` | `number` | HTTP status code returned (100-599) |
| `diskspace` | `disk_space` | `number` | MB of disk to fill in `/tmp` |
| `denylist` | `deny_list` | `string[]` | Regex patterns; matching hosts are blocked |
| `timeout` | `timeout_buffer_ms` | `number` | Buffer in ms before Lambda timeout. Default: `0` |
| `corruption` | `body` | `string` | Replacement response body. If omitted, body is mangled. |

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

Each flag's `rate` is rolled independently.

### Event-Based Targeting

Any flag can include a `match` array to restrict injection to events matching specific conditions. Each condition specifies a dot-separated `path` into the event. All conditions must match for the flag to fire.

```json
{
  "corruption": {
    "enabled": true,
    "rate": 0.3,
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
    "rate": 1,
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

## Configuration Sources

Configuration is cached in memory to reduce latency and API calls. The cache persists within a single Lambda container, resets on cold starts, and defaults to a 60-second TTL (configurable via `FAILURE_CACHE_TTL`).

### SSM Parameter Store

1. Create a parameter in SSM Parameter Store with the feature flag JSON (see example below).
2. Add an environment variable to your Lambda function: `FAILURE_INJECTION_PARAM` set to the parameter name.
3. Add `ssm:GetParameter` permission for your Lambda function.

```bash
aws ssm put-parameter --region eu-west-1 --name failureLambdaConfig --type String --overwrite --value '{
  "latency": {"enabled": false, "rate": 1, "min_latency": 100, "max_latency": 400},
  "exception": {"enabled": false, "rate": 1, "exception_msg": "Exception message!"},
  "statuscode": {"enabled": false, "rate": 1, "status_code": 404},
  "diskspace": {"enabled": false, "rate": 1, "disk_space": 100},
  "denylist": {"enabled": false, "rate": 1, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]},
  "timeout": {"enabled": false, "rate": 1, "timeout_buffer_ms": 500},
  "corruption": {"enabled": false, "rate": 1, "body": "{\"error\": \"corrupted\"}"}
}'
```

### AWS AppConfig Feature Flags

AppConfig's native `AWS.AppConfig.FeatureFlags` profile type is a natural fit — each failure mode maps to a feature flag with typed attributes and built-in validation.

1. Create an Application, Environment, and Configuration Profile (type: `AWS.AppConfig.FeatureFlags`) in the AppConfig console.
2. Define flags for each failure mode (`latency`, `exception`, `statuscode`, `diskspace`, `denylist`, `timeout`, `corruption`) with their attributes.
3. Deploy a version of the configuration.
4. Add the [AWS AppConfig Lambda extension layer](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions.html) to your Lambda function.
5. Add environment variables: `FAILURE_APPCONFIG_APPLICATION`, `FAILURE_APPCONFIG_ENVIRONMENT`, and `FAILURE_APPCONFIG_CONFIGURATION` (see [Environment Variables](#environment-variables)).
6. Add permissions for your Lambda function to access the AppConfig resources (`appconfig:StartConfigurationSession` and `appconfig:GetLatestConfiguration`).

The AppConfig extension returns the feature flags in the same JSON shape the library expects — no transformation needed.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAILURE_INJECTION_PARAM` | For SSM | SSM Parameter Store parameter name |
| `FAILURE_APPCONFIG_APPLICATION` | For AppConfig | AppConfig application name |
| `FAILURE_APPCONFIG_ENVIRONMENT` | For AppConfig | AppConfig environment name |
| `FAILURE_APPCONFIG_CONFIGURATION` | For AppConfig | AppConfig configuration profile name |
| `AWS_APPCONFIG_EXTENSION_HTTP_PORT` | No | AppConfig extension port (default: `2772`) |
| `FAILURE_CACHE_TTL` | No | Config cache TTL in seconds (default: `60`, set to `0` to disable) |
| `FAILURE_LAMBDA_DISABLED` | No | Set to `"true"` to bypass all failure injection (kill switch) |

## Logging

All log output is structured JSON, making it easy to query in CloudWatch Logs Insights or any log aggregation tool. Every entry includes a `source` and `level` field, plus mode-specific details:

```json
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

### Custom Config Provider

For testing or custom configuration backends, provide your own config provider:

```ts
import { injectFailure } from "failure-lambda";
import type { FailureFlagsConfig } from "failure-lambda";

const myConfigProvider = async (): Promise<FailureFlagsConfig> => {
  // fetch config from your custom source
  return {
    latency: { enabled: true, rate: 0.5, min_latency: 200, max_latency: 500 },
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

In dry run mode, the library evaluates all enabled flags, rolls the rate dice, checks match conditions, and logs a `"dryrun"` action for each failure that would have fired — but never actually injects faults. The handler always runs normally.

```json
{"source":"failure-lambda","level":"info","mode":"latency","action":"dryrun","rate":0.5}
{"source":"failure-lambda","level":"info","mode":"exception","action":"dryrun","rate":1}
```

The Middy middleware also supports `{ dryRun: true }`.

### Config Validation

```ts
import { validateFlagValue } from "failure-lambda";

const errors = validateFlagValue("latency", {
  enabled: true,
  rate: 1.5, // invalid: must be 0-1
});
// errors: [{ field: "latency.rate", message: "must be a number between 0 and 1", value: 1.5 }]
```

### Resolving Active Failures

```ts
import { resolveFailures } from "failure-lambda";
import type { FailureFlagsConfig } from "failure-lambda";

const config: FailureFlagsConfig = {
  latency: { enabled: true, rate: 0.5, min_latency: 100, max_latency: 400 },
  exception: { enabled: false },
  denylist: { enabled: true, deny_list: ["s3.*.amazonaws.com"] },
};

const failures = resolveFailures(config);
// [
//   { mode: "latency", rate: 0.5, flag: { enabled: true, ... } },
//   { mode: "denylist", rate: 1, flag: { enabled: true, ... } },
// ]
```

## Examples

The `example` directory contains sample applications with an AWS Lambda function, Amazon DynamoDB table, and SSM Parameter Store parameter. Deploy using AWS SAM, AWS CDK, or Serverless Framework.

### AWS SAM

The SAM example supports both SSM and AppConfig via a `ConfigSource` parameter:

```bash
cd example/sam
npm install
sam build

# Deploy with SSM (default)
sam deploy --guided

# Deploy with AppConfig Feature Flags
sam deploy --guided --parameter-overrides ConfigSource=AppConfig
```

### AWS CDK

```bash
cd example/cdk
npm install
cdk deploy
```

### Serverless Framework

```bash
cd example/sls
npm install
sls deploy
```

## Migration from 0.x

### Breaking Changes

- **Node.js 18+ required.** Lambda runtimes `nodejs14.x` and `nodejs16.x` are no longer supported.
- **AWS SDK v3.** The library now uses `@aws-sdk/client-ssm` instead of `aws-sdk` v2. No user action needed — IAM permissions remain the same.
- **`node-fetch` removed.** If your code depended on `node-fetch` being available transitively, install it separately.
- **ESM-first package.** The package now ships as ESM with a CJS fallback. Both `import` and `require()` continue to work.
- **New configuration format.** The flat `{isEnabled, failureMode, rate, ...}` config is replaced by a feature-flag model where each failure mode is an independent flag. See [Configuration](#configuration) above.

### New Features

- **TypeScript.** Full type definitions included out of the box.
- **Multiple simultaneous failures.** Enable latency + denylist + diskspace all at once.
- **AppConfig Feature Flags.** Native support for `AWS.AppConfig.FeatureFlags` profile type.
- **Configuration caching.** SSM/AppConfig responses are cached (60s default TTL), reducing latency and API costs.
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
  "latency": {"enabled": true, "rate": 1, "min_latency": 100, "max_latency": 400}
}
```

### Upgrading

```bash
npm install failure-lambda@1
```

The wrapper API is unchanged — `failureLambda(handler)` works exactly as before. Update your SSM parameter or AppConfig configuration to the new format.

## Contributing

Contributions are welcome. Please open an [issue](https://github.com/gunnargrosch/failure-lambda/issues) or submit a pull request.

**Contributors:**

- **Gunnar Grosch** — [GitHub](https://github.com/gunnargrosch) | [LinkedIn](https://www.linkedin.com/in/gunnargrosch/)
- **Jason Barto** — [GitHub](https://github.com/jpbarto) | [LinkedIn](https://www.linkedin.com/in/jasonbarto)
- **Daniel Reuter** — [GitHub](https://github.com/ReuDa)
- **Norbert Schneider** — [GitHub](https://github.com/bertschneider)

## Acknowledgments

Inspired by [Yan Cui's articles on latency injection for AWS Lambda](https://hackernoon.com/chaos-engineering-and-aws-lambda-latency-injection-ddeb4ff8d983) and [Adrian Hornsby's chaos injection library for Python](https://github.com/adhorn/aws-lambda-chaos-injection/).

## Changelog

See [CHANGELOG.md](CHANGELOG.md) for a detailed list of changes.

## License

[MIT](LICENSE)
