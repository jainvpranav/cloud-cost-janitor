import boto3
from botocore.config import Config
from typing import Dict, List, Any, Optional
import os


class AWSClient:
    def __init__(self, role_arn: str = None, region: str = "us-east-1", external_id: str = None):
        self.region = region
        self.role_arn = role_arn
        self.external_id = external_id or os.environ.get("EXTERNAL_ID", "cost-janitor")
        self._session = None
        self._clients = {}

    def _get_session(self) -> boto3.Session:
        if self._session is None:
            if self.role_arn:
                sts = boto3.client("sts", region_name=self.region)
                assume_params = {
                    "RoleArn": self.role_arn,
                    "RoleSessionName": "cost-janitor-scan",
                    "ExternalId": self.external_id,
                }
                response = sts.assume_role(**assume_params)
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

    def _get_client(self, service: str):
        if service not in self._clients:
            self._clients[service] = self._get_session().client(
                service, config=Config(retries={"max_attempts": 3, "mode": "adaptive"})
            )
        return self._clients[service]

    def get_ec2_instances(self) -> List[Dict]:
        ec2 = self._get_client("ec2")
        instances = []
        paginator = ec2.get_paginator("describe_instances")
        for page in paginator.paginate():
            for reservation in page["Reservations"]:
                for instance in reservation["Instances"]:
                    if instance["State"]["Name"] in ["running", "stopped"]:
                        instances.append(instance)
        return instances

    def get_instance_metrics(self, instance_id: str, hours: int = 24) -> Dict:
        cw = self._get_client("cloudwatch")
        end_time = boto3.Session().client("cloudwatch").meta.service_model.metadata["apiVersion"]
        import datetime
        end = datetime.datetime.utcnow()
        start = end - datetime.timedelta(hours=hours)

        cpu = cw.get_metric_statistics(
            Namespace="AWS/EC2",
            MetricName="CPUUtilization",
            Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=start,
            EndTime=end,
            Period=3600,
            Statistics=["Average", "Maximum"],
        )

        network = cw.get_metric_statistics(
            Namespace="AWS/EC2",
            MetricName="NetworkIn",
            Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
            StartTime=start,
            EndTime=end,
            Period=3600,
            Statistics=["Sum"],
        )

        return {
            "cpu_avg": sum(d["Average"] for d in cpu["Datapoints"]) / len(cpu["Datapoints"]) if cpu["Datapoints"] else 0,
            "cpu_max": max(d["Maximum"] for d in cpu["Datapoints"]) if cpu["Datapoints"] else 0,
            "network_in_bytes": sum(d["Sum"] for d in network["Datapoints"]) if network["Datapoints"] else 0,
        }

    def get_volumes(self) -> List[Dict]:
        ec2 = self._get_client("ec2")
        volumes = []
        paginator = ec2.get_paginator("describe_volumes")
        for page in paginator.paginate():
            for vol in page["Volumes"]:
                volumes.append(vol)
        return volumes

    def get_snapshots(self, volume_id: str) -> List[Dict]:
        ec2 = self._get_client("ec2")
        response = ec2.describe_snapshots(
            Filters=[{"Name": "volume-id", "Values": [volume_id]}],
            OwnerIds=["self"],
        )
        return response["Snapshots"]

    def get_load_balancers(self) -> List[Dict]:
        elbv2 = self._get_client("elbv2")
        lbs = []
        paginator = elbv2.get_paginator("describe_load_balancers")
        for page in paginator.paginate():
            lbs.extend(page["LoadBalancers"])
        return lbs

    def get_target_groups(self, lb_arn: str) -> List[Dict]:
        elbv2 = self._get_client("elbv2")
        response = elbv2.describe_target_groups(LoadBalancerArn=lb_arn)
        return response["TargetGroups"]

    def get_target_health(self, target_group_arn: str) -> List[Dict]:
        elbv2 = self._get_client("elbv2")
        response = elbv2.describe_target_health(TargetGroupArn=target_group_arn)
        return response["TargetHealthDescriptions"]

    def get_lb_metrics(self, lb_arn: str, hours: int = 168) -> Dict:
        cw = self._get_client("cloudwatch")
        lb_name = lb_arn.split("/")[-1]
        import datetime
        end = datetime.datetime.utcnow()
        start = end - datetime.timedelta(hours=hours)

        requests = cw.get_metric_statistics(
            Namespace="AWS/ApplicationELB",
            MetricName="RequestCount",
            Dimensions=[{"Name": "LoadBalancer", "Value": lb_name}],
            StartTime=start,
            EndTime=end,
            Period=3600,
            Statistics=["Sum"],
        )

        return {
            "request_count": sum(d["Sum"] for d in requests["Datapoints"]) if requests["Datapoints"] else 0,
        }

    def get_autoscaling_groups(self) -> List[Dict]:
        asg = self._get_client("autoscaling")
        groups = []
        paginator = asg.get_paginator("describe_auto_scaling_groups")
        for page in paginator.paginate():
            groups.extend(page["AutoScalingGroups"])
        return groups

    def get_pricing(self, instance_type: str, region: str = "us-east-1") -> float:
        pricing = self._get_client("pricing")
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
                import json
                price_data = json.loads(response["PriceList"][0])
                for term in price_data["terms"]["OnDemand"].values():
                    for price_dim in term["priceDimensions"].values():
                        return float(price_dim["pricePerUnit"]["USD"])
        except Exception:
            pass
        return self._fallback_price(instance_type)

    def _region_to_location(self, region: str) -> str:
        mapping = {
            "us-east-1": "US East (N. Virginia)",
            "us-east-2": "US East (Ohio)",
            "us-west-1": "US West (N. California)",
            "us-west-2": "US West (Oregon)",
            "eu-west-1": "EU (Ireland)",
            "eu-central-1": "EU (Frankfurt)",
            "ap-southeast-1": "Asia Pacific (Singapore)",
            "ap-northeast-1": "Asia Pacific (Tokyo)",
        }
        return mapping.get(region, "US East (N. Virginia)")

    def _fallback_price(self, instance_type: str) -> float:
        prices = {
            "t3.micro": 0.0104,
            "t3.small": 0.0208,
            "t3.medium": 0.0416,
            "t3.large": 0.0832,
            "t3.xlarge": 0.1664,
            "t3.2xlarge": 0.3328,
            "m5.large": 0.096,
            "m5.xlarge": 0.192,
            "m5.2xlarge": 0.384,
            "m5.4xlarge": 0.768,
            "c5.large": 0.085,
            "c5.xlarge": 0.17,
            "c5.2xlarge": 0.34,
            "r5.large": 0.126,
            "r5.xlarge": 0.252,
        }
        return prices.get(instance_type, 0.05)