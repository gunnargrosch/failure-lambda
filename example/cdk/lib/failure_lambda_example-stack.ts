import { Stack, StackProps } from "aws-cdk-lib";
import { Construct } from "constructs";
import * as cdk from "aws-cdk-lib";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as lambdaNode from "aws-cdk-lib/aws-lambda-nodejs";
import * as apigateway from "aws-cdk-lib/aws-apigateway";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as dynamodb from "aws-cdk-lib/aws-dynamodb";

export class FailureLambdaExampleStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const failureLambdaParameter = new ssm.StringParameter(this, "failureLambdaParameter", {
        stringValue: '{"isEnabled": false, "failureMode": "latency", "rate": 1, "minLatency": 100, "maxLatency": 400, "exceptionMsg": "Exception message!", "statusCode": 404, "diskSpace": 100, "denylist": ["s3.*.amazonaws.com", "dynamodb.*.amazonaws.com"]}',
      }
    );
    const failureLambdaTable = new dynamodb.Table(this, "failureLambdaTable", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      partitionKey: { name: "id", type: dynamodb.AttributeType.NUMBER },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
    });

    const failureLambdaFunction = new lambdaNode.NodejsFunction(this, "failureLambdaFunction", {
        runtime: lambda.Runtime.NODEJS_14_X,
        handler: "handler",
        entry: `${__dirname}/resources/index.js`,
        environment: {
          FAILURE_INJECTION_PARAM: failureLambdaParameter.parameterName,
          FAILURE_INJECTION_TABLE: failureLambdaTable.tableName,
        },
        bundling: {
          nodeModules: ["failure-lambda"],
        },
      }
    );

    new apigateway.LambdaRestApi(this, "failureLambdaApi", {
      handler: failureLambdaFunction,
    });
    
    failureLambdaParameter.grantRead(failureLambdaFunction);
    failureLambdaTable.grantWriteData(failureLambdaFunction);

  }
}
