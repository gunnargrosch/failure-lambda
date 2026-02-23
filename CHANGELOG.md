# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [1.0.0] - 2026-02-22

Rewritten in TypeScript with a feature flag configuration model.

### Added

- TypeScript rewrite with full type definitions
- Feature flag configuration model — each failure mode is an independent flag; multiple can be active simultaneously
- `timeout` and `corruption` failure modes
- Event-based targeting via `match` conditions with `eq`, `exists`, `startsWith`, and `regex` operators
- Native AppConfig Feature Flags support with auto-disabled library cache (the extension already caches)
- Middy middleware via `failure-lambda/middy` subpath export
- `FAILURE_LAMBDA_DISABLED` env var kill switch and `dryRun` option
- `configProvider` option for custom config backends
- Configuration validation with structured JSON logging, including ReDoS detection for regex patterns and a `disk_space` cap at Lambda's 10 GB `/tmp` limit
- Exported `getConfig`, `validateFlagValue`, `resolveFailures`, `parseFlags`, and type definitions
- CLI tool (`failure-lambda` command) for managing configuration interactively or via flags — supports `status`, `enable`, `disable`, and `disable --all` commands with SSM Parameter Store and AppConfig backends
- Named CLI profiles saved to `~/.failure-lambda.json` for quick access to different configurations
- Lambda Layer with Rust proxy for zero-code fault injection across any runtime (Node.js, Python, Java, Go) — deploy as a layer, set `AWS_LAMBDA_EXEC_WRAPPER`, no code changes required
- DNS denylist interception via LD_PRELOAD shared library in the layer
- Cross-architecture layer support (x86_64, arm64) with example SAM template

### Changed

- AWS SDK v3, native `fetch()`, `dns.lookup` monkey-patching (replaces `aws-sdk` v2, `node-fetch`, `mitm`)
- Dual CJS/ESM package output; minimum Node.js 18
- Examples updated to Node.js 22, SDK v3; SAM example includes wrapper and Middy variants

### Fixed

- Invalid denylist regex patterns are caught and skipped instead of crashing
- Diskspace `dd` errors logged; correct `* 1024` byte calculation for MB
- Out-of-range `percentage` values clamped to `[0, 100]`
- SAM example AppConfig layer ARN is now a parameter instead of a hardcoded region-specific ARN
- SAM example esbuild configuration updated for correct ESM output
- Skip `runPreHandlerInjections` when no failures are active, eliminating async overhead with AppConfig extension
- Return well-formed API Gateway response from `statuscode` mode (avoids 502 errors)
- Rename `source` to `config_source` in config log entry to avoid overwriting the top-level `source` field
- Skip flags with any validation errors instead of partially applying them (fail-closed)

### Removed

- `node-fetch` and `mitm` dependencies
- Support for Node.js < 18
- Flat `{isEnabled, failureMode, ...}` configuration format (0.x)

## [0.4.4] - 2022-02-14

### Changed

- Switch to node-fetch@2

## [0.4.3] - 2022-02-14

### Added

- MIT license file
- New sample applications for SAM, CDK, and Serverless Framework

### Changed

- Updated dependencies

## [0.4.2] - 2021-03-16

### Fixed

- Fixed mitm listener state management to prevent traffic leaking through during enable/disable
- Fixed mitm not disabling when no longer needed
- Moved mitm object to library global namespace so that it persists across function invocations

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
