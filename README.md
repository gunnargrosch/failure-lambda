# Failure injection for AWS Lambda - failure-lambda

## Description

`failure-lambda` is a small Node module for injecting failure into AWS Lambda (https://aws.amazon.com/lambda). It offers a simple failure injection wrapper for your Lambda handler where you then can choose to inject failure by setting the `failureMode` to `latency`, `exception`, `denylist`, `diskspace` or `statuscode`. You control your failure injection using SSM Parameter Store or [AWS AppConfig](https://docs.aws.amazon.com/appconfig/latest/userguide/what-is-appconfig.html).

## How to install with parameter in SSM Parameter Store

1. Install `failure-lambda` module using NPM.
```bash
npm install failure-lambda
```
2. Add the module to your Lambda function code.
```js
const failureLambda = require('failure-lambda')
```
3. Wrap your handler.
```js
exports.handler = failureLambda(async (event, context) => {
  ...
})
```
4. Create a parameter in SSM Parameter Store.
```json
{"isEnabled": false, "failureMode": "latency", "rate": 1, "minLatency": 100, "maxLatency": 400, "exceptionMsg": "Exception message!", "statusCode": 404, "diskSpace": 100, "denylist": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]}
```
```bash
aws ssm put-parameter --region eu-west-1 --name failureLambdaConfig --type String --overwrite --value "{\"isEnabled\": false, \"failureMode\": \"latency\", \"rate\": 1, \"minLatency\": 100, \"maxLatency\": 400, \"exceptionMsg\": \"Exception message!\", \"statusCode\": 404, \"diskSpace\": 100, \"denylist\": [\"s3.*.amazonaws.com\", \"dynamodb.*.amazonaws.com\"]}"
```
5. Add an environment variable to your Lambda function with the key FAILURE_INJECTION_PARAM and the value set to the name of your parameter in SSM Parameter Store.
6. Add permissions to the parameter for your Lambda function.
7. Try it out!

## How to install with hosted configuration in AWS AppConfig

1. Install `failure-lambda` module using NPM.
```bash
npm install failure-lambda
```
2. Add the module to your Lambda function code.
```js
const failureLambda = require('failure-lambda')
```
3. Wrap your handler.
```js
exports.handler = failureLambda(async (event, context) => {
  ...
})
```
4. Create Application, Environment, Configuration Profile, and Hosted Configuration in AppConfig console.
5. Deploy a version of the configuration.
6. Add the AWS AppConfig layer for Lambda extensions to your Lambda function. [See details](https://docs.aws.amazon.com/appconfig/latest/userguide/appconfig-integration-lambda-extensions.html).
7. Add environment variables to your Lambda function.
```bash
FAILURE_APPCONFIG_APPLICATION: YOUR APPCONFIG APPLICATION
FAILURE_APPCONFIG_ENVIRONMENT: YOUR APPCONFIG ENVIRONMENT
FAILURE_APPCONFIG_CONFIGURATION: YOUR APPCONFIG CONFIGURATION PROFILE
```
8. Add permissions to the AppConfig Application, Environment, and Configuration Profile for your Lambda function.
9. Try it out!

## Usage

Edit the values of your parameter in SSM Parameter Store or hosted configuration in AWS AppConfig to use the failure injection module.

* `isEnabled: true` means that failure is injected into your Lambda function.
* `isEnabled: false` means that the failure injection module is disabled and no failure is injected.
* `failureMode` selects which failure you want to inject. The options are `latency`, `exception`, `denylist`, `diskspace` or `statuscode` as explained below.
* `rate` controls the rate of failure. 1 means that failure is injected on all invocations and 0.5 that failure is injected on about half of all invocations.
* `minLatency` and `maxLatency` is the span of latency in milliseconds injected into your function when `failureMode` is set to `latency`.
* `exceptionMsg` is the message thrown with the exception created when `failureMode` is set to `exception`.
* `statusCode` is the status code returned by your function when `failureMode` is set to `statuscode`.
* `diskSpace` is size in MB of the file created in tmp when `failureMode` is set to `diskspace`.
* `denylist` is an array of regular expressions, if a connection is made to a host matching one of the regular expressions it will be blocked.

## Example

In the subfolder `example` is a sample application which will install an AWS Lambda function, an Amazon DynamoDB table, and a parameter in SSM Parameter Store. You can install it using AWS SAM, AWS CDK, or Serverless Framework.

### AWS SAM
```bash
cd example/sam
npm install
sam build
sam deploy --guided
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

## Notes

Inspired by Yan Cui's articles on latency injection for AWS Lambda (https://hackernoon.com/chaos-engineering-and-aws-lambda-latency-injection-ddeb4ff8d983) and Adrian Hornsby's chaos injection library for Python (https://github.com/adhorn/aws-lambda-chaos-injection/).

## Changelog

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