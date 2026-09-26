import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional

import boto3
from boto3.dynamodb.conditions import Key
from botocore.config import Config

from common import activity
from common.config import DEFAULT_GUARDRAILS, GUARDRAIL_FIELDS, load_guardrails, load_item
from common.ddb import dumps, from_ddb, to_ddb
from common.jobs import create_job, get_job

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))
lambda_client = boto3.client("lambda", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
APPROVALS_TABLE = os.environ["APPROVALS_TABLE"]
CONFIG_TABLE = os.environ["CONFIG_TABLE"]
TEARDOWN_FUNCTION = os.environ["TEARDOWN_FUNCTION"]
SCANNER_FUNCTION = os.environ.get("SCANNER_FUNCTION", "")
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
ACTIVITY_TABLE = os.environ.get("ACTIVITY_TABLE", "")
ENVIRONMENT = os.environ["ENVIRONMENT"]

MAX_LIMIT = 500

# The UI is served from CloudFront and the API from API Gateway, so every
# response needs CORS headers or the browser blocks the read.
ALLOWED_ORIGINS = [o.strip() for o in os.environ.get("ALLOWED_ORIGIN", "*").split(",") if o.strip()]
BASE_CORS_HEADERS = {
    "Access-Control-Allow-Headers": "Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    "Access-Control-Max-Age": "86400",
}


class HttpError(Exception):
    def __init__(self, status: int, error: str):
        super().__init__(error)
        self.status = status
        self.error = error


def cors_headers(event: Dict) -> Dict[str, str]:
    headers = {k.lower(): v for k, v in (event.get("headers") or {}).items()}
    origin = headers.get("origin", "")
    if "*" in ALLOWED_ORIGINS:
        allow = "*"
    elif origin in ALLOWED_ORIGINS:
        allow = origin
    else:
        allow = ALLOWED_ORIGINS[0] if ALLOWED_ORIGINS else "*"
    return {**BASE_CORS_HEADERS, "Access-Control-Allow-Origin": allow, "Vary": "Origin"}


def respond(status: int, body: Any) -> Dict:
    return {"statusCode": status, "body": dumps(body)}


def handler(event, context):
    cors = cors_headers(event)
    if (event.get("httpMethod") or "").upper() == "OPTIONS":
        return {"statusCode": 204, "headers": cors, "body": ""}

    response = route(event)
    response["headers"] = {**cors, "Content-Type": "application/json", **(response.get("headers") or {})}
    return response


def route(event):
    http_method = (event.get("httpMethod") or "GET").upper()
    path = event.get("path") or "/"
    print(f"{http_method} {path}")

    try:
        params = event.get("queryStringParameters") or {}
        body = parse_body(event)
        parts = [p for p in path.split("/") if p]

        if parts == ["findings"] and http_method == "GET":
            return get_findings(params)
        if len(parts) == 2 and parts[0] == "findings" and http_method == "GET":
            return get_finding(parts[1])
        if parts == ["approvals"] and http_method == "GET":
            return get_approvals(params)
        if len(parts) == 3 and parts[0] == "approvals" and parts[2] == "vote" and http_method == "POST":
            return vote_approval(parts[1], body)
        if parts == ["teardown"] and http_method == "POST":
            return trigger_teardown(body)
        if parts == ["scan"] and http_method == "POST":
            return trigger_scan()
        if len(parts) == 2 and parts[0] == "jobs" and http_method == "GET":
            return get_job_route(parts[1])
        if parts == ["activity"] and http_method == "GET":
            return get_activity(params)
        if parts == ["config"] and http_method == "GET":
            return get_config()
        if parts == ["config"] and http_method in ("POST", "PUT"):
            return update_config(body)
        return respond(404, {"error": "Not found"})
    except HttpError as e:
        return respond(e.status, {"error": e.error})
    except Exception as e:
        print(f"Error: {e}")
        return respond(500, {"error": str(e)})


def parse_body(event: Dict) -> Dict:
    raw = event.get("body")
    if not raw:
        return {}
    try:
        body = json.loads(raw)
    except (TypeError, ValueError):
        raise HttpError(400, "Request body must be valid JSON")
    if not isinstance(body, dict):
        raise HttpError(400, "Request body must be a JSON object")
    return body


def parse_limit(params: Dict, default: int = 50) -> int:
    try:
        return max(1, min(int(params.get("limit", default)), MAX_LIMIT))
    except (TypeError, ValueError):
        raise HttpError(400, "limit must be a number")


def parse_last_key(params: Dict) -> Optional[Dict]:
    raw = params.get("last_key")
    if not raw:
        return None
    try:
        return json.loads(raw)
    except ValueError:
        raise HttpError(400, "last_key is not valid")


def page_kwargs(params: Dict, default_limit: int = 50) -> Dict:
    kwargs: Dict[str, Any] = {"Limit": parse_limit(params, default_limit)}
    last_key = parse_last_key(params)
    if last_key:
        kwargs["ExclusiveStartKey"] = last_key
    return kwargs


def get_findings(params: Dict) -> Dict:
    table = dynamodb.Table(FINDINGS_TABLE)
    status = params.get("status")
    account_id = params.get("account_id")
    kwargs = page_kwargs(params)

    if status and status.lower() != "all":
        response = table.query(IndexName="status-index", KeyConditionExpression=Key("status").eq(status),
                               ScanIndexForward=False, **kwargs)
    elif account_id:
        response = table.query(IndexName="account-index", KeyConditionExpression=Key("account_id").eq(account_id),
                               ScanIndexForward=False, **kwargs)
    else:
        response = table.scan(**kwargs)
    return format_response(response)


def get_approvals(params: Dict) -> Dict:
    table = dynamodb.Table(APPROVALS_TABLE)
    status = params.get("status")
    kwargs = page_kwargs(params)

    if status and status.lower() != "all":
        response = table.query(IndexName="status-index", KeyConditionExpression=Key("status").eq(status),
                               ScanIndexForward=False, **kwargs)
    else:
        response = table.scan(**kwargs)

    items = response.get("Items", [])
    for item in items:
        finding = fetch_finding(item["finding_id"])
        if finding:
            item["finding"] = finding

    return format_response({"Items": items, "LastEvaluatedKey": response.get("LastEvaluatedKey")})


def vote_approval(approval_id: str, body: Dict) -> Dict:
    decision = body.get("decision")
    user = str(body.get("user") or "").strip()

    if decision not in ("approve", "reject"):
        raise HttpError(400, "Invalid decision")
    if not user or user == "current-user":
        raise HttpError(400, "Enter your name before voting")

    table = dynamodb.Table(APPROVALS_TABLE)
    approval = table.get_item(Key={"approval_id": approval_id}).get("Item")
    if not approval:
        raise HttpError(404, "Approval not found")
    approval = from_ddb(approval)

    if approval["status"] != "PENDING":
        raise HttpError(400, "Approval already decided")
    if any(v["user"].lower() == user.lower() for v in approval.get("votes", [])):
        raise HttpError(400, f"{user} already voted on this item")

    approval.setdefault("votes", []).append({
        "user": user,
        "decision": decision,
        "at": datetime.now(timezone.utc).isoformat(),
    })

    approve_count = sum(1 for v in approval["votes"] if v["decision"] == "approve")
    reject_count = sum(1 for v in approval["votes"] if v["decision"] == "reject")

    if reject_count > 0:
        approval["status"] = "REJECTED"
    elif approve_count >= int(approval.get("required_approvals", 1)):
        approval["status"] = "APPROVED"

    table.put_item(Item=to_ddb(approval))

    if approval["status"] in ("APPROVED", "REJECTED"):
        dynamodb.Table(FINDINGS_TABLE).update_item(
            Key={"finding_id": approval["finding_id"]},
            UpdateExpression="SET #s = :s",
            ConditionExpression="attribute_exists(finding_id)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": approval["status"]},
        )

    log_activity("vote", {"approval_id": approval_id, "decision": decision},
                 f"{user} voted {decision}; approval is {approval['status']}", True, actor=user)
    return respond(200, approval)


def trigger_teardown(body: Dict) -> Dict:
    approval_id = body.get("approval_id")
    if not approval_id:
        raise HttpError(400, "Missing approval_id")
    dry_run = bool(body.get("dry_run", True))

    job_id = None
    if JOBS_TABLE:
        job_id = create_job(dynamodb.Table(JOBS_TABLE), "teardown", approval_id=approval_id,
                            dry_run=dry_run, requested_by="dashboard")["job_id"]

    lambda_client.invoke(
        FunctionName=TEARDOWN_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps({"approval_id": approval_id, "dry_run": dry_run, "job_id": job_id}),
    )
    log_activity("teardown" if not dry_run else "teardown_dry_run", {"approval_id": approval_id},
                 f"job {job_id} started", True, actor="dashboard")
    return respond(202, {"message": "Teardown triggered", "dry_run": dry_run, "job_id": job_id})


def trigger_scan() -> Dict:
    if not SCANNER_FUNCTION:
        raise HttpError(501, "Scanning from the dashboard is not configured")
    job_id = None
    if JOBS_TABLE:
        job_id = create_job(dynamodb.Table(JOBS_TABLE), "scan", requested_by="dashboard")["job_id"]
    lambda_client.invoke(FunctionName=SCANNER_FUNCTION, InvocationType="Event",
                         Payload=json.dumps({"job_id": job_id}))
    log_activity("run_scan", {}, f"job {job_id} started", True, actor="dashboard")
    return respond(202, {"message": "Scan started", "job_id": job_id})


def get_job_route(job_id: str) -> Dict:
    if not JOBS_TABLE:
        raise HttpError(501, "Job tracking is not configured")
    job = get_job(dynamodb.Table(JOBS_TABLE), job_id)
    if not job:
        raise HttpError(404, "Job not found")
    return respond(200, job)


def get_activity(params: Dict) -> Dict:
    if not ACTIVITY_TABLE:
        return respond(200, {"items": []})
    items = activity.recent(dynamodb.Table(ACTIVITY_TABLE), limit=min(parse_limit(params), 100),
                            since=params.get("since"))
    return respond(200, {"items": items})


def get_config() -> Dict:
    table = dynamodb.Table(CONFIG_TABLE)
    item = load_item(table, "scan_config")
    item["guardrails"] = load_guardrails(table)
    return respond(200, item)


def update_config(body: Dict) -> Dict:
    table = dynamodb.Table(CONFIG_TABLE)
    guardrail_updates = dict(body.pop("guardrails", None) or {})
    for key in list(body):
        if key in GUARDRAIL_FIELDS:
            guardrail_updates[key] = body.pop(key)

    if body:
        scan_config = {**load_item(table, "scan_config"), **body}
        table.put_item(Item=to_ddb({"config_key": "scan_config", **scan_config}))
    if guardrail_updates:
        unknown = set(guardrail_updates) - set(DEFAULT_GUARDRAILS)
        if unknown:
            raise HttpError(400, f"Unknown guardrail fields: {sorted(unknown)}")
        guardrails = {**load_item(table, "guardrails"), **guardrail_updates}
        table.put_item(Item=to_ddb({"config_key": "guardrails", **guardrails}))

    return respond(200, {"message": "Config updated"})


def get_finding(finding_id: str) -> Dict:
    finding = fetch_finding(finding_id)
    if not finding:
        raise HttpError(404, "Finding not found")
    return respond(200, finding)


def fetch_finding(finding_id: str) -> Optional[Dict[str, Any]]:
    item = dynamodb.Table(FINDINGS_TABLE).get_item(Key={"finding_id": finding_id}).get("Item")
    return from_ddb(item) if item else None


def log_activity(tool: str, args: Dict, result: str, ok: bool, actor: str) -> None:
    if not ACTIVITY_TABLE:
        return
    try:
        activity.record(dynamodb.Table(ACTIVITY_TABLE), tool, args, result, ok, actor=actor)
    except Exception as e:
        print(f"Could not record activity: {e}")


def format_response(response: Dict) -> Dict:
    body: Dict[str, Any] = {"items": from_ddb(response.get("Items", []))}
    last_key = response.get("LastEvaluatedKey")
    if last_key:
        body["last_key"] = dumps(last_key)
    return respond(200, body)
