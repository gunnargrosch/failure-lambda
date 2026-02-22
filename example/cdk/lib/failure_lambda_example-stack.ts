import { Stack, StackProps, RemovalPolicy } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export class FailureLambdaExampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const failureLambdaParameter = new ssm.StringParameter(this, "failureLambdaParameter", {
      stringValue: JSON.stringify({
        latency: { enabled: false, rate: 1, min_latency: 100, max_latency: 400 },
        exception: { enabled: false, rate: 1, exception_msg: "Exception message!" },
        statuscode: { enabled: false, rate: 1, status_code: 404 },
        diskspace: { enabled: false, rate: 1, disk_space: 100 },
        denylist: { enabled: false, rate: 1, deny_list: ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"] },
      }),
    });

    const failureLambdaTable = new dynamodb.Table(this, "failureLambdaTable", {
      removalPolicy: RemovalPolicy.DESTROY,
      partitionKey: { name: "id", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const failureLambdaFunction = new lambdaNode.NodejsFunction(this, "failureLambdaFunction", {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: "handler",
      entry: `${__dirname}/resources/handler.ts`,
      environment: {
        FAILURE_INJECTION_PARAM: failureLambdaParameter.parameterName,
        FAILURE_INJECTION_TABLE: failureLambdaTable.tableName,
      },
      bundling: {
        nodeModules: ["failure-lambda"],
      },
    });

    new apigateway.LambdaRestApi(this, "failureLambdaApi", {
      handler: failureLambdaFunction,
    });

    failureLambdaParameter.grantRead(failureLambdaFunction);
    failureLambdaTable.grantWriteData(failureLambdaFunction);
  }
}
