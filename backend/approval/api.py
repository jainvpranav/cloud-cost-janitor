import json
import os
from datetime import datetime, timezone
from typing import Dict, Any, List

import boto3
from botocore.config import Config
from boto3.dynamodb.conditions import Key

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))
lambda_client = boto3.client("lambda", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
APPROVALS_TABLE = os.environ["APPROVALS_TABLE"]
CONFIG_TABLE = os.environ["CONFIG_TABLE"]
TEARDOWN_FUNCTION = os.environ["TEARDOWN_FUNCTION"]
ENVIRONMENT = os.environ["ENVIRONMENT"]


def handler(event, context):
    print(f"Event: {json.dumps(event)}")

    http_method = event.get("httpMethod", "GET")
    path = event.get("path", "/")
    path_params = event.get("pathParameters") or {}
    query_params = event.get("queryStringParameters") or {}
    body = json.loads(event["body"]) if event.get("body") else {}

    try:
        if path == "/findings" and http_method == "GET":
            return get_findings(query_params)
        elif path == "/approvals" and http_method == "GET":
            return get_approvals(query_params)
        elif path.startswith("/approvals/") and path.endswith("/vote") and http_method == "POST":
            approval_id = path.split("/")[2]
            return vote_approval(approval_id, body)
        elif path == "/teardown" and http_method == "POST":
            return trigger_teardown(body)
        elif path == "/config" and http_method == "GET":
            return get_config()
        elif path == "/config" and http_method in ["POST", "PUT"]:
            return update_config(body)
        else:
            return {"statusCode": 404, "body": json.dumps({"error": "Not found"})}
    except Exception as e:
        print(f"Error: {e}")
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}


def get_findings(params: Dict) -> Dict:
    table = dynamodb.Table(FINDINGS_TABLE)
    status = params.get("status")
    account_id = params.get("account_id")
    limit = int(params.get("limit", 50))
    last_key = params.get("last_key")

    if status:
        index = "status-index"
        key_expr = Key("status").eq(status)
        if account_id:
            # Would need a composite index for this combination
            pass
    elif account_id:
        index = "account-index"
        key_expr = Key("account_id").eq(account_id)
    else:
        response = table.scan(Limit=limit, ExclusiveStartKey=json.loads(last_key) if last_key else None)
        return format_response(response)

    response = table.query(
        IndexName=index,
        KeyConditionExpression=key_expr,
        Limit=limit,
        ExclusiveStartKey=json.loads(last_key) if last_key else None,
        ScanIndexForward=False,
    )
    return format_response(response)


def get_approvals(params: Dict) -> Dict:
    table = dynamodb.Table(APPROVALS_TABLE)
    status = params.get("status", "PENDING")
    limit = int(params.get("limit", 50))
    last_key = params.get("last_key")

    index = "status-index"
    key_expr = Key("status").eq(status)

    response = table.query(
        IndexName=index,
        KeyConditionExpression=key_expr,
        Limit=limit,
        ExclusiveStartKey=json.loads(last_key) if last_key else None,
        ScanIndexForward=False,
    )

    items = response.get("Items", [])
    for item in items:
        finding = get_finding(item["finding_id"])
        if finding:
            item["finding"] = finding

    return format_response({"Items": items, "LastEvaluatedKey": response.get("LastEvaluatedKey")})


def vote_approval(approval_id: str, body: Dict) -> Dict:
    decision = body.get("decision")
    user = body.get("user", "anonymous")

    if decision not in ["approve", "reject"]:
        return {"statusCode": 400, "body": json.dumps({"error": "Invalid decision"})}

    table = dynamodb.Table(APPROVALS_TABLE)
    response = table.get_item(Key={"approval_id": approval_id})
    approval = response.get("Item")

    if not approval:
        return {"statusCode": 404, "body": json.dumps({"error": "Approval not found"})}

    if approval["status"] != "PENDING":
        return {"statusCode": 400, "body": json.dumps({"error": "Approval already decided"})}

    for vote in approval["votes"]:
        if vote["user"] == user:
            return {"statusCode": 400, "body": json.dumps({"error": "User already voted"})}

    approval["votes"].append({
        "user": user,
        "decision": decision,
        "at": datetime.now(timezone.utc).isoformat(),
    })

    approve_count = sum(1 for v in approval["votes"] if v["decision"] == "approve")
    reject_count = sum(1 for v in approval["votes"] if v["decision"] == "reject")

    if reject_count > 0:
        approval["status"] = "REJECTED"
    elif approve_count >= approval["required_approvals"]:
        approval["status"] = "APPROVED"

    table.put_item(Item=approval)
    return {"statusCode": 200, "body": json.dumps(approval)}


def trigger_teardown(body: Dict) -> Dict:
    approval_id = body.get("approval_id")
    dry_run = body.get("dry_run", True)

    if not approval_id:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing approval_id"})}

    lambda_client.invoke(
        FunctionName=TEARDOWN_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps({"approval_id": approval_id, "dry_run": dry_run}),
    )

    return {"statusCode": 202, "body": json.dumps({"message": "Teardown triggered", "dry_run": dry_run})}


def get_config() -> Dict:
    table = dynamodb.Table(CONFIG_TABLE)
    response = table.get_item(Key={"config_key": "scan_config"})
    item = response.get("Item", {})
    if "config_key" in item:
        del item["config_key"]
    return {"statusCode": 200, "body": json.dumps(item)}


def update_config(body: Dict) -> Dict:
    table = dynamodb.Table(CONFIG_TABLE)
    item = {"config_key": "scan_config", **body}
    table.put_item(Item=item)
    return {"statusCode": 200, "body": json.dumps({"message": "Config updated"})}


def get_finding(finding_id: str) -> Dict[str, Any]:
    table = dynamodb.Table(FINDINGS_TABLE)
    response = table.get_item(Key={"finding_id": finding_id})
    return response.get("Item")


def format_response(response: Dict) -> Dict:
    items = response.get("Items", [])
    last_key = response.get("LastEvaluatedKey")
    body = {"items": items}
    if last_key:
        body["last_key"] = json.dumps(last_key, default=str)
    return {"statusCode": 200, "body": json.dumps(body, default=str)}