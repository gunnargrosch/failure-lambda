import middy from "@middy/core";
import { failureLambdaMiddleware } from "failure-lambda/middy";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";

const dynamoClient = new DynamoDBClient({});
const dynamoDb = DynamoDBDocumentClient.from(dynamoClient);

export const handler = middy(async (event, context) => {
  const contents = "Hello failureLambda (Middy)!";

  await dynamoDb.send(
    new PutCommand({
      TableName: process.env.FAILURE_INJECTION_TABLE,
      Item: {
        id: Date.now(),
        contents,
      },
    })
  );

  return {
    statusCode: 200,
    body: JSON.stringify({ message: contents }),
  };
}).use(failureLambdaMiddleware());
