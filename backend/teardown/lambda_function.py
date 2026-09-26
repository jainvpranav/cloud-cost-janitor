import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from aws_client import AWSClient
from common.config import load_guardrails, load_item
from common.ddb import from_ddb, to_ddb
from common.jobs import update_job
from rules import ScanConfig, evaluate_ebs, evaluate_ec2, evaluate_lb

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
APPROVALS_TABLE = os.environ["APPROVALS_TABLE"]
CONFIG_TABLE = os.environ["CONFIG_TABLE"]
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
ENVIRONMENT = os.environ["ENVIRONMENT"]

IN_FLIGHT = "TEARDOWN_IN_PROGRESS"
DONE = "TEARDOWN_COMPLETE"


class Refused(Exception):
    def __init__(self, status: int, error: str, details: Any = None):
        super().__init__(error)
        self.status = status
        self.error = error
        self.details = details


def handler(event, context):
    print(f"Teardown event: {json.dumps(event)}")
    job_id = event.get("job_id")
    jobs = dynamodb.Table(JOBS_TABLE) if JOBS_TABLE else None
    if jobs is not None:
        update_job(jobs, job_id, "RUNNING")

    try:
        result = run(event)
    except Refused as r:
        body = {"error": r.error, **({"details": r.details} if r.details else {})}
        if jobs is not None:
            update_job(jobs, job_id, "REFUSED", error=r.error, details=r.details)
        return {"statusCode": r.status, "body": json.dumps(body)}
    except Exception as e:
        print(f"Teardown failed: {e}")
        if jobs is not None:
            update_job(jobs, job_id, "FAILED", error=str(e))
        return {"statusCode": 500, "body": json.dumps({"error": str(e)})}

    if jobs is not None:
        update_job(jobs, job_id, "SUCCEEDED" if result.get("success", True) else "FAILED", result=result)
    return {"statusCode": 200, "body": json.dumps(result, default=str)}


def run(event: Dict) -> Dict:
    approval_id = event.get("approval_id")
    if not approval_id:
        raise Refused(400, "Missing approval_id")

    config_table = dynamodb.Table(CONFIG_TABLE)
    guardrails = load_guardrails(config_table)
    dry_run = bool(event.get("dry_run", guardrails["dry_run_default"]))

    approval = get_item(APPROVALS_TABLE, {"approval_id": approval_id})
    if not approval:
        raise Refused(404, "Approval not found")

    allowed = {"APPROVED", "PENDING"} if dry_run else {"APPROVED"}
    if approval["status"] not in allowed:
        raise Refused(400, f"Approval not approved: {approval['status']}")

    finding = get_item(FINDINGS_TABLE, {"finding_id": approval["finding_id"]})
    if not finding:
        raise Refused(404, "Finding not found")
    if finding.get("status") == DONE:
        raise Refused(409, "Already torn down")
    if finding.get("status") == IN_FLIGHT and not dry_run:
        raise Refused(409, "Teardown already in progress")

    scan_config = scan_config_from(load_item(config_table, "scan_config"))
    client = AWSClient(role_arn=scan_config.role_arn, region=finding["region"],
                       external_id=f"cost-janitor-{ENVIRONMENT}")

    live = describe_live(client, finding)
    if live is None:
        if not dry_run:
            set_status(finding["finding_id"], "RESOURCE_GONE", teardown_at=now_iso())
        raise Refused(409, f"{finding['resource_type']} {finding['resource_id']} no longer exists")

    live_tags = {t["Key"]: t["Value"] for t in live.get("Tags", [])}
    reasons = check_guardrails(finding, approval, guardrails, live_tags)
    if reasons and not dry_run:
        raise Refused(403, "Guardrail violation", reasons)

    still_idle, idle_detail = recheck_idle(client, finding, live, scan_config)

    if dry_run:
        result = simulate_teardown(finding, live, guardrails)
        result.update({"dry_run": True, "guardrail_violations": reasons, "still_idle": still_idle,
                       "idle_check": idle_detail})
        return result

    if not still_idle:
        set_status(finding["finding_id"], "SKIPPED_NOW_ACTIVE", teardown_at=now_iso(), idle_check=idle_detail)
        raise Refused(409, "Resource is no longer idle; skipped", idle_detail)

    previous_status = finding.get("status", "PENDING_APPROVAL")
    claim(finding["finding_id"])

    result = execute_teardown(client, finding, live, guardrails)
    result["dry_run"] = False

    if result.get("success"):
        set_status(finding["finding_id"], DONE, teardown_at=now_iso(), teardown_result=result,
                   realized_monthly_savings_usd=float(finding.get("monthly_cost_usd", 0)))
    else:
        set_status(finding["finding_id"], previous_status, teardown_error=result.get("error"))
    return result


def scan_config_from(item: Dict) -> ScanConfig:
    return ScanConfig(
        cpu_threshold_percent=float(item.get("cpu_threshold_percent", 5.0)),
        cpu_hours=int(item.get("cpu_hours", 24)),
        network_idle_bytes=int(item.get("network_idle_bytes", 1024 * 1024)),
        ebs_unattached_days=int(item.get("ebs_unattached_days", 7)),
        ebs_no_snapshot_days=int(item.get("ebs_no_snapshot_days", 30)),
        lb_idle_days=int(item.get("lb_idle_days", 7)),
        excluded_tags={},
        scope_tags={},
        role_arn=item.get("role_arn") or None,
    )


def describe_live(client: AWSClient, finding: Dict) -> Optional[Dict]:
    kind = finding["resource_type"]
    if kind == "EC2":
        instance = client.get_instance(finding["resource_id"])
        if not instance or instance["State"]["Name"] in ("terminated", "shutting-down"):
            return None
        return instance
    if kind == "EBS":
        return client.get_volume(finding["resource_id"])
    if kind == "ELB":
        return client.get_load_balancer(finding["resource_arn"]) if finding.get("resource_arn") else None
    raise Refused(400, f"Unknown resource type: {kind}")


def check_guardrails(finding: Dict, approval: Dict, guardrails: Dict, live_tags: Dict[str, str]) -> list:
    reasons = []
    for tag_key, blocked_values in guardrails["blocked_tags"].items():
        if live_tags.get(tag_key) in blocked_values:
            reasons.append(f"Blocked tag: {tag_key}={live_tags.get(tag_key)}")

    monthly_cost = float(finding.get("monthly_cost_usd", 0))
    approve_votes = sum(1 for v in approval.get("votes", []) if v.get("decision") == "approve")
    needed = max(int(approval.get("required_approvals", 1)),
                 2 if monthly_cost > float(guardrails["dual_approval_threshold_usd"]) else 1)
    if approve_votes < needed:
        reasons.append(f"Cost ${monthly_cost:.2f}/mo requires {needed} approvals, got {approve_votes}")

    if monthly_cost > float(guardrails["max_teardown_cost_usd"]):
        reasons.append(f"Cost ${monthly_cost:.2f}/mo exceeds the ${float(guardrails['max_teardown_cost_usd']):.0f}/mo automated teardown limit")
    return reasons


def recheck_idle(client: AWSClient, finding: Dict, live: Dict, config: ScanConfig) -> Tuple[bool, Dict]:
    kind = finding["resource_type"]
    if kind == "EC2":
        metrics = client.get_instance_metrics(live["InstanceId"], hours=config.cpu_hours)
        detail = {"cpu_avg": round(metrics["cpu_avg"], 2), "network_in_bytes": metrics["network_in_bytes"],
                  "datapoints": metrics["datapoints"], "state": live["State"]["Name"]}
        return evaluate_ec2(live, metrics, set(), config) is not None, detail
    if kind == "EBS":
        detail = {"state": live["State"], "attachments": len(live.get("Attachments", []))}
        return evaluate_ebs(live, client.get_snapshots(live["VolumeId"]), config) is not None, detail
    if kind == "ELB":
        arn = live["LoadBalancerArn"]
        tgs = client.get_target_groups(arn)
        health = {tg["TargetGroupArn"]: client.get_target_health(tg["TargetGroupArn"]) for tg in tgs}
        metrics = client.get_lb_metrics(arn, hours=config.lb_idle_days * 24)
        healthy = sum(1 for hs in health.values() for h in hs if h["TargetHealth"]["State"] == "healthy")
        detail = {"healthy_targets": healthy, "requests": metrics["request_count"]}
        return evaluate_lb(live, tgs, health, metrics, config) is not None, detail
    return False, {}


def leftover_volumes(instance: Dict) -> list:
    return [
        m["Ebs"]["VolumeId"]
        for m in instance.get("BlockDeviceMappings", [])
        if "Ebs" in m and not m["Ebs"].get("DeleteOnTermination", True)
    ]


def simulate_teardown(finding: Dict, live: Dict, guardrails: Dict) -> Dict:
    kind, rid, region = finding["resource_type"], finding["resource_id"], finding["region"]
    actions = []
    if kind == "EC2":
        actions.append(f"Would terminate EC2 instance {rid} in {region}")
        for vol in leftover_volumes(live):
            actions.append(f"  Volume {vol} has DeleteOnTermination=false and would be left behind")
    elif kind == "EBS":
        if guardrails["require_snapshot_for_ebs"]:
            actions.append(f"Would snapshot EBS volume {rid} (tagged CostJanitor=pre-delete)")
        actions.append(f"Would delete EBS volume {rid} in {region}")
    elif kind == "ELB":
        actions.append(f"Would delete load balancer {rid} in {region}")

    return {
        "finding_id": finding["finding_id"],
        "resource_type": kind,
        "resource_id": rid,
        "simulated_actions": actions,
        "estimated_monthly_savings": float(finding.get("monthly_cost_usd", 0)),
    }


def execute_teardown(client: AWSClient, finding: Dict, live: Dict, guardrails: Dict) -> Dict:
    kind, rid = finding["resource_type"], finding["resource_id"]
    ec2 = client.client("ec2")
    try:
        if kind == "EC2":
            ec2.terminate_instances(InstanceIds=[rid])
            left = leftover_volumes(live)
            action = f"Terminated EC2 instance {rid}" + (f"; left behind volumes {left}" if left else "")
        elif kind == "EBS":
            snapshot_id = None
            if guardrails["require_snapshot_for_ebs"]:
                snap = ec2.create_snapshot(
                    VolumeId=rid,
                    Description=f"Cost Janitor pre-deletion snapshot for {rid}",
                    TagSpecifications=[{
                        "ResourceType": "snapshot",
                        "Tags": [
                            {"Key": "CostJanitor", "Value": "pre-delete"},
                            {"Key": "SourceVolume", "Value": rid},
                        ],
                    }],
                )
                snapshot_id = snap["SnapshotId"]
                ec2.get_waiter("snapshot_completed").wait(
                    SnapshotIds=[snapshot_id], WaiterConfig={"Delay": 10, "MaxAttempts": 80}
                )
            ec2.delete_volume(VolumeId=rid)
            action = f"Deleted EBS volume {rid}" + (f" (snapshot {snapshot_id})" if snapshot_id else "")
        elif kind == "ELB":
            client.client("elbv2").delete_load_balancer(LoadBalancerArn=finding["resource_arn"])
            action = f"Deleted load balancer {rid}"
        else:
            return {"success": False, "error": f"Unknown resource type: {kind}", "resource_id": rid}
        return {"success": True, "action": action, "resource_id": rid,
                "monthly_savings_usd": float(finding.get("monthly_cost_usd", 0))}
    except ClientError as e:
        return {"success": False, "error": str(e), "resource_id": rid}


def claim(finding_id: str) -> None:
    try:
        dynamodb.Table(FINDINGS_TABLE).update_item(
            Key={"finding_id": finding_id},
            UpdateExpression="SET #s = :in_flight",
            ConditionExpression="NOT #s IN (:in_flight, :done)",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":in_flight": IN_FLIGHT, ":done": DONE},
        )
    except ClientError as e:
        if e.response["Error"]["Code"] == "ConditionalCheckFailedException":
            raise Refused(409, "Teardown already in progress or complete")
        raise


def set_status(finding_id: str, status: str, **fields) -> None:
    values = {"status": status, **fields}
    dynamodb.Table(FINDINGS_TABLE).update_item(
        Key={"finding_id": finding_id},
        UpdateExpression="SET " + ", ".join(f"#{k} = :{k}" for k in values),
        ExpressionAttributeNames={f"#{k}": k for k in values},
        ExpressionAttributeValues=to_ddb({f":{k}": v for k, v in values.items()}),
    )


def get_item(table_name: str, key: Dict) -> Optional[Dict[str, Any]]:
    item = dynamodb.Table(table_name).get_item(Key=key).get("Item")
    return from_ddb(item) if item else None


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()
