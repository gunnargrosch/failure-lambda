# No failure-lambda import needed — the layer handles everything.
import json
import sys


def handler(event, context):
    return {
        "statusCode": 200,
        "body": json.dumps({"message": "Hello from Python!", "runtime": sys.version}),
    }
