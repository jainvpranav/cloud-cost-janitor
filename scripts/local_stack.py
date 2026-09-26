"""Run the whole backend locally against a simulated AWS account (moto). No AWS needed.

    .venv/bin/python scripts/local_stack.py            # http://127.0.0.1:8787/prod
    cd frontend && REACT_APP_API_URL=http://127.0.0.1:8787/prod npm start

Serves the dashboard API at /prod/* and the MCP server at /prod/mcp (point a local
TrueForge agent there). The simulated account holds the same six resources as the
demo stack, with CloudWatch CPU data, so "Run scan" finds the same four items.
Scans and teardowns run the real Lambda code in background threads.
"""
import argparse
import base64
import json
import os
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qsl, urlsplit

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path[:0] = [str(BACKEND / "mcp_server"), str(BACKEND / "scanner"), str(BACKEND), str(BACKEND / "tests")]

import conftest  # noqa: E402  (sets test env vars on import; overridden below)

os.environ.update({
    "AWS_DEFAULT_REGION": "us-east-1", "AWS_REGION": "us-east-1",
    "AWS_ACCESS_KEY_ID": "local", "AWS_SECRET_ACCESS_KEY": "local",
    "ENVIRONMENT": "local", "FINDINGS_TABLE": "findings", "APPROVALS_TABLE": "approvals",
    "CONFIG_TABLE": "config", "JOBS_TABLE": "jobs", "ACTIVITY_TABLE": "activity",
    "SCANNER_FUNCTION": "scanner", "TEARDOWN_FUNCTION": "teardown",
    "ALLOWED_ORIGIN": "http://localhost:3000,http://127.0.0.1:3000",
})

import boto3  # noqa: E402
from moto import mock_aws  # noqa: E402

STAGE = "/prod"
DEMO = [{"Key": "CostJanitor", "Value": "demo"}, {"Key": "Project", "Value": "janitor-demo"}]


class LocalLambda:
    """Stands in for the Lambda service: runs the real handlers in a thread."""

    def __init__(self, handlers):
        self.handlers = handlers

    def invoke(self, FunctionName, Payload="{}", InvocationType="Event", **_):
        event = json.loads(Payload)
        handler = self.handlers[FunctionName]
        threading.Thread(target=self._run, args=(FunctionName, handler, event), daemon=True).start()
        return {"StatusCode": 202}

    @staticmethod
    def _run(name, handler, event):
        try:
            result = handler(event, None)
            print(f"[lambda:{name}] {str(result)[:200]}")
        except Exception as e:  # keep the server alive
            print(f"[lambda:{name}] failed: {e}")


def seed_account():
    conftest.create_tables(boto3.resource("dynamodb"))
    boto3.resource("dynamodb").Table("config").put_item(Item={
        "config_key": "scan_config", "cpu_hours": 1, "cpu_threshold_percent": 5,
        "network_idle_bytes": 52428800, "ebs_unattached_days": 0, "lb_idle_days": 0,
        "scope_tags": {"CostJanitor": ["demo"]}, "account_id": "000000000000", "role_arn": "",
        "excluded_tags": {"Environment": ["prod", "production"], "CostJanitor": ["ignore", "do-not-delete"]},
    })
    boto3.resource("dynamodb").Table("config").put_item(Item={"config_key": "guardrails",
                                                              "dual_approval_threshold_usd": 10})

    ec2 = boto3.client("ec2")
    vpc = ec2.describe_vpcs()["Vpcs"][0]["VpcId"]
    subnets = [s["SubnetId"] for s in ec2.describe_subnets(Filters=[{"Name": "vpc-id", "Values": [vpc]}])["Subnets"]][:2]
    ami = ec2.describe_images(Owners=["amazon"])["Images"][0]["ImageId"]

    def instance(name, cpu):
        iid = ec2.run_instances(
            ImageId=ami, MinCount=1, MaxCount=1, InstanceType="t3.micro", SubnetId=subnets[0],
            TagSpecifications=[{"ResourceType": "instance", "Tags": DEMO + [{"Key": "Name", "Value": name}]}],
        )["Instances"][0]["InstanceId"]
        cw = boto3.client("cloudwatch")
        now = datetime.now(timezone.utc)
        for i in range(12):
            ts = now - timedelta(minutes=5 * i + 1)
            cw.put_metric_data(Namespace="AWS/EC2", MetricData=[
                {"MetricName": "CPUUtilization", "Dimensions": [{"Name": "InstanceId", "Value": iid}],
                 "Timestamp": ts, "Value": cpu, "Unit": "Percent"},
                {"MetricName": "NetworkIn", "Dimensions": [{"Name": "InstanceId", "Value": iid}],
                 "Timestamp": ts, "Value": 2048, "Unit": "Bytes"},
            ])
        return iid

    instance("demo-forgotten-dev-box", 0.4)
    instance("demo-busy-api", 48.0)
    for name, size, vtype, extra in [("demo-orphan-data", 20, "gp3", []), ("demo-old-backup-disk", 100, "gp2", []),
                                     ("demo-prod-db-disk", 5, "gp3", [{"Key": "Environment", "Value": "prod"}])]:
        ec2.create_volume(AvailabilityZone="us-east-1a", Size=size, VolumeType=vtype, TagSpecifications=[
            {"ResourceType": "volume", "Tags": DEMO + extra + [{"Key": "Name", "Value": name}]}])
    boto3.client("elbv2").create_load_balancer(Name="demo-legacy-alb", Subnets=subnets, Scheme="internal",
                                               Type="application", Tags=DEMO)
    print("Seeded simulated account: 2 instances (1 idle, 1 busy), 3 volumes (1 prod), 1 ALB")


def make_handler(api, mcp_handler):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            print(f"[http] {self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")

        def _dispatch(self):
            url = urlsplit(self.path)
            if not url.path.startswith(STAGE + "/"):
                return self._send(404, {"error": f"Use the {STAGE} prefix"}, {})
            path = url.path[len(STAGE):]
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length).decode() if length else None
            headers = {k: v for k, v in self.headers.items()}
            event = {
                "httpMethod": self.command, "path": path, "resource": path, "headers": headers,
                "multiValueHeaders": {}, "queryStringParameters": dict(parse_qsl(url.query)) or None,
                "multiValueQueryStringParameters": None, "body": body, "isBase64Encoded": False,
                "requestContext": {"resourcePath": path, "httpMethod": self.command, "path": url.path,
                                   "stage": STAGE.strip("/"), "identity": {"sourceIp": "127.0.0.1"},
                                   "requestId": "local"},
            }
            result = (mcp_handler if path == "/mcp" else api.handler)(event, None)
            out = result.get("body") or ""
            if result.get("isBase64Encoded"):
                out = base64.b64decode(out)
            self._send(result["statusCode"], out, result.get("headers") or {})

        def _send(self, status, body, headers):
            data = body if isinstance(body, bytes) else (body if isinstance(body, str) else json.dumps(body)).encode()
            self.send_response(status)
            for k, v in headers.items():
                if k.lower() not in ("content-length", "transfer-encoding", "connection"):
                    self.send_header(k, v)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        do_GET = do_POST = do_PUT = do_DELETE = do_OPTIONS = _dispatch

    return Handler


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=8787)
    args = parser.parse_args()

    with mock_aws():
        seed_account()
        load = conftest.load
        scanner = load("local_scanner", "scanner/lambda_function.py")
        teardown = load("local_teardown", "teardown/lambda_function.py")
        api = load("local_api", "approval/api.py")
        mcp_lambda = load("local_mcp", "mcp_server/lambda_function.py")
        import janitor_tools

        fake = LocalLambda({"scanner": scanner.handler, "teardown": teardown.handler})
        api.lambda_client = fake
        janitor_tools.lam = lambda: fake

        server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(api, mcp_lambda.handler))
        print(f"API: http://127.0.0.1:{args.port}{STAGE}   MCP: http://127.0.0.1:{args.port}{STAGE}/mcp")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
