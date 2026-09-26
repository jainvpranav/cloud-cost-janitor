import json

import pytest

from conftest import load
from common.ddb import to_ddb

ORIGIN = "https://d111.cloudfront.net"


@pytest.fixture
def api(aws, fake_lambda):
    mod = load("api_lambda", "approval/api.py")
    mod.lambda_client = fake_lambda
    return mod


def req(api, method, path, body=None, params=None, origin=ORIGIN, raw_body=None):
    event = {"httpMethod": method, "path": path, "headers": {"Origin": origin} if origin else {},
             "queryStringParameters": params,
             "body": raw_body if raw_body is not None else (json.dumps(body) if body is not None else None)}
    r = api.handler(event, None)
    return r["statusCode"], (json.loads(r["body"]) if r["body"] else None), r["headers"]


def seed_approval(aws, cost, required):
    aws.Table("findings").put_item(Item=to_ddb({"finding_id": "f1", "resource_type": "ELB", "resource_id": "lb",
                                                "status": "PENDING_APPROVAL", "monthly_cost_usd": cost}))
    aws.Table("approvals").put_item(Item=to_ddb({"approval_id": "a1", "finding_id": "f1", "status": "PENDING",
                                                 "required_approvals": required, "votes": []}))


@pytest.mark.parametrize("method,path,raw", [
    ("OPTIONS", "/approvals/a1/vote", None),
    ("GET", "/nope", None),
    ("PUT", "/config", "not json"),
    ("GET", "/findings", None),
])
def test_cors_headers_on_every_response(api, method, path, raw):
    status, body, headers = req(api, method, path, raw_body=raw)
    assert headers["Access-Control-Allow-Origin"] == ORIGIN
    assert "POST" in headers["Access-Control-Allow-Methods"]
    assert {"OPTIONS": 204, "GET /nope": 404, "PUT": 400, "GET /findings": 200}.get(
        method if method != "GET" else f"GET {path}") == status


def test_localhost_origin_is_echoed(api):
    _, _, headers = req(api, "GET", "/findings", origin="http://localhost:3000")
    assert headers["Access-Control-Allow-Origin"] == "http://localhost:3000"


def test_unknown_origin_gets_primary_origin(api):
    _, _, headers = req(api, "GET", "/findings", origin="https://evil.example.com")
    assert headers["Access-Control-Allow-Origin"] == ORIGIN


def test_numbers_are_numbers(api, aws):
    seed_approval(aws, 16.43, 2)
    _, body, _ = req(api, "GET", "/findings")
    assert body["items"][0]["monthly_cost_usd"] == 16.43


def test_dual_approval_needs_two_different_people(api, aws):
    seed_approval(aws, 16.43, 2)
    status, body, _ = req(api, "POST", "/approvals/a1/vote", {"decision": "approve", "user": "alice"})
    assert status == 200 and body["status"] == "PENDING" and body["required_approvals"] == 2
    status, body, _ = req(api, "POST", "/approvals/a1/vote", {"decision": "approve", "user": "Alice"})
    assert status == 400 and "already voted" in body["error"]
    status, body, _ = req(api, "POST", "/approvals/a1/vote", {"decision": "approve", "user": "bob"})
    assert status == 200 and body["status"] == "APPROVED"
    assert aws.Table("findings").get_item(Key={"finding_id": "f1"})["Item"]["status"] == "APPROVED"


def test_placeholder_user_is_rejected(api, aws):
    seed_approval(aws, 1.0, 1)
    status, body, _ = req(api, "POST", "/approvals/a1/vote", {"decision": "approve", "user": "current-user"})
    assert status == 400 and "name" in body["error"]


def test_approvals_all_returns_every_status(api, aws):
    seed_approval(aws, 1.0, 1)
    aws.Table("approvals").put_item(Item={"approval_id": "a2", "finding_id": "f1", "status": "APPROVED", "votes": []})
    _, body, _ = req(api, "GET", "/approvals", params={"status": "all"})
    assert {a["status"] for a in body["items"]} == {"PENDING", "APPROVED"}
    _, body, _ = req(api, "GET", "/approvals")
    assert len(body["items"]) == 2
    _, body, _ = req(api, "GET", "/approvals", params={"status": "PENDING"})
    assert [a["approval_id"] for a in body["items"]] == ["a1"]
    assert body["items"][0]["finding"]["finding_id"] == "f1"


def test_config_merges_and_splits_guardrails(api, aws):
    req(api, "PUT", "/config", {"cpu_hours": 24, "role_arn": ""})
    req(api, "PUT", "/config", {"cpu_hours": 1, "scope_tags": {"CostJanitor": ["demo"]},
                                "dual_approval_threshold_usd": 10})
    _, body, _ = req(api, "GET", "/config")
    assert body["cpu_hours"] == 1 and "role_arn" in body and body["scope_tags"] == {"CostJanitor": ["demo"]}
    assert body["guardrails"]["dual_approval_threshold_usd"] == 10
    assert body["guardrails"]["max_teardown_cost_usd"] == 1000.0
    stored = aws.Table("config").get_item(Key={"config_key": "scan_config"})["Item"]
    assert "dual_approval_threshold_usd" not in stored


def test_scan_and_teardown_start_jobs(api, aws, fake_lambda):
    status, body, _ = req(api, "POST", "/scan")
    assert status == 202
    scan_job = body["job_id"]
    status, body, _ = req(api, "POST", "/teardown", {"approval_id": "a1", "dry_run": True})
    assert status == 202 and body["dry_run"] is True
    assert [c["FunctionName"] for c in fake_lambda.calls] == ["scanner-fn", "teardown-fn"]
    assert json.loads(fake_lambda.calls[1]["Payload"])["job_id"] == body["job_id"]
    status, job, _ = req(api, "GET", f"/jobs/{scan_job}")
    assert status == 200 and job["kind"] == "scan"
    status, _, _ = req(api, "GET", "/jobs/missing")
    assert status == 404


def test_activity_feed(api, aws):
    req(api, "POST", "/scan")
    _, body, _ = req(api, "GET", "/activity")
    assert body["items"][0]["tool"] == "run_scan" and body["items"][0]["actor"] == "dashboard"


def test_limit_is_capped(api):
    status, _, _ = req(api, "GET", "/findings", params={"limit": "100000"})
    assert status == 200
    status, body, _ = req(api, "GET", "/findings", params={"limit": "abc"})
    assert status == 400
