import { DynamoDBClient, PutItemCommand } from "@aws-sdk/client-dynamodb";

// No failure-lambda import needed. The layer handles everything.
const host = `dynamodb.${process.env.AWS_REGION}.amazonaws.com`;

function response(statusCode, body) {
  return {
    statusCode,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  };
}

function isBlocked(error) {
  const text = [
    error?.code,
    error?.name,
    error?.message,
    error?.cause?.code,
    error?.cause?.message,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    text.includes("ENOTFOUND") ||
    text.includes("EAI_AGAIN") ||
    text.includes("Name or service not known") ||
    text.includes("getaddrinfo")
  );
}

export const handler = async (event) => {
  const query = event?.queryStringParameters ?? {};
  const fallbackEnabled = query.fallback !== "0";
  const started = Date.now();

  try {
    // A fresh client per invocation forces a new DNS lookup, which makes the
    // denylist observable even when the previous invocation kept a connection alive.
    const client = new DynamoDBClient({ maxAttempts: 1 });
    await client.send(
      new PutItemCommand({
        TableName: process.env.TABLE_NAME,
        Item: {
          pk: { S: "demo" },
          ts: { S: new Date().toISOString() },
        },
      }),
    );

    return response(200, {
      message: "Stored in DynamoDB",
      runtime: process.version,
      downstream: {
        host,
        outcome: "ok",
        durationMs: Date.now() - started,
        fallback: false,
      },
    });
  } catch (error) {
    const blocked = isBlocked(error);

    if (fallbackEnabled) {
      return response(200, {
        message: "Degraded: downstream unavailable",
        runtime: process.version,
        downstream: {
          host,
          outcome: blocked ? "blocked" : "error",
          durationMs: Date.now() - started,
          fallback: true,
        },
      });
    }

    return response(500, {
      message: "Downstream failed",
      runtime: process.version,
      downstream: {
        host,
        outcome: blocked ? "blocked" : "error",
        durationMs: Date.now() - started,
        fallback: false,
      },
      error: String(error?.message ?? error),
    });
  }
};
