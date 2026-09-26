import json

import boto3
import pytest

from conftest import load
from common.ddb import to_ddb

DEMO = [{"Key": "CostJanitor", "Value": "demo"}]


@pytest.fixture
def td(aws):
    mod = load("teardown_lambda", "teardown/lambda_function.py")
    aws.Table("config").put_item(Item={"config_key": "scan_config", "ebs_unattached_days": 0, "cpu_hours": 1,
                                       "lb_idle_days": 0})
    return mod


@pytest.fixture
def ec2():
    return boto3.client("ec2", region_name="us-east-1")


def seed(aws, resource_id, cost, votes=("alice",), status="APPROVED", required=1, tags=None, kind="EBS", arn=None):
    finding_id = f"f-{kind.lower()}-{resource_id}"
    finding = {"finding_id": finding_id, "resource_type": kind, "resource_id": resource_id, "region": "us-east-1",
               "monthly_cost_usd": cost, "status": "APPROVED" if status == "APPROVED" else "PENDING_APPROVAL",
               "tags": tags or {}, "account_id": "123"}
    if arn:
        finding["resource_arn"] = arn
    aws.Table("findings").put_item(Item=to_ddb(finding))
    aws.Table("approvals").put_item(Item=to_ddb({
        "approval_id": f"appr-{finding_id}", "finding_id": finding_id, "status": status,
        "required_approvals": required, "votes": [{"user": u, "decision": "approve"} for u in votes]}))
    return f"appr-{finding_id}", finding_id


def volume(ec2, tags=DEMO, size=20):
    return ec2.create_volume(AvailabilityZone="us-east-1a", Size=size, VolumeType="gp3",
                             TagSpecifications=[{"ResourceType": "volume", "Tags": tags}])["VolumeId"]


def call(td, approval_id, dry_run=False, job_id=None):
    r = td.handler({"approval_id": approval_id, "dry_run": dry_run, "job_id": job_id}, None)
    return r["statusCode"], json.loads(r["body"])


def test_pending_approval_cannot_be_executed(td, aws, ec2):
    appr, _ = seed(aws, volume(ec2), 1.6, votes=(), status="PENDING")
    status, body = call(td, appr)
    assert status == 400 and "PENDING" in body["error"]


def test_dry_run_allowed_while_pending(td, aws, ec2):
    appr, _ = seed(aws, volume(ec2), 1.6, votes=(), status="PENDING")
    status, body = call(td, appr, dry_run=True)
    assert status == 200 and body["dry_run"] is True
    assert any("snapshot" in a for a in body["simulated_actions"])


def test_live_prod_tag_blocks_teardown(td, aws, ec2):
    vol = volume(ec2, DEMO + [{"Key": "Environment", "Value": "prod"}])
    appr, _ = seed(aws, vol, 1.6, tags={})  # scan-time tags missed it; live tags must catch it
    status, body = call(td, appr)
    assert status == 403 and any("Environment=prod" in d for d in body["details"])


def test_dual_approval_threshold_from_config(td, aws, ec2):
    aws.Table("config").put_item(Item={"config_key": "guardrails", "dual_approval_threshold_usd": 10})
    appr, _ = seed(aws, volume(ec2), 16.43, votes=("alice",))
    status, body = call(td, appr)
    assert status == 403 and any("requires 2 approvals" in d for d in body["details"])


def test_cost_ceiling(td, aws, ec2):
    appr, _ = seed(aws, volume(ec2), 1500.0, votes=("a", "b"), required=2)
    status, body = call(td, appr)
    assert status == 403 and any("limit" in d for d in body["details"])


def test_ebs_happy_path_snapshots_then_deletes(td, aws, ec2):
    vol = volume(ec2)
    aws.Table("jobs").put_item(Item={"job_id": "td-1", "status": "QUEUED"})
    appr, finding_id = seed(aws, vol, 1.6)
    status, body = call(td, appr, job_id="td-1")
    assert status == 200 and body["success"] is True
    assert ec2.describe_volumes(Filters=[{"Name": "volume-id", "Values": [vol]}])["Volumes"] == []
    snaps = ec2.describe_snapshots(OwnerIds=["self"], Filters=[{"Name": "tag:CostJanitor", "Values": ["pre-delete"]}])
    assert len(snaps["Snapshots"]) == 1
    finding = aws.Table("findings").get_item(Key={"finding_id": finding_id})["Item"]
    assert finding["status"] == "TEARDOWN_COMPLETE"
    assert float(finding["realized_monthly_savings_usd"]) == 1.6
    assert aws.Table("jobs").get_item(Key={"job_id": "td-1"})["Item"]["status"] == "SUCCEEDED"

    status, body = call(td, appr)
    assert status == 409


def test_volume_attached_after_approval_is_skipped(td, aws, ec2):
    vol = volume(ec2)
    ami = ec2.describe_images(Owners=["amazon"])["Images"][0]["ImageId"]
    inst = ec2.run_instances(ImageId=ami, MinCount=1, MaxCount=1, InstanceType="t3.micro",
                             Placement={"AvailabilityZone": "us-east-1a"})["Instances"][0]["InstanceId"]
    appr, finding_id = seed(aws, vol, 1.6)
    ec2.attach_volume(VolumeId=vol, InstanceId=inst, Device="/dev/sdf")
    status, body = call(td, appr)
    assert status == 409 and "no longer idle" in body["error"]
    assert aws.Table("findings").get_item(Key={"finding_id": finding_id})["Item"]["status"] == "SKIPPED_NOW_ACTIVE"
    assert len(ec2.describe_volumes(VolumeIds=[vol])["Volumes"]) == 1


def test_missing_resource_is_marked_gone(td, aws, ec2):
    vol = volume(ec2)
    appr, finding_id = seed(aws, vol, 1.6)
    ec2.delete_volume(VolumeId=vol)
    status, _ = call(td, appr)
    assert status == 409
    assert aws.Table("findings").get_item(Key={"finding_id": finding_id})["Item"]["status"] == "RESOURCE_GONE"


def test_load_balancer_teardown(td, aws, ec2):
    vpc = ec2.create_vpc(CidrBlock="10.0.0.0/16")["Vpc"]["VpcId"]
    subnets = [ec2.create_subnet(VpcId=vpc, CidrBlock=f"10.0.{i}.0/24", AvailabilityZone=f"us-east-1{az}")["Subnet"]["SubnetId"]
               for i, az in ((1, "a"), (2, "b"))]
    elb = boto3.client("elbv2", region_name="us-east-1")
    arn = elb.create_load_balancer(Name="demo-legacy-alb", Subnets=subnets, Scheme="internal", Tags=DEMO)["LoadBalancers"][0]["LoadBalancerArn"]
    appr, _ = seed(aws, "demo-legacy-alb", 16.43, votes=("alice", "bob"), required=2, kind="ELB", arn=arn)
    status, body = call(td, appr)
    assert status == 200 and body["success"] is True
    assert elb.describe_load_balancers()["LoadBalancers"] == []
