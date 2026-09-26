import importlib.util
import os
import sys
from pathlib import Path

import boto3
import pytest
from moto import mock_aws

BACKEND = Path(__file__).resolve().parents[1]
for p in (BACKEND / "mcp_server", BACKEND / "scanner", BACKEND):
    if str(p) not in sys.path:
        sys.path.insert(0, str(p))

ENV = {
    "AWS_DEFAULT_REGION": "us-east-1",
    "AWS_REGION": "us-east-1",
    "AWS_ACCESS_KEY_ID": "testing",
    "AWS_SECRET_ACCESS_KEY": "testing",
    "AWS_SESSION_TOKEN": "testing",
    "ENVIRONMENT": "test",
    "FINDINGS_TABLE": "findings",
    "APPROVALS_TABLE": "approvals",
    "CONFIG_TABLE": "config",
    "JOBS_TABLE": "jobs",
    "ACTIVITY_TABLE": "activity",
    "SCANNER_FUNCTION": "scanner-fn",
    "TEARDOWN_FUNCTION": "teardown-fn",
    "ENRICHMENT_FUNCTION": "enrichment-fn",
    "ALLOWED_ORIGIN": "https://d111.cloudfront.net,http://localhost:3000",
}
os.environ.update(ENV)


def _gsi(name, key):
    return {"IndexName": name, "KeySchema": [{"AttributeName": key, "KeyType": "HASH"}],
            "Projection": {"ProjectionType": "ALL"}}


def create_tables(ddb):
    ddb.create_table(
        TableName="findings", BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": "S"} for n in ("finding_id", "status", "account_id")],
        KeySchema=[{"AttributeName": "finding_id", "KeyType": "HASH"}],
        GlobalSecondaryIndexes=[_gsi("status-index", "status"), _gsi("account-index", "account_id")],
    )
    ddb.create_table(
        TableName="approvals", BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": n, "AttributeType": "S"} for n in ("approval_id", "finding_id", "status")],
        KeySchema=[{"AttributeName": "approval_id", "KeyType": "HASH"}],
        GlobalSecondaryIndexes=[_gsi("finding-index", "finding_id"), _gsi("status-index", "status")],
    )
    for name, key in (("config", "config_key"), ("jobs", "job_id")):
        ddb.create_table(TableName=name, BillingMode="PAY_PER_REQUEST",
                         AttributeDefinitions=[{"AttributeName": key, "AttributeType": "S"}],
                         KeySchema=[{"AttributeName": key, "KeyType": "HASH"}])
    ddb.create_table(
        TableName="activity", BillingMode="PAY_PER_REQUEST",
        AttributeDefinitions=[{"AttributeName": "day", "AttributeType": "S"}, {"AttributeName": "ts", "AttributeType": "S"}],
        KeySchema=[{"AttributeName": "day", "KeyType": "HASH"}, {"AttributeName": "ts", "KeyType": "RANGE"}],
    )


@pytest.fixture
def aws():
    with mock_aws():
        ddb = boto3.resource("dynamodb", region_name="us-east-1")
        create_tables(ddb)
        yield ddb


def load(name: str, relpath: str):
    """Each Lambda is a module called lambda_function; load them under distinct names."""
    spec = importlib.util.spec_from_file_location(name, BACKEND / relpath)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeLambda:
    def __init__(self):
        self.calls = []

    def invoke(self, **kwargs):
        self.calls.append(kwargs)
        return {"StatusCode": 202}


@pytest.fixture
def fake_lambda():
    return FakeLambda()
