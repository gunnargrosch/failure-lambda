# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-02-22

Rewritten in TypeScript with a feature flag configuration model.

### Added

- Full TypeScript type definitions included out of the box
- Feature flag configuration model — each failure mode is an independent flag
- Multiple simultaneous failures supported
- Native AppConfig Feature Flags (`AWS.AppConfig.FeatureFlags`) support
- In-memory configuration caching with configurable TTL
- Configuration validation with clear error messages, including regex compilation checks for denylist patterns
- `configProvider` option for custom config backends
- Exported `getConfig`, `validateFlagValue`, `resolveFailures`, `parseFlags`, and type definitions
- `timeout` failure mode — sleeps until Lambda timeout minus configurable buffer
- `corruption` failure mode — replaces or mangles handler response body (post-handler)
- Event-based targeting via `match` conditions on any flag
- Middy middleware integration via `failure-lambda/middy` subpath export
- Structured JSON logging — all log output is machine-parseable with `source`, `level`, `mode`, and `action` fields
- GitHub Actions CI workflow with Node.js 18/20/22 matrix
- SAM example supports both SSM and AppConfig via parameter

### Changed

- Migrated from AWS SDK v2 to v3 (`@aws-sdk/client-ssm`)
- Replaced `node-fetch` with native `fetch()` (Node.js 18+)
- Replaced `mitm` with `dns.lookup` monkey-patching for denylist failure mode
- Dual CJS/ESM package output
- Wrapper and Middy middleware share a single orchestration module
- Updated examples to Node.js 22 and SDK v3
- Minimum Node.js version: 18

### Fixed

- Invalid denylist regex patterns are caught and skipped with a warning instead of crashing the invocation
- `matchesConditions` no longer matches `null`/`undefined` values against `"null"`/`"undefined"` strings
- Corruption mode wraps in `{ body }` when result has no body field instead of returning raw string
- Diskspace injection logs errors when `dd` exits with non-zero status and uses correct `* 1024` for MB calculation
- Out-of-range `rate` values are clamped to `[0, 1]` instead of silently misbehaving
- ESLint configuration includes test files and all lint errors resolved
- Coverage thresholds now include the main wrapper (`src/index.ts`)
- CDK example updated to modern dependencies; timeout and corruption modes added to CDK and Serverless examples

### Removed

- `node-fetch` dependency
- `mitm` dependency
- Support for Node.js < 18 (`nodejs14.x`, `nodejs16.x`)
- Flat `{isEnabled, failureMode, rate, ...}` configuration format (replaced by feature flag model)

## [0.4.4] - 2022-02-14

### Changed

- Switch to node-fetch@2

## [0.4.3] - 2022-02-14

### Changed

- Updated dependencies

## [0.4.2] - 2021-03-16

### Fixed

- Puts the mitm object in the library global namespace so that it persists across function invocations

### Changed

- Syntax formatting

## [0.4.1] - 2020-10-26

### Added

- Made AppConfig Lambda extension port configurable using environment variable

## [0.4.0] - 2020-10-25

### Added

- Optional support for AWS AppConfig, allowing to validate failure configuration, deploy configuration using gradual or non-gradual deploy strategy, monitor deployed configuration with automatic rollback if CloudWatch Alarms is configured, and caching of configuration
- Hardcoded default configuration with `isEnabled: false`, to use if issues loading configuration from Parameter Store or AppConfig

## [0.3.1] - 2020-10-21

### Fixed

- Change mitm mode back to connect to fix issue with all connections being blocked

## [0.3.0] - 2020-08-24

### Changed

- Changed mitm mode from connect to connection for quicker enable/disable of failure injection
- Renamed block list failure injection to denylist (**breaking change** for that failure mode)
- Updated dependencies

## [0.2.0] - 2020-02-17

### Added

- Block list failure
- Updated example application to store file in S3 and item in DynamoDB

## [0.1.1] - 2020-02-13

### Fixed

- Fixed issue with exception injection not throwing the exception

## [0.1.0] - 2019-12-30

### Added

- Disk space failure
- Updated example application to store example file in tmp

## [0.0.1] - 2019-12-23

### Added

- Initial release
