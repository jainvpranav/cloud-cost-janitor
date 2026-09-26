import datetime
import json
import os
from typing import Dict, List, Optional, Tuple

import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from rules import metric_period, monthly, EC2_HOURLY, UNKNOWN_EC2_MONTHLY

PRICING_REGION = "us-east-1"


class AWSClient:
    def __init__(self, role_arn: str = None, region: str = "us-east-1", external_id: str = None):
        self.region = region
        self.role_arn = role_arn
        self.external_id = external_id or os.environ.get("EXTERNAL_ID", "cost-janitor")
        self._session = None
        self._clients = {}
        self._price_cache: Dict[Tuple[str, str], Tuple[float, str]] = {}

    def _get_session(self) -> boto3.Session:
        if self._session is None:
            if self.role_arn:
                sts = boto3.client("sts", region_name=self.region)
                response = sts.assume_role(
                    RoleArn=self.role_arn,
                    RoleSessionName="cost-janitor",
                    ExternalId=self.external_id,
                )
                creds = response["Credentials"]
                self._session = boto3.Session(
                    aws_access_key_id=creds["AccessKeyId"],
                    aws_secret_access_key=creds["SecretAccessKey"],
                    aws_session_token=creds["SessionToken"],
                    region_name=self.region,
                )
            else:
                self._session = boto3.Session(region_name=self.region)
        return self._session

    def client(self, service: str, region: Optional[str] = None):
        region = region or self.region
        key = (service, region)
        if key not in self._clients:
            self._clients[key] = self._get_session().client(
                service, region_name=region, config=Config(retries={"max_attempts": 3, "mode": "adaptive"})
            )
        return self._clients[key]

    # Kept for callers that predate the region argument.
    def _get_client(self, service: str):
        return self.client(service)

    def get_ec2_instances(self) -> List[Dict]:
        ec2 = self.client("ec2")
        instances = []
        paginator = ec2.get_paginator("describe_instances")
        for page in paginator.paginate():
            for reservation in page["Reservations"]:
                for instance in reservation["Instances"]:
                    if instance["State"]["Name"] in ["running", "stopped"]:
                        instances.append(instance)
        return instances

    def get_instance(self, instance_id: str) -> Optional[Dict]:
        ec2 = self.client("ec2")
        try:
            reservations = ec2.describe_instances(InstanceIds=[instance_id])["Reservations"]
        except ClientError as e:
            if "InvalidInstanceID" in str(e):
                return None
            raise
        for reservation in reservations:
            for instance in reservation["Instances"]:
                return instance
        return None

    def get_instance_metrics(self, instance_id: str, hours: int = 24) -> Dict:
        cw = self.client("cloudwatch")
        period = metric_period(hours)
        end = datetime.datetime.now(datetime.timezone.utc)
        start = end - datetime.timedelta(hours=hours)
        dims = [{"Name": "InstanceId", "Value": instance_id}]

        cpu = cw.get_metric_statistics(
            Namespace="AWS/EC2", MetricName="CPUUtilization", Dimensions=dims,
            StartTime=start, EndTime=end, Period=period, Statistics=["Average", "Maximum"],
        )["Datapoints"]
        network = cw.get_metric_statistics(
            Namespace="AWS/EC2", MetricName="NetworkIn", Dimensions=dims,
            StartTime=start, EndTime=end, Period=period, Statistics=["Sum"],
        )["Datapoints"]

        return {
            "cpu_avg": sum(d["Average"] for d in cpu) / len(cpu) if cpu else 0,
            "cpu_max": max(d["Maximum"] for d in cpu) if cpu else 0,
            "network_in_bytes": sum(d["Sum"] for d in network) if network else 0,
            "datapoints": len(cpu),
        }

    def get_volumes(self) -> List[Dict]:
        ec2 = self.client("ec2")
        volumes = []
        paginator = ec2.get_paginator("describe_volumes")
        for page in paginator.paginate():
            volumes.extend(page["Volumes"])
        return volumes

    def get_volume(self, volume_id: str) -> Optional[Dict]:
        ec2 = self.client("ec2")
        try:
            volumes = ec2.describe_volumes(VolumeIds=[volume_id])["Volumes"]
        except ClientError as e:
            if "InvalidVolume" in str(e):
                return None
            raise
        return volumes[0] if volumes else None

    def get_snapshots(self, volume_id: str) -> List[Dict]:
        ec2 = self.client("ec2")
        response = ec2.describe_snapshots(
            Filters=[{"Name": "volume-id", "Values": [volume_id]}],
            OwnerIds=["self"],
        )
        return response["Snapshots"]

    def get_load_balancers(self) -> List[Dict]:
        elbv2 = self.client("elbv2")
        lbs = []
        paginator = elbv2.get_paginator("describe_load_balancers")
        for page in paginator.paginate():
            lbs.extend(page["LoadBalancers"])
        self._attach_lb_tags(lbs)
        return lbs

    def get_load_balancer(self, lb_arn: str) -> Optional[Dict]:
        elbv2 = self.client("elbv2")
        try:
            lbs = elbv2.describe_load_balancers(LoadBalancerArns=[lb_arn])["LoadBalancers"]
        except elbv2.exceptions.LoadBalancerNotFoundException:
            return None
        self._attach_lb_tags(lbs)
        return lbs[0] if lbs else None

    def _attach_lb_tags(self, lbs: List[Dict]) -> None:
        # describe_load_balancers does not return tags; without this the prod
        # exclusion never applies to load balancers.
        elbv2 = self.client("elbv2")
        by_arn = {lb["LoadBalancerArn"]: lb for lb in lbs}
        arns = list(by_arn)
        for i in range(0, len(arns), 20):
            for desc in elbv2.describe_tags(ResourceArns=arns[i:i + 20])["TagDescriptions"]:
                by_arn[desc["ResourceArn"]]["Tags"] = desc.get("Tags", [])

    def get_target_groups(self, lb_arn: str) -> List[Dict]:
        elbv2 = self.client("elbv2")
        try:
            return elbv2.describe_target_groups(LoadBalancerArn=lb_arn)["TargetGroups"]
        except ClientError as e:
            if e.response["Error"]["Code"] == "TargetGroupNotFound":
                return []
            raise

    def get_target_health(self, target_group_arn: str) -> List[Dict]:
        elbv2 = self.client("elbv2")
        response = elbv2.describe_target_health(TargetGroupArn=target_group_arn)
        return response["TargetHealthDescriptions"]

    def get_lb_metrics(self, lb_arn: str, hours: int = 168) -> Dict:
        if hours <= 0:
            return {"request_count": 0}
        cw = self.client("cloudwatch")
        dimension, namespace, metric = lb_metric_target(lb_arn)
        end = datetime.datetime.now(datetime.timezone.utc)
        start = end - datetime.timedelta(hours=hours)

        points = cw.get_metric_statistics(
            Namespace=namespace, MetricName=metric,
            Dimensions=[{"Name": "LoadBalancer", "Value": dimension}],
            StartTime=start, EndTime=end, Period=metric_period(hours), Statistics=["Sum"],
        )["Datapoints"]

        return {"request_count": sum(d["Sum"] for d in points) if points else 0}

    def get_autoscaling_groups(self) -> List[Dict]:
        asg = self.client("autoscaling")
        groups = []
        paginator = asg.get_paginator("describe_auto_scaling_groups")
        for page in paginator.paginate():
            groups.extend(page["AutoScalingGroups"])
        return groups

    def get_ec2_monthly_price(self, instance_type: str, region: str) -> Tuple[float, str]:
        key = (instance_type, region)
        if key not in self._price_cache:
            hourly = self.get_pricing(instance_type, region)
            if hourly is not None:
                self._price_cache[key] = (monthly(hourly), "pricing_api")
            elif instance_type in EC2_HOURLY:
                self._price_cache[key] = (monthly(EC2_HOURLY[instance_type]), "table")
            else:
                self._price_cache[key] = (UNKNOWN_EC2_MONTHLY, "default")
        return self._price_cache[key]

    def get_pricing(self, instance_type: str, region: str = "us-east-1") -> Optional[float]:
        # The Pricing API only has endpoints in a few regions.
        pricing = self.client("pricing", region=PRICING_REGION)
        try:
            response = pricing.get_products(
                ServiceCode="AmazonEC2",
                Filters=[
                    {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
                    {"Type": "TERM_MATCH", "Field": "location", "Value": self._region_to_location(region)},
                    {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": "Linux"},
                    {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
                    {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
                    {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
                ],
                MaxResults=1,
            )
            if response["PriceList"]:
                price_data = json.loads(response["PriceList"][0])
                for term in price_data["terms"]["OnDemand"].values():
                    for price_dim in term["priceDimensions"].values():
                        value = float(price_dim["pricePerUnit"]["USD"])
                        return value if value > 0 else None
        except Exception as e:
            print(f"Pricing API lookup failed for {instance_type}: {e}")
        return None

    def _region_to_location(self, region: str) -> str:
        mapping = {
            "us-east-1": "US East (N. Virginia)",
            "us-east-2": "US East (Ohio)",
            "us-west-1": "US West (N. California)",
            "us-west-2": "US West (Oregon)",
            "eu-west-1": "EU (Ireland)",
            "eu-central-1": "EU (Frankfurt)",
            "ap-south-1": "Asia Pacific (Mumbai)",
            "ap-southeast-1": "Asia Pacific (Singapore)",
            "ap-southeast-3": "Asia Pacific (Jakarta)",
            "ap-northeast-1": "Asia Pacific (Tokyo)",
        }
        return mapping.get(region, "US East (N. Virginia)")


def lb_metric_target(lb_arn: str) -> Tuple[str, str, str]:
    """CloudWatch identifies a load balancer as app/<name>/<id> or net/<name>/<id>."""
    dimension = lb_arn.split(":loadbalancer/", 1)[1]
    if dimension.startswith("net/"):
        return dimension, "AWS/NetworkELB", "NewFlowCount"
    if dimension.startswith("gwy/"):
        return dimension, "AWS/GatewayELB", "NewFlowCount"
    return dimension, "AWS/ApplicationELB", "RequestCount"
