# No failure-lambda import needed — the layer handles everything.
import json
import os
import sys
import time
from datetime import datetime, timezone

import boto3
from botocore.config import Config

host = f"dynamodb.{os.environ.get('AWS_REGION', 'eu-north-1')}.amazonaws.com"


def response(status_code, body):
    return {
        "statusCode": status_code,
        "headers": {"content-type": "application/json"},
        "body": json.dumps(body),
    }


def is_blocked(error):
    text = f"{error.__class__.__name__} {error}"
    return any(
        marker in text
        for marker in (
            "Name or service not known",
            "ENOTFOUND",
            "EAI_AGAIN",
            "getaddrinfo",
            "EndpointConnectionError",
            "Could not connect",
        )
    )


def handler(event, context):
    query = event.get("queryStringParameters") or {}
    fallback_enabled = query.get("fallback") != "0"
    started = time.perf_counter()

    try:
        # A fresh client per invocation forces a new DNS lookup, which makes the
        # denylist observable even when the previous invocation kept a connection alive.
        client = boto3.client(
            "dynamodb",
            config=Config(connect_timeout=1, read_timeout=2, retries={"max_attempts": 0}),
        )
        client.put_item(
            TableName=os.environ["TABLE_NAME"],
            Item={
                "pk": {"S": "demo"},
                "ts": {"S": datetime.now(timezone.utc).isoformat()},
            },
        )

        return response(
            200,
            {
                "message": "Stored in DynamoDB",
                "runtime": sys.version,
                "downstream": {
                    "host": host,
                    "outcome": "ok",
                    "durationMs": round((time.perf_counter() - started) * 1000),
                    "fallback": False,
                },
            },
        )
    except Exception as error:  # noqa: BLE001
        blocked = is_blocked(error)

        if fallback_enabled:
            return response(
                200,
                {
                    "message": "Degraded: downstream unavailable",
                    "runtime": sys.version,
                    "downstream": {
                        "host": host,
                        "outcome": "blocked" if blocked else "error",
                        "durationMs": round((time.perf_counter() - started) * 1000),
                        "fallback": True,
                    },
                },
            )

        return response(
            500,
            {
                "message": "Downstream failed",
                "runtime": sys.version,
                "downstream": {
                    "host": host,
                    "outcome": "blocked" if blocked else "error",
                    "durationMs": round((time.perf_counter() - started) * 1000),
                    "fallback": False,
                },
                "error": str(error),
            },
        )
