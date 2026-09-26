import json
import os
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Set

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config

from aws_client import AWSClient
from common.ddb import from_ddb, to_ddb
from common.jobs import create_job, update_job
from rules import ScanConfig, evaluate_ec2, evaluate_ebs, evaluate_lb

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))
lambda_client = boto3.client("lambda", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
CONFIG_TABLE = os.environ["CONFIG_TABLE"]
JOBS_TABLE = os.environ.get("JOBS_TABLE", "")
ENRICHMENT_FUNCTION = os.environ.get("ENRICHMENT_FUNCTION", "")
ENRICHMENT_ENABLED = os.environ.get("ENRICHMENT_ENABLED", "false").lower() == "true"
ENVIRONMENT = os.environ["ENVIRONMENT"]
SCAN_REGION = os.environ.get("SCAN_REGION") or os.environ.get("AWS_REGION", "us-east-1")

CLOSED_STATUSES = {"TEARDOWN_COMPLETE", "REJECTED", "SKIPPED_NOW_ACTIVE", "EXPIRED"}


def handler(event, context):
    event = event or {}
    jobs = dynamodb.Table(JOBS_TABLE) if JOBS_TABLE else None
    job_id = event.get("job_id")
    if jobs is not None and not job_id:
        job_id = create_job(jobs, "scan", job_id=f"scheduled-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}")["job_id"]
    if jobs is not None:
        update_job(jobs, job_id, "RUNNING")

    try:
        result = run_scan()
    except Exception as e:
        print(f"Scan failed: {e}")
        if jobs is not None:
            update_job(jobs, job_id, "FAILED", error=str(e))
        raise

    if jobs is not None:
        update_job(jobs, job_id, "SUCCEEDED", **result)
    return {"statusCode": 200, "body": json.dumps({"job_id": job_id, **result})}


def run_scan() -> Dict:
    print(f"Starting scan for environment: {ENVIRONMENT}")
    config = get_scan_config()
    print(f"Loaded config: {config.__dict__}")

    client = AWSClient(role_arn=config.role_arn, region=SCAN_REGION, external_id=f"cost-janitor-{ENVIRONMENT}")
    asg_instance_ids = get_asg_instance_ids(client)

    candidates: List[Dict] = []
    candidates.extend(scan_ec2(client, asg_instance_ids, config))
    candidates.extend(scan_ebs(client, config))
    candidates.extend(scan_lb(client, config))

    open_ids = open_resource_ids()
    new_findings = [f for f in candidates if f["resource_id"] not in open_ids]
    now = datetime.now(timezone.utc)

    for finding in new_findings:
        finding["finding_id"] = generate_finding_id(finding)
        finding["account_id"] = config.account_id
        finding["detected_at"] = now.isoformat()
        finding["status"] = "PENDING_ENRICHMENT"
        finding["ttl"] = int((now + timedelta(days=90)).timestamp())
        save_finding(finding)
        if ENRICHMENT_ENABLED and ENRICHMENT_FUNCTION:
            trigger_enrichment(finding["finding_id"])

    by_type: Dict[str, int] = {}
    for f in candidates:
        by_type[f["resource_type"]] = by_type.get(f["resource_type"], 0) + 1
    print(f"Idle resources: {by_type}; new findings: {len(new_findings)}")

    return {
        "scanned_at": now.isoformat(),
        "findings_count": len(new_findings),
        "idle_resources": len(candidates),
        "already_open": len(candidates) - len(new_findings),
        "by_type": by_type,
        "monthly_waste_usd": round(sum(float(f["monthly_cost_usd"]) for f in candidates), 2),
        "findings": [f["finding_id"] for f in new_findings],
    }


def get_scan_config() -> ScanConfig:
    table = dynamodb.Table(CONFIG_TABLE)
    item = from_ddb(table.get_item(Key={"config_key": "scan_config"}).get("Item") or {})

    return ScanConfig(
        cpu_threshold_percent=float(item.get("cpu_threshold_percent", 5.0)),
        cpu_hours=int(item.get("cpu_hours", 24)),
        network_idle_bytes=int(item.get("network_idle_bytes", 1024 * 1024)),
        ebs_unattached_days=int(item.get("ebs_unattached_days", 7)),
        ebs_no_snapshot_days=int(item.get("ebs_no_snapshot_days", 30)),
        lb_idle_days=int(item.get("lb_idle_days", 7)),
        excluded_tags=item.get("excluded_tags") or {
            "Environment": ["prod", "production"],
            "CostJanitor": ["ignore", "do-not-delete"],
        },
        scope_tags=item.get("scope_tags") or {},
        role_arn=item.get("role_arn") or None,
        account_id=item.get("account_id") or os.environ.get("AWS_ACCOUNT_ID", "unknown"),
    )


def open_resource_ids() -> Set[str]:
    table = dynamodb.Table(FINDINGS_TABLE)
    ids: Set[str] = set()
    kwargs = {
        "ProjectionExpression": "resource_id, #s",
        "ExpressionAttributeNames": {"#s": "status"},
        "FilterExpression": ~Attr("status").is_in(list(CLOSED_STATUSES)),
    }
    while True:
        page = table.scan(**kwargs)
        ids.update(item["resource_id"] for item in page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return ids
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def get_asg_instance_ids(client: AWSClient) -> set:
    asg_ids = set()
    try:
        for asg in client.get_autoscaling_groups():
            for instance in asg.get("Instances", []):
                asg_ids.add(instance["InstanceId"])
    except Exception as e:
        print(f"Error getting ASG instances: {e}")
    return asg_ids


def scan_ec2(client: AWSClient, asg_instance_ids: set, config: ScanConfig) -> List[Dict]:
    findings = []
    for instance in client.get_ec2_instances():
        instance_id = instance["InstanceId"]
        try:
            if instance["State"]["Name"] != "running":
                continue
            metrics = client.get_instance_metrics(instance_id, hours=config.cpu_hours)
            finding = evaluate_ec2(instance, metrics, asg_instance_ids, config)
            if finding:
                cost, source = client.get_ec2_monthly_price(instance["InstanceType"], finding["region"])
                finding["monthly_cost_usd"] = cost
                finding["price_source"] = source
                findings.append(finding)
        except Exception as e:
            print(f"Error scanning EC2 {instance_id}: {e}")
    return findings


def scan_ebs(client: AWSClient, config: ScanConfig) -> List[Dict]:
    findings = []
    for volume in client.get_volumes():
        volume_id = volume["VolumeId"]
        try:
            if volume["State"] != "available":
                continue
            finding = evaluate_ebs(volume, client.get_snapshots(volume_id), config)
            if finding:
                findings.append(finding)
        except Exception as e:
            print(f"Error scanning EBS {volume_id}: {e}")
    return findings


def scan_lb(client: AWSClient, config: ScanConfig) -> List[Dict]:
    findings = []
    for lb in client.get_load_balancers():
        lb_arn = lb["LoadBalancerArn"]
        try:
            target_groups = client.get_target_groups(lb_arn)
            target_health_map = {
                tg["TargetGroupArn"]: client.get_target_health(tg["TargetGroupArn"]) for tg in target_groups
            }
            metrics = client.get_lb_metrics(lb_arn, hours=config.lb_idle_days * 24)
            finding = evaluate_lb(lb, target_groups, target_health_map, metrics, config)
            if finding:
                findings.append(finding)
        except Exception as e:
            print(f"Error scanning LB {lb_arn}: {e}")
    return findings


def generate_finding_id(finding: Dict) -> str:
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    return f"f-{finding['resource_type'].lower()}-{finding['resource_id']}-{date_str}"


def save_finding(finding: Dict):
    dynamodb.Table(FINDINGS_TABLE).put_item(Item=to_ddb(finding))


def trigger_enrichment(finding_id: str):
    lambda_client.invoke(
        FunctionName=ENRICHMENT_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps({"finding_id": finding_id}),
    )
