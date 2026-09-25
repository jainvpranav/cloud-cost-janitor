from typing import Dict, List, Any, Optional
from dataclasses import dataclass
from datetime import datetime, timedelta


@dataclass
class ScanConfig:
    cpu_threshold_percent: float = 5.0
    cpu_hours: int = 24
    network_idle_bytes: int = 1024 * 1024
    ebs_unattached_days: int = 7
    ebs_no_snapshot_days: int = 30
    lb_idle_days: int = 7
    excluded_tags: Dict[str, List[str]] = None

    def __post_init__(self):
        if self.excluded_tags is None:
            self.excluded_tags = {
                "Environment": ["prod", "production"],
                "CostJanitor": ["ignore", "do-not-delete"],
            }


def is_excluded(resource_tags: Dict[str, str], config: ScanConfig) -> bool:
    for key, values in config.excluded_tags.items():
        if resource_tags.get(key) in values:
            return True
    return False


def evaluate_ec2(instance: Dict, metrics: Dict, asg_instance_ids: set, config: ScanConfig) -> Optional[Dict]:
    instance_id = instance["InstanceId"]
    state = instance["State"]["Name"]
    tags = {t["Key"]: t["Value"] for t in instance.get("Tags", [])}

    if is_excluded(tags, config):
        return None

    if instance_id in asg_instance_ids:
        return None

    if state != "running":
        return None

    cpu_avg = metrics.get("cpu_avg", 0)
    network_in = metrics.get("network_in_bytes", 0)

    if cpu_avg < config.cpu_threshold_percent and network_in < config.network_idle_bytes:
        return {
            "resource_type": "EC2",
            "resource_id": instance_id,
            "region": instance["Placement"]["AvailabilityZone"][:-1],
            "evidence": {
                "cpu_avg_24h": round(cpu_avg, 2),
                "cpu_max_24h": round(metrics.get("cpu_max", 0), 2),
                "network_in_bytes_24h": network_in,
                "instance_type": instance["InstanceType"],
                "state": state,
                "launch_time": instance["LaunchTime"].isoformat() if isinstance(instance.get("LaunchTime"), datetime) else instance.get("LaunchTime"),
            },
            "tags": tags,
            "monthly_cost_usd": 0,
        }
    return None


def evaluate_ebs(volume: Dict, snapshots: List[Dict], config: ScanConfig) -> Optional[Dict]:
    volume_id = volume["VolumeId"]
    state = volume["State"]
    tags = {t["Key"]: t["Value"] for t in volume.get("Tags", [])}

    if is_excluded(tags, config):
        return None

    if state != "available":
        return None

    create_time = volume["CreateTime"]
    if isinstance(create_time, str):
        create_time = datetime.fromisoformat(create_time.replace("Z", "+00:00"))
    age_days = (datetime.now(create_time.tzinfo) - create_time).days

    if age_days < config.ebs_unattached_days:
        return None

    has_recent_snapshot = False
    for snap in snapshots:
        snap_time = snap["StartTime"]
        if isinstance(snap_time, str):
            snap_time = datetime.fromisoformat(snap_time.replace("Z", "+00:00"))
        if (datetime.now(snap_time.tzinfo) - snap_time).days < config.ebs_no_snapshot_days:
            has_recent_snapshot = True
            break

    if has_recent_snapshot:
        return None

    size_gb = volume["Size"]
    volume_type = volume["VolumeType"]
    monthly_cost = estimate_ebs_cost(volume_type, size_gb)

    return {
        "resource_type": "EBS",
        "resource_id": volume_id,
        "region": volume["AvailabilityZone"][:-1],
        "evidence": {
            "size_gb": size_gb,
            "volume_type": volume_type,
            "state": state,
            "age_days": age_days,
            "create_time": create_time.isoformat(),
            "snapshot_count": len(snapshots),
            "has_recent_snapshot": has_recent_snapshot,
        },
        "tags": tags,
        "monthly_cost_usd": monthly_cost,
    }


def evaluate_lb(lb: Dict, target_groups: List[Dict], target_health_map: Dict, metrics: Dict, config: ScanConfig) -> Optional[Dict]:
    lb_arn = lb["LoadBalancerArn"]
    lb_name = lb["LoadBalancerName"]
    lb_type = lb["Type"]
    tags = {t["Key"]: t["Value"] for t in lb.get("Tags", [])}

    if is_excluded(tags, config):
        return None

    has_healthy_targets = False
    for tg in target_groups:
        health = target_health_map.get(tg["TargetGroupArn"], [])
        for target in health:
            if target["TargetHealth"]["State"] == "healthy":
                has_healthy_targets = True
                break
        if has_healthy_targets:
            break

    if has_healthy_targets:
        return None

    request_count = metrics.get("request_count", 0)
    if request_count > 0:
        return None

    created_time = lb["CreatedTime"]
    if isinstance(created_time, str):
        created_time = datetime.fromisoformat(created_time.replace("Z", "+00:00"))
    age_days = (datetime.now(created_time.tzinfo) - created_time).days

    if age_days < config.lb_idle_days:
        return None

    monthly_cost = estimate_lb_cost(lb_type)

    return {
        "resource_type": "ELB",
        "resource_id": lb_name,
        "resource_arn": lb_arn,
        "region": lb_arn.split(":")[3],
        "evidence": {
            "load_balancer_type": lb_type,
            "scheme": lb.get("Scheme"),
            "age_days": age_days,
            "created_time": created_time.isoformat(),
            "request_count_7d": request_count,
            "target_groups": len(target_groups),
            "healthy_targets": 0,
        },
        "tags": tags,
        "monthly_cost_usd": monthly_cost,
    }


def estimate_ebs_cost(volume_type: str, size_gb: int) -> float:
    prices_per_gb_month = {
        "gp2": 0.10,
        "gp3": 0.08,
        "io1": 0.125,
        "io2": 0.125,
        "st1": 0.045,
        "sc1": 0.025,
        "standard": 0.05,
    }
    return prices_per_gb_month.get(volume_type, 0.10) * size_gb


def estimate_lb_cost(lb_type: str) -> float:
    if lb_type == "application":
        return 16.43
    elif lb_type == "network":
        return 16.43
    elif lb_type == "gateway":
        return 16.43
    return 18.00


def estimate_ec2_cost(instance_type: str, region: str = "us-east-1") -> float:
    pricing = {
        "t3.micro": 7.59,
        "t3.small": 15.18,
        "t3.medium": 30.37,
        "t3.large": 60.74,
        "t3.xlarge": 121.47,
        "t3.2xlarge": 242.94,
        "m5.large": 69.12,
        "m5.xlarge": 138.24,
        "m5.2xlarge": 276.48,
        "m5.4xlarge": 552.96,
        "c5.large": 61.32,
        "c5.xlarge": 122.64,
        "c5.2xlarge": 245.28,
        "r5.large": 90.72,
        "r5.xlarge": 181.44,
    }
    return pricing.get(instance_type, 50.0)