import json
import os
from datetime import datetime, timezone
from typing import Dict, Any, List

import boto3
from botocore.config import Config

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
APPROVALS_TABLE = os.environ["APPROVALS_TABLE"]
CONFIG_TABLE = os.environ["CONFIG_TABLE"]
ENVIRONMENT = os.environ["ENVIRONMENT"]

GUARDRAILS = {
    "auto_approve_threshold_usd": 100.0,
    "dual_approval_threshold_usd": 100.0,
    "blocked_tags": {
        "Environment": ["prod", "production", "Prod", "Production"],
        "CostJanitor": ["protect", "do-not-delete"],
    },
    "max_resources_per_run": 10,
    "dry_run_default": True,
    "require_snapshot_for_ebs": True,
}


def handler(event, context):
    print(f"Teardown event: {json.dumps(event)}")

    approval_id = event.get("approval_id")
    dry_run = event.get("dry_run", GUARDRAILS["dry_run_default"])

    if not approval_id:
        return {"statusCode": 400, "body": json.dumps({"error": "Missing approval_id"})}

    approval = get_approval(approval_id)
    if not approval:
        return {"statusCode": 404, "body": json.dumps({"error": "Approval not found"})}

    if approval["status"] != "APPROVED":
        return {"statusCode": 400, "body": json.dumps({"error": f"Approval not approved: {approval['status']}"})}

    finding = get_finding(approval["finding_id"])
    if not finding:
        return {"statusCode": 404, "body": json.dumps({"error": "Finding not found"})}

    guardrail_check = check_guardrails(finding, approval)
    if not guardrail_check["passed"]:
        return {"statusCode": 403, "body": json.dumps({"error": "Guardrail violation", "details": guardrail_check["reasons"]})}

    if dry_run:
        result = simulate_teardown(finding)
        result["dry_run"] = True
        return {"statusCode": 200, "body": json.dumps(result)}

    result = execute_teardown(finding)
    result["dry_run"] = False

    finding["status"] = "TEARDOWN_COMPLETE"
    finding["teardown_at"] = datetime.now(timezone.utc).isoformat()
    finding["teardown_result"] = result
    save_finding(finding)

    return {"statusCode": 200, "body": json.dumps(result)}


def check_guardrails(finding: Dict, approval: Dict) -> Dict:
    reasons = []

    tags = finding.get("tags", {})
    for tag_key, blocked_values in GUARDRAILS["blocked_tags"].items():
        if tags.get(tag_key) in blocked_values:
            reasons.append(f"Blocked tag: {tag_key}={tags.get(tag_key)}")

    monthly_cost = finding.get("monthly_cost_usd", 0)
    if monthly_cost > GUARDRAILS["dual_approval_threshold_usd"]:
        approve_votes = sum(1 for v in approval.get("votes", []) if v["decision"] == "approve")
        if approve_votes < 2:
            reasons.append(f"Cost ${monthly_cost:.2f} > ${GUARDRAILS['dual_approval_threshold_usd']} requires 2 approvals, got {approve_votes}")

    if monthly_cost > GUARDRAILS["auto_approve_threshold_usd"] * 10:
        reasons.append(f"Cost ${monthly_cost:.2f} exceeds maximum allowed for automated teardown")

    return {"passed": len(reasons) == 0, "reasons": reasons}


def simulate_teardown(finding: Dict) -> Dict:
    resource_type = finding["resource_type"]
    resource_id = finding["resource_id"]
    region = finding["region"]

    actions = []
    if resource_type == "EC2":
        actions.append(f"Would terminate EC2 instance {resource_id} in {region}")
    elif resource_type == "EBS":
        actions.append(f"Would delete EBS volume {resource_id} in {region}")
        if GUARDRAILS["require_snapshot_for_ebs"]:
            actions.append(f"  (Would create snapshot first)")
    elif resource_type == "ELB":
        actions.append(f"Would delete Load Balancer {resource_id} in {region}")

    return {
        "finding_id": finding["finding_id"],
        "resource_type": resource_type,
        "resource_id": resource_id,
        "simulated_actions": actions,
        "estimated_monthly_savings": finding.get("monthly_cost_usd", 0),
    }


def execute_teardown(finding: Dict) -> Dict:
    resource_type = finding["resource_type"]
    resource_id = finding["resource_id"]
    region = finding["region"]
    resource_arn = finding.get("resource_arn")

    client = get_aws_client(region)

    try:
        if resource_type == "EC2":
            client.terminate_instances(InstanceIds=[resource_id])
            action = f"Terminated EC2 instance {resource_id}"
        elif resource_type == "EBS":
            if GUARDRAILS["require_snapshot_for_ebs"]:
                snap = client.create_snapshot(VolumeId=resource_id, Description=f"Cost Janitor pre-deletion snapshot for {resource_id}")
                snapshot_id = snap["SnapshotId"]
                waiter = client.get_waiter("snapshot_completed")
                waiter.wait(SnapshotIds=[snapshot_id])
            client.delete_volume(VolumeId=resource_id)
            action = f"Deleted EBS volume {resource_id}" + (f" (snapshot: {snapshot_id})" if GUARDRAILS["require_snapshot_for_ebs"] else "")
        elif resource_type == "ELB":
            if resource_arn and "loadbalancer/app/" in resource_arn:
                client.delete_load_balancer(LoadBalancerArn=resource_arn)
            else:
                elb = boto3.client("elb", region_name=region, config=Config(retries={"max_attempts": 3}))
                elb.delete_load_balancer(LoadBalancerName=resource_id)
            action = f"Deleted Load Balancer {resource_id}"
        else:
            return {"success": False, "error": f"Unknown resource type: {resource_type}"}

        return {"success": True, "action": action, "resource_id": resource_id}

    except Exception as e:
        return {"success": False, "error": str(e), "resource_id": resource_id}


def get_aws_client(region: str):
    return boto3.client("ec2", region_name=region, config=Config(retries={"max_attempts": 3}))


def get_approval(approval_id: str) -> Dict[str, Any]:
    table = dynamodb.Table(APPROVALS_TABLE)
    response = table.get_item(Key={"approval_id": approval_id})
    return response.get("Item")


def get_finding(finding_id: str) -> Dict[str, Any]:
    table = dynamodb.Table(FINDINGS_TABLE)
    response = table.get_item(Key={"finding_id": finding_id})
    return response.get("Item")


def save_finding(finding: Dict[str, Any]):
    table = dynamodb.Table(FINDINGS_TABLE)
    table.put_item(Item=finding)