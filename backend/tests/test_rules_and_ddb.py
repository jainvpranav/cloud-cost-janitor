import json
from datetime import datetime, timedelta, timezone
from decimal import Decimal

from common.ddb import DecimalEncoder, from_ddb, to_ddb
from aws_client import lb_metric_target
import rules


def test_to_ddb_removes_floats():
    out = to_ddb({"a": 1.5, "b": [2.25], "c": {"d": 3}})
    assert out == {"a": Decimal("1.5"), "b": [Decimal("2.25")], "c": {"d": 3}}
    assert from_ddb(out) == {"a": 1.5, "b": [2.25], "c": {"d": 3}}


def test_decimal_encoder_keeps_ints_as_ints():
    assert json.loads(json.dumps({"n": Decimal("2"), "x": Decimal("7.59")}, cls=DecimalEncoder)) == {"n": 2, "x": 7.59}


def test_pricing_uses_730_hour_month_and_correct_rates():
    assert rules.estimate_ec2_cost("t3.micro") == 7.59
    assert rules.estimate_ec2_cost("m5.large") == 70.08
    assert rules.estimate_ec2_cost("r5.large") == 91.98
    assert rules.estimate_ec2_cost("x9.huge") == 50.0
    assert rules.estimate_ebs_cost("gp3", 20) == 1.6
    assert rules.estimate_ebs_cost("gp2", 100) == 10.0
    assert rules.estimate_ebs_cost("sc1", 1000) == 15.0
    assert rules.estimate_lb_cost("application") == 16.43
    assert rules.estimate_lb_cost("gateway") == 9.13
    assert rules.estimate_lb_cost("classic") == 18.25


def _instance(tags=None):
    return {
        "InstanceId": "i-1", "State": {"Name": "running"}, "InstanceType": "t3.micro",
        "Placement": {"AvailabilityZone": "us-east-1a"}, "Tags": tags or [],
        "LaunchTime": datetime.now(timezone.utc) - timedelta(hours=5),
    }


def test_ec2_without_metrics_is_not_idle():
    config = rules.ScanConfig(cpu_hours=1)
    assert rules.evaluate_ec2(_instance(), {"cpu_avg": 0, "network_in_bytes": 0, "datapoints": 0}, set(), config) is None


def test_ec2_idle_with_enough_datapoints():
    config = rules.ScanConfig(cpu_hours=1)
    finding = rules.evaluate_ec2(_instance(), {"cpu_avg": 0.4, "network_in_bytes": 10, "datapoints": 12}, set(), config)
    assert finding["resource_id"] == "i-1"
    assert finding["monthly_cost_usd"] == 7.59


def test_busy_ec2_is_not_flagged():
    config = rules.ScanConfig(cpu_hours=1)
    assert rules.evaluate_ec2(_instance(), {"cpu_avg": 48.0, "network_in_bytes": 10, "datapoints": 12}, set(), config) is None


def test_scope_tags_limit_what_is_scanned():
    config = rules.ScanConfig(cpu_hours=1, scope_tags={"CostJanitor": ["demo"]})
    metrics = {"cpu_avg": 0.1, "network_in_bytes": 0, "datapoints": 12}
    assert rules.evaluate_ec2(_instance(), metrics, set(), config) is None
    tagged = _instance([{"Key": "CostJanitor", "Value": "demo"}])
    assert rules.evaluate_ec2(tagged, metrics, set(), config) is not None


def test_scan_config_accepts_role_and_account():
    config = rules.ScanConfig(role_arn="", account_id="123")
    assert config.role_arn is None and config.account_id == "123"


def test_lb_metric_dimension():
    alb = "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/app/demo-alb/50dc6c495c0c9188"
    nlb = "arn:aws:elasticloadbalancing:us-east-1:123:loadbalancer/net/demo-nlb/abc"
    assert lb_metric_target(alb) == ("app/demo-alb/50dc6c495c0c9188", "AWS/ApplicationELB", "RequestCount")
    assert lb_metric_target(nlb) == ("net/demo-nlb/abc", "AWS/NetworkELB", "NewFlowCount")
