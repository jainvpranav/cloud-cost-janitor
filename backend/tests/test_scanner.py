import json

import boto3
import pytest

from conftest import load

DEMO = [{"Key": "CostJanitor", "Value": "demo"}]


@pytest.fixture
def scanner(aws, fake_lambda):
    mod = load("scanner_lambda", "scanner/lambda_function.py")
    mod.lambda_client = fake_lambda
    aws.Table("config").put_item(Item={
        "config_key": "scan_config", "cpu_hours": 1, "ebs_unattached_days": 0, "lb_idle_days": 0,
        "scope_tags": {"CostJanitor": ["demo"]}, "account_id": "123456789012",
    })
    return mod


def _volume(ec2, size, vtype, tags):
    return ec2.create_volume(AvailabilityZone="us-east-1a", Size=size, VolumeType=vtype,
                             TagSpecifications=[{"ResourceType": "volume", "Tags": tags}])["VolumeId"]


def _alb(tags):
    ec2 = boto3.client("ec2", region_name="us-east-1")
    vpc = ec2.create_vpc(CidrBlock="10.0.0.0/16")["Vpc"]["VpcId"]
    subnets = [ec2.create_subnet(VpcId=vpc, CidrBlock=f"10.0.{i}.0/24", AvailabilityZone=f"us-east-1{az}")["Subnet"]["SubnetId"]
               for i, az in ((1, "a"), (2, "b"))]
    elb = boto3.client("elbv2", region_name="us-east-1")
    return elb.create_load_balancer(Name=f"lb-{len(tags)}-{tags[-1]['Value']}", Subnets=subnets, Scheme="internal",
                                    Type="application", Tags=tags)["LoadBalancers"][0]["LoadBalancerArn"]


def test_scan_saves_findings_with_float_costs_and_job(scanner, aws):
    ec2 = boto3.client("ec2", region_name="us-east-1")
    orphan = _volume(ec2, 20, "gp3", DEMO)
    _volume(ec2, 100, "gp2", DEMO)
    _volume(ec2, 5, "gp3", DEMO + [{"Key": "Environment", "Value": "prod"}])
    _volume(ec2, 50, "gp2", [{"Key": "Team", "Value": "data"}])  # out of scope
    _alb(DEMO)

    aws.Table("jobs").put_item(Item={"job_id": "scan-1", "kind": "scan", "status": "QUEUED"})
    out = json.loads(scanner.handler({"job_id": "scan-1"}, None)["body"])

    assert out["findings_count"] == 3
    assert out["by_type"] == {"EBS": 2, "ELB": 1}
    assert out["monthly_waste_usd"] == 28.03
    items = aws.Table("findings").scan()["Items"]
    costs = sorted(float(i["monthly_cost_usd"]) for i in items)
    assert costs == [1.6, 10.0, 16.43]
    assert {i["resource_id"] for i in items if i["resource_type"] == "EBS"} >= {orphan}
    job = aws.Table("jobs").get_item(Key={"job_id": "scan-1"})["Item"]
    assert job["status"] == "SUCCEEDED" and int(job["findings_count"]) == 3


def test_prod_tagged_load_balancer_is_excluded(scanner, aws):
    _alb(DEMO + [{"Key": "Environment", "Value": "prod"}])
    out = json.loads(scanner.handler({}, None)["body"])
    assert out["by_type"] == {}


def test_rescan_does_not_duplicate_or_reset_status(scanner, aws):
    ec2 = boto3.client("ec2", region_name="us-east-1")
    _volume(ec2, 20, "gp3", DEMO)
    scanner.handler({}, None)
    item = aws.Table("findings").scan()["Items"][0]
    aws.Table("findings").update_item(Key={"finding_id": item["finding_id"]}, UpdateExpression="SET #s = :s",
                                      ExpressionAttributeNames={"#s": "status"},
                                      ExpressionAttributeValues={":s": "PENDING_APPROVAL"})
    out = json.loads(scanner.handler({}, None)["body"])
    assert out["findings_count"] == 0 and out["already_open"] == 1
    assert aws.Table("findings").get_item(Key={"finding_id": item["finding_id"]})["Item"]["status"] == "PENDING_APPROVAL"


def test_enrichment_not_called_by_default(scanner, fake_lambda):
    ec2 = boto3.client("ec2", region_name="us-east-1")
    _volume(ec2, 20, "gp3", DEMO)
    scanner.handler({}, None)
    assert fake_lambda.calls == []


def test_scheduled_scan_creates_its_own_job(scanner, aws):
    out = json.loads(scanner.handler({}, None)["body"])
    assert out["job_id"].startswith("scheduled-")
    assert aws.Table("jobs").get_item(Key={"job_id": out["job_id"]})["Item"]["status"] == "SUCCEEDED"
