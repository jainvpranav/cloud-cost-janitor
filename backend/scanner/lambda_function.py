import json
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, List, Any

import boto3
from botocore.config import Config

from aws_client import AWSClient
from rules import (
    ScanConfig,
    evaluate_ec2,
    evaluate_ebs,
    evaluate_lb,
    estimate_ec2_cost,
    is_excluded,
)

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))
lambda_client = boto3.client("lambda", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
CONFIG_TABLE = os.environ["CONFIG_TABLE"]
ENRICHMENT_FUNCTION = os.environ["ENRICHMENT_FUNCTION"]
APPROVAL_TOPIC_ARN = os.environ["APPROVAL_TOPIC_ARN"]
ENVIRONMENT = os.environ["ENVIRONMENT"]


def handler(event, context):
    print(f"Starting scan for environment: {ENVIRONMENT}")
    config = get_scan_config()
    print(f"Loaded config: {config.__dict__}")

    client = AWSClient(role_arn=config.role_arn, external_id=f"cost-janitor-{ENVIRONMENT}")

    findings = []

    asg_instance_ids = get_asg_instance_ids(client)
    print(f"Found {len(asg_instance_ids)} instances in ASGs")

    ec2_findings = scan_ec2(client, asg_instance_ids, config)
    findings.extend(ec2_findings)
    print(f"Found {len(ec2_findings)} idle EC2 instances")

    ebs_findings = scan_ebs(client, config)
    findings.extend(ebs_findings)
    print(f"Found {len(ebs_findings)} orphaned EBS volumes")

    lb_findings = scan_lb(client, config)
    findings.extend(lb_findings)
    print(f"Found {len(lb_findings)} unused load balancers")

    for finding in findings:
        finding["finding_id"] = generate_finding_id(finding)
        finding["account_id"] = config.account_id
        finding["detected_at"] = datetime.now(timezone.utc).isoformat()
        finding["status"] = "PENDING_ENRICHMENT"
        finding["ttl"] = int((datetime.now(timezone.utc) + timedelta(days=90)).timestamp())

        save_finding(finding)
        trigger_enrichment(finding["finding_id"])

    return {
        "statusCode": 200,
        "body": json.dumps({
            "scanned_at": datetime.now(timezone.utc).isoformat(),
            "findings_count": len(findings),
            "findings": [f["finding_id"] for f in findings],
        }),
    }


def get_scan_config() -> ScanConfig:
    table = dynamodb.Table(CONFIG_TABLE)
    response = table.get_item(Key={"config_key": "scan_config"})
    item = response.get("Item", {})

    return ScanConfig(
        cpu_threshold_percent=item.get("cpu_threshold_percent", 5.0),
        cpu_hours=item.get("cpu_hours", 24),
        network_idle_bytes=item.get("network_idle_bytes", 1024 * 1024),
        ebs_unattached_days=item.get("ebs_unattached_days", 7),
        ebs_no_snapshot_days=item.get("ebs_no_snapshot_days", 30),
        lb_idle_days=item.get("lb_idle_days", 7),
        excluded_tags=item.get("excluded_tags", {
            "Environment": ["prod", "production"],
            "CostJanitor": ["ignore", "do-not-delete"],
        }),
        role_arn=item.get("role_arn"),
        account_id=item.get("account_id", "unknown"),
    )


def get_asg_instance_ids(client: AWSClient) -> set:
    asg_ids = set()
    try:
        asgs = client.get_autoscaling_groups()
        for asg in asgs:
            for instance in asg.get("Instances", []):
                asg_ids.add(instance["InstanceId"])
    except Exception as e:
        print(f"Error getting ASG instances: {e}")
    return asg_ids


def scan_ec2(client: AWSClient, asg_instance_ids: set, config: ScanConfig) -> List[Dict]:
    findings = []
    instances = client.get_ec2_instances()

    for instance in instances:
        instance_id = instance["InstanceId"]
        try:
            metrics = client.get_instance_metrics(instance_id, hours=config.cpu_hours)
            finding = evaluate_ec2(instance, metrics, asg_instance_ids, config)
            if finding:
                finding["monthly_cost_usd"] = estimate_ec2_cost(
                    instance["InstanceType"], finding["region"]
                )
                findings.append(finding)
        except Exception as e:
            print(f"Error scanning EC2 {instance_id}: {e}")

    return findings


def scan_ebs(client: AWSClient, config: ScanConfig) -> List[Dict]:
    findings = []
    volumes = client.get_volumes()

    for volume in volumes:
        volume_id = volume["VolumeId"]
        try:
            snapshots = client.get_snapshots(volume_id)
            finding = evaluate_ebs(volume, snapshots, config)
            if finding:
                findings.append(finding)
        except Exception as e:
            print(f"Error scanning EBS {volume_id}: {e}")

    return findings


def scan_lb(client: AWSClient, config: ScanConfig) -> List[Dict]:
    findings = []
    lbs = client.get_load_balancers()

    for lb in lbs:
        lb_arn = lb["LoadBalancerArn"]
        try:
            target_groups = client.get_target_groups(lb_arn)
            target_health_map = {}
            for tg in target_groups:
                health = client.get_target_health(tg["TargetGroupArn"])
                target_health_map[tg["TargetGroupArn"]] = health

            metrics = client.get_lb_metrics(lb_arn, hours=config.lb_idle_days * 24)
            finding = evaluate_lb(lb, target_groups, target_health_map, metrics, config)
            if finding:
                findings.append(finding)
        except Exception as e:
            print(f"Error scanning LB {lb_arn}: {e}")

    return findings


def generate_finding_id(finding: Dict) -> str:
    resource_type = finding["resource_type"]
    resource_id = finding["resource_id"]
    date_str = datetime.now(timezone.utc).strftime("%Y%m%d")
    return f"f-{resource_type.lower()}-{resource_id}-{date_str}"


def save_finding(finding: Dict):
    table = dynamodb.Table(FINDINGS_TABLE)
    table.put_item(Item=finding)


def trigger_enrichment(finding_id: str):
    lambda_client.invoke(
        FunctionName=ENRICHMENT_FUNCTION,
        InvocationType="Event",
        Payload=json.dumps({"finding_id": finding_id}),
    )