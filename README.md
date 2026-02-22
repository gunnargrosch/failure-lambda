# Failure injection for AWS Lambda - failure-lambda

## Description

`failure-lambda` is a Node.js module for injecting failure into [AWS Lambda](https://aws.amazon.com/lambda). It offers a simple failure injection wrapper for your Lambda handler where each failure mode is an independent feature flag: `latency`, `exception`, `denylist`, `diskspace`, and `statuscode`. Multiple failure modes can be active simultaneously. You control your failure injection using [SSM Parameter Store](https://docs.aws.amazon.com/systems-manager/latest/userguide/systems-manager-parameter-store.html) or [AWS AppConfig Feature Flags](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-creating-configuration-and-profile-feature-flags.html).

**v1.0.0** is a major release with breaking changes. See [Migration from 0.x](#migration-from-0x) below.

## Requirements

- Node.js >= 18
- AWS Lambda runtime `nodejs18.x`, `nodejs20.x`, or `nodejs22.x`

## Installation

```bash
npm install failure-lambda
```

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
import type { FlagValue, FailureFlagsConfig, ResolvedFailure, FailureMode } from "failure-lambda";

export const handler = injectFailure(async (event, context) => {
  // your handler logic
});
```

## Configuration Format

Each failure mode is an independent feature flag. Multiple modes can be enabled at the same time. This format is used by both SSM Parameter Store and AppConfig.

```json
{
  "latency": { "enabled": true, "rate": 1, "min_latency": 100, "max_latency": 400 },
  "exception": { "enabled": false, "rate": 1, "exception_msg": "Exception message!" },
  "statuscode": { "enabled": false, "rate": 1, "status_code": 404 },
  "diskspace": { "enabled": false, "rate": 1, "disk_space": 100 },
  "denylist": { "enabled": true, "rate": 0.5, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"] }
}
```

When a flag is disabled, only `{"enabled": false}` is needed — attributes are optional. When enabled, `rate` defaults to `1` if omitted.

### Flag Attributes

| Flag | Attribute | Type | Description |
|------|-----------|------|-------------|
| *all* | `enabled` | `boolean` | Enable/disable this failure mode |
| *all* | `rate` | `number` | Probability of injection (0-1). Default: `1` |
| `latency` | `min_latency` | `number` | Minimum latency in ms |
| `latency` | `max_latency` | `number` | Maximum latency in ms |
| `exception` | `exception_msg` | `string` | Error message thrown |
| `statuscode` | `status_code` | `number` | HTTP status code returned (100-599) |
| `diskspace` | `disk_space` | `number` | MB of disk to fill in `/tmp` |
| `denylist` | `deny_list` | `string[]` | Regex patterns; matching hosts are blocked |

### Injection Order

When multiple modes are enabled, non-terminating failures run first, then terminating failures short-circuit:

1. `latency` — adds delay, then continues
2. `diskspace` — fills `/tmp`, then continues
3. `denylist` — blocks matching network hosts, then continues
4. `statuscode` — returns status code response, **skips handler**
5. `exception` — throws error, **skips handler**

Each flag's `rate` is rolled independently.

## Configuration Sources

### SSM Parameter Store

1. Create a parameter in SSM Parameter Store with the feature flag JSON:
```bash
aws ssm put-parameter --region eu-west-1 --name failureLambdaConfig --type String --overwrite --value '{
  "latency": {"enabled": false, "rate": 1, "min_latency": 100, "max_latency": 400},
  "exception": {"enabled": false, "rate": 1, "exception_msg": "Exception message!"},
  "statuscode": {"enabled": false, "rate": 1, "status_code": 404},
  "diskspace": {"enabled": false, "rate": 1, "disk_space": 100},
  "denylist": {"enabled": false, "rate": 1, "deny_list": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]}
}'
```
2. Add an environment variable to your Lambda function: `FAILURE_INJECTION_PARAM` set to the parameter name.
3. Add `ssm:GetParameter` permission for your Lambda function.

### AWS AppConfig Feature Flags

AppConfig's native `AWS.AppConfig.FeatureFlags` profile type is a natural fit — each failure mode maps to a feature flag with typed attributes and built-in validation.

1. Create an Application, Environment, and Configuration Profile (type: `AWS.AppConfig.FeatureFlags`) in the AppConfig console.
2. Define flags for each failure mode (`latency`, `exception`, `statuscode`, `diskspace`, `denylist`) with their attributes.
3. Deploy a version of the configuration.
4. Add the [AWS AppConfig Lambda extension layer](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions.html) to your Lambda function.
5. Add environment variables:
```
FAILURE_APPCONFIG_APPLICATION: YOUR APPCONFIG APPLICATION
FAILURE_APPCONFIG_ENVIRONMENT: YOUR APPCONFIG ENVIRONMENT
FAILURE_APPCONFIG_CONFIGURATION: YOUR APPCONFIG CONFIGURATION PROFILE
```
6. Add permissions for your Lambda function to access the AppConfig resources (`appconfig:StartConfigurationSession` and `appconfig:GetLatestConfiguration`).

The AppConfig extension returns the feature flags in the same JSON shape the library expects — no transformation needed.

## Configuration Caching

Configuration is cached in memory to reduce latency and API calls. The cache persists within a single Lambda container and resets on cold starts.

| Environment Variable | Default | Description |
|---------------------|---------|-------------|
| `FAILURE_CACHE_TTL` | `60` | Cache TTL in seconds. Set to `0` to disable caching. |

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

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `FAILURE_INJECTION_PARAM` | For SSM | SSM Parameter Store parameter name |
| `FAILURE_APPCONFIG_APPLICATION` | For AppConfig | AppConfig application name |
| `FAILURE_APPCONFIG_ENVIRONMENT` | For AppConfig | AppConfig environment name |
| `FAILURE_APPCONFIG_CONFIGURATION` | For AppConfig | AppConfig configuration profile name |
| `AWS_APPCONFIG_EXTENSION_HTTP_PORT` | No | AppConfig extension port (default: `2772`) |
| `FAILURE_CACHE_TTL` | No | Config cache TTL in seconds (default: `60`) |

## Examples

In the `example` subfolder are sample applications with an AWS Lambda function, Amazon DynamoDB table, and SSM Parameter Store parameter. You can deploy using AWS SAM, AWS CDK, or Serverless Framework.

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
- **New configuration format.** The flat `{isEnabled, failureMode, rate, ...}` config is replaced by a feature-flag model where each failure mode is an independent flag. See [Configuration Format](#configuration-format) above.

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

## Notes

Inspired by Yan Cui's articles on latency injection for AWS Lambda (https://hackernoon.com/chaos-engineering-and-aws-lambda-latency-injection-ddeb4ff8d983) and Adrian Hornsby's chaos injection library for Python (https://github.com/adhorn/aws-lambda-chaos-injection/).

## Changelog

### 2026-02-22 v1.0.0

* Rewritten in TypeScript with full type definitions.
* Feature flag configuration model — each failure mode is an independent flag.
* Multiple simultaneous failures supported.
* Native AppConfig Feature Flags (`AWS.AppConfig.FeatureFlags`) support.
* Migrated from AWS SDK v2 to v3 (`@aws-sdk/client-ssm`).
* Replaced `node-fetch` with native `fetch()` (Node.js 18+).
* Added in-memory configuration caching with configurable TTL.
* Added configuration validation with clear error messages.
* Dual CJS/ESM package output.
* Added `configProvider` option for custom config backends.
* Exported `getConfig`, `validateFlagValue`, `resolveFailures`, `parseFlags`, and type definitions.
* Updated examples to Node.js 22 and SDK v3.
* SAM example supports both SSM and AppConfig via parameter.
* Minimum Node.js version: 18.

### 2022-02-14 v0.4.4

* Switch to node-fetch@2.

### 2022-02-14 v0.4.3

* Updated dependencies.

### 2021-03-16 v0.4.2

* Puts the mitm object in the library global namespace so that it persists across function invocations.
* Syntax formatting.

### 2020-10-26 v0.4.1

* Made AppConfig Lambda extension port configurable using environment variable.

### 2020-10-25 v0.4.0

* Added optional support for AWS AppConfig, allowing to validate failure configuration, deploy configuration using gradual or non-gradual deploy strategy, monitor deployed configuration with automatical rollback if CloudWatch Alarms is configured, and caching of configuration.
* Hardcoded default configuration with `isEnabled: false`, to use if issues loading configuration from Parameter Store or AppConfig.

### 2020-10-21 v0.3.1

* Change mitm mode back to connect to fix issue with all connections being blocked.

### 2020-08-24 v0.3.0

* Changed mitm mode from connect to connection for quicker enable/disable of failure injection.
* Renamed block list failure injection to denylist (breaking change for that failure mode).
* Updated dependencies.

### 2020-02-17 v0.2.0

* Added block list failure.
* Updated example application to store file in S3 and item in DynamoDB.

### 2020-02-13 v0.1.1

* Fixed issue with exception injection not throwing the exception.

### 2019-12-30 v0.1.0

* Added disk space failure.
* Updated example application to store example file in tmp.

### 2019-12-23 v0.0.1

* Initial release

## Contributors

**Gunnar Grosch** - [GitHub](https://github.com/gunnargrosch) | [Twitter](https://twitter.com/gunnargrosch) | [LinkedIn](https://www.linkedin.com/in/gunnargrosch/)

**Jason Barto** - [GitHub](https://github.com/jpbarto) | [Twitter](https://twitter.com/Jason_Barto) | [LinkedIn](https://www.linkedin.com/in/jasonbarto)

## License

This code is made available under the MIT-0 license. See the LICENSE file.
