import asyncio
import json

import pytest

from common.ddb import to_ddb

EXPECTED_TOOLS = {
    "run_scan", "get_job_status", "list_idle_instances", "list_orphaned_volumes", "list_idle_load_balancers",
    "get_cost_summary", "record_assessment", "draft_teardown_plan", "get_approval_status", "execute_teardown",
}


@pytest.fixture
def tools(aws, fake_lambda, monkeypatch):
    import janitor_tools as jt
    import server
    jt._dynamodb = None
    monkeypatch.setattr(jt, "lam", lambda: fake_lambda)
    t = aws.Table("findings")
    for fid, kind, rid, cost, tags in [
        ("f-ec2", "EC2", "i-1", 7.59, {"CostJanitor": "demo"}),
        ("f-ebs", "EBS", "vol-1", 1.6, {"CostJanitor": "demo"}),
        ("f-big", "EBS", "vol-2", 10.0, {"CostJanitor": "demo"}),
        ("f-alb", "ELB", "demo-legacy-alb", 16.43, {"CostJanitor": "demo"}),
        ("f-prod", "EBS", "vol-3", 0.4, {"Environment": "prod"}),
        ("f-done", "EBS", "vol-4", 3.0, {}),
    ]:
        t.put_item(Item=to_ddb({"finding_id": fid, "resource_type": kind, "resource_id": rid, "region": "us-east-1",
                                "monthly_cost_usd": cost, "tags": tags,
                                "status": "TEARDOWN_COMPLETE" if fid == "f-done" else "PENDING_ENRICHMENT"}))
    return server


def activity_rows(aws):
    return aws.Table("activity").scan()["Items"]


def test_exact_tool_list(tools):
    listed = asyncio.run(tools.mcp.list_tools())
    assert {t.name for t in listed} == EXPECTED_TOOLS


def test_lists_and_summary(tools):
    ebs = tools.list_orphaned_volumes()
    assert ebs["count"] == 3 and ebs["items"][0]["resource_id"] == "vol-2"
    summary = tools.get_cost_summary()
    assert summary["open_waste"]["monthly_usd"] == 36.02
    assert summary["reclaimed"] == {"count": 1, "monthly_usd": 3.0, "annual_usd": 36.0}


def test_plan_skips_protected_and_uses_guardrail_threshold(tools, aws):
    aws.Table("config").put_item(Item={"config_key": "guardrails", "dual_approval_threshold_usd": 10})
    plan = tools.draft_teardown_plan(finding_ids=["f-ec2", "f-ebs", "f-alb", "f-prod", "f-done"])
    by_id = {i["finding_id"]: i for i in plan["items"]}
    assert set(by_id) == {"f-ec2", "f-ebs", "f-alb"}
    assert by_id["f-alb"]["required_approvals"] == 2 and by_id["f-ec2"]["required_approvals"] == 1
    assert {s["finding_id"] for s in plan["skipped"]} == {"f-prod", "f-done"}
    assert plan["monthly_savings_usd"] == 25.62
    assert aws.Table("findings").get_item(Key={"finding_id": "f-alb"})["Item"]["status"] == "PENDING_APPROVAL"
    again = tools.draft_teardown_plan(finding_ids=["f-alb"])
    assert again["items"][0]["approval_id"] == "appr-f-alb"


def test_execute_refuses_until_approved(tools, aws, fake_lambda):
    tools.draft_teardown_plan(finding_ids=["f-ebs"])
    out = tools.execute_teardown(approval_id="appr-f-ebs")
    assert out["refused"] is True and "PENDING" in out["reason"]
    assert fake_lambda.calls == []
    rows = [r for r in activity_rows(aws) if r["tool"] == "execute_teardown"]
    assert len(rows) == 1 and rows[0]["ok"] is False

    aws.Table("approvals").update_item(Key={"approval_id": "appr-f-ebs"}, UpdateExpression="SET #s = :s",
                                       ExpressionAttributeNames={"#s": "status"},
                                       ExpressionAttributeValues={":s": "APPROVED"})
    out = tools.execute_teardown(approval_id="appr-f-ebs")
    assert out["executed"] is True
    payload = json.loads(fake_lambda.calls[0]["Payload"])
    assert payload == {"approval_id": "appr-f-ebs", "dry_run": False, "job_id": out["job_id"]}
    assert tools.get_job_status(job_id=out["job_id"])["status"] == "QUEUED"


def test_record_assessment_validates(tools, aws):
    out = tools.record_assessment(finding_id="f-ec2", risk="low", recommendation="delete", confidence=0.9,
                                  reasoning="CPU 0.3% for the whole window, no traffic, demo tag.")
    assert out["saved"] is True
    stored = aws.Table("findings").get_item(Key={"finding_id": "f-ec2"})["Item"]["enrichment"]
    assert stored["recommendation"] == "delete"
    with pytest.raises(ValueError):
        tools.record_assessment(finding_id="f-ec2", risk="low", recommendation="delete", confidence=3,
                                reasoning="x")


def test_every_call_is_logged(tools, aws):
    tools.run_scan()
    tools.list_idle_instances()
    tools.get_approval_status()
    assert {r["tool"] for r in activity_rows(aws)} == {"run_scan", "list_idle_instances", "get_approval_status"}


def test_no_tool_can_vote(tools):
    listed = asyncio.run(tools.mcp.list_tools())
    assert not any("vote" in t.name or "approve" == t.name for t in listed)


def _mcp_event(body):
    return {"resource": "/mcp", "path": "/mcp", "httpMethod": "POST",
            "headers": {"Host": "abc.execute-api.us-east-1.amazonaws.com", "Content-Type": "application/json",
                        "Accept": "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18"},
            "multiValueHeaders": {}, "queryStringParameters": None, "multiValueQueryStringParameters": None,
            "requestContext": {"resourcePath": "/mcp", "httpMethod": "POST", "path": "/prod/mcp", "stage": "prod",
                               "identity": {"sourceIp": "127.0.0.1"}, "requestId": "r1"},
            "body": json.dumps(body), "isBase64Encoded": False}


def test_tool_call_through_lambda_handler(tools, aws):
    from conftest import load
    lam = load("mcp_lambda", "mcp_server/lambda_function.py")
    call = {"jsonrpc": "2.0", "id": 7, "method": "tools/call",
            "params": {"name": "list_idle_load_balancers", "arguments": {}}}
    for _ in range(2):  # a warm container handles more than one request
        r = lam.handler(_mcp_event(call), None)
        assert r["statusCode"] == 200
        result = json.loads(r["body"])["result"]
        assert result.get("isError") is not True
        data = json.loads(result["content"][0]["text"])
        assert data["count"] == 1
        assert data["items"][0]["resource_id"] == "demo-legacy-alb"
