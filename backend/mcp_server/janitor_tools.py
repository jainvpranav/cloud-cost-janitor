import json
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Dict, List, Optional

import boto3
from boto3.dynamodb.conditions import Attr
from botocore.config import Config

from common.config import load_guardrails, required_approvals
from common.ddb import from_ddb, to_ddb
from common.jobs import create_job, get_job

CLOSED = {"TEARDOWN_COMPLETE", "REJECTED", "SKIPPED_NOW_ACTIVE", "RESOURCE_GONE", "EXPIRED"}
PLANNABLE = {"PENDING_ENRICHMENT", "PENDING_APPROVAL"}
RISKS = {"low", "medium", "high"}
RECOMMENDATIONS = {"delete", "keep", "investigate", "downsize"}

_cfg = Config(retries={"max_attempts": 3})
_dynamodb = None
_lambda = None


class ToolError(Exception):
    pass


def ddb():
    global _dynamodb
    if _dynamodb is None:
        _dynamodb = boto3.resource("dynamodb", config=_cfg)
    return _dynamodb


def lam():
    global _lambda
    if _lambda is None:
        _lambda = boto3.client("lambda", config=_cfg)
    return _lambda


def table(env_name: str):
    return ddb().Table(os.environ[env_name])


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def all_findings() -> List[Dict[str, Any]]:
    t = table("FINDINGS_TABLE")
    items, kwargs = [], {}
    while True:
        page = t.scan(**kwargs)
        items.extend(page.get("Items", []))
        if "LastEvaluatedKey" not in page:
            return from_ddb(items)
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def get_finding(finding_id: str) -> Optional[Dict[str, Any]]:
    item = table("FINDINGS_TABLE").get_item(Key={"finding_id": finding_id}).get("Item")
    return from_ddb(item) if item else None


def get_approval(approval_id: str) -> Optional[Dict[str, Any]]:
    item = table("APPROVALS_TABLE").get_item(Key={"approval_id": approval_id}).get("Item")
    return from_ddb(item) if item else None


def cost(f: Dict[str, Any]) -> float:
    return round(float(f.get("monthly_cost_usd") or 0), 2)


def brief(f: Dict[str, Any]) -> Dict[str, Any]:
    enrichment = f.get("enrichment") or {}
    return {
        "finding_id": f["finding_id"],
        "resource_type": f["resource_type"],
        "resource_id": f["resource_id"],
        "region": f.get("region"),
        "status": f.get("status"),
        "monthly_cost_usd": cost(f),
        "annual_cost_usd": round(cost(f) * 12, 2),
        "price_source": f.get("price_source", "table"),
        "evidence": f.get("evidence", {}),
        "tags": f.get("tags", {}),
        "assessment": {k: enrichment[k] for k in ("risk_assessment", "recommendation", "confidence", "reasoning")
                       if k in enrichment} or None,
    }


def start_scan() -> Dict[str, Any]:
    job = create_job(table("JOBS_TABLE"), "scan", requested_by="agent")
    lam().invoke(FunctionName=os.environ["SCANNER_FUNCTION"], InvocationType="Event",
                 Payload=json.dumps({"job_id": job["job_id"]}))
    return {"job_id": job["job_id"], "status": "QUEUED",
            "next_step": "Call get_job_status with this job_id until status is SUCCEEDED or FAILED."}


def job_status(job_id: str) -> Dict[str, Any]:
    job = get_job(table("JOBS_TABLE"), job_id)
    if not job:
        raise ToolError(f"No job with id {job_id}")
    job.pop("ttl", None)
    return job


def list_open(resource_type: str) -> Dict[str, Any]:
    items = [brief(f) for f in all_findings()
             if f.get("resource_type") == resource_type and f.get("status") not in CLOSED]
    items.sort(key=lambda x: x["monthly_cost_usd"], reverse=True)
    total = round(sum(i["monthly_cost_usd"] for i in items), 2)
    return {"count": len(items), "monthly_total_usd": total, "annual_total_usd": round(total * 12, 2),
            "items": items}


def cost_summary() -> Dict[str, Any]:
    findings = all_findings()
    open_items = [f for f in findings if f.get("status") not in CLOSED]
    reclaimed = [f for f in findings if f.get("status") == "TEARDOWN_COMPLETE"]
    by_type: Dict[str, Dict[str, Any]] = {}
    for f in open_items:
        entry = by_type.setdefault(f["resource_type"], {"count": 0, "monthly_usd": 0.0})
        entry["count"] += 1
        entry["monthly_usd"] = round(entry["monthly_usd"] + cost(f), 2)
    open_total = round(sum(cost(f) for f in open_items), 2)
    reclaimed_total = round(sum(cost(f) for f in reclaimed), 2)
    return {
        "open_waste": {"count": len(open_items), "monthly_usd": open_total, "annual_usd": round(open_total * 12, 2),
                       "by_type": by_type},
        "awaiting_approval": sum(1 for f in open_items if f.get("status") == "PENDING_APPROVAL"),
        "approved_not_executed": sum(1 for f in open_items if f.get("status") == "APPROVED"),
        "reclaimed": {"count": len(reclaimed), "monthly_usd": reclaimed_total,
                      "annual_usd": round(reclaimed_total * 12, 2)},
    }


def assess(finding_id: str, risk: str, recommendation: str, confidence: float, reasoning: str) -> Dict[str, Any]:
    risk, recommendation = risk.lower().strip(), recommendation.lower().strip()
    if risk not in RISKS:
        raise ToolError(f"risk must be one of {sorted(RISKS)}")
    if recommendation not in RECOMMENDATIONS:
        raise ToolError(f"recommendation must be one of {sorted(RECOMMENDATIONS)}")
    if not 0 <= float(confidence) <= 1:
        raise ToolError("confidence must be between 0 and 1")
    finding = get_finding(finding_id)
    if not finding:
        raise ToolError(f"No finding with id {finding_id}")

    enrichment = {
        "risk_assessment": risk,
        "recommendation": recommendation,
        "confidence": round(float(confidence), 2),
        "reasoning": reasoning.strip()[:2000],
        "model_version": "trueforge-agent",
        "enriched_at": now_iso(),
    }
    table("FINDINGS_TABLE").update_item(
        Key={"finding_id": finding_id},
        UpdateExpression="SET enrichment = :e",
        ExpressionAttributeValues=to_ddb({":e": enrichment}),
    )
    return {"finding_id": finding_id, "saved": True, "assessment": enrichment}


def planned_actions(f: Dict[str, Any], guardrails: Dict[str, Any]) -> List[str]:
    kind, rid = f["resource_type"], f["resource_id"]
    if kind == "EC2":
        return [f"Terminate EC2 instance {rid}"]
    if kind == "EBS":
        steps = [f"Snapshot volume {rid} (kept, tagged CostJanitor=pre-delete)"] if guardrails["require_snapshot_for_ebs"] else []
        return steps + [f"Delete EBS volume {rid}"]
    return [f"Delete load balancer {rid}"]


def blocked_reason(f: Dict[str, Any], guardrails: Dict[str, Any]) -> Optional[str]:
    tags = f.get("tags") or {}
    for key, values in guardrails["blocked_tags"].items():
        if tags.get(key) in values:
            return f"protected by tag {key}={tags[key]}"
    if cost(f) > float(guardrails["max_teardown_cost_usd"]):
        return f"cost ${cost(f):.2f}/mo is above the ${float(guardrails['max_teardown_cost_usd']):.0f}/mo automation limit"
    return None


def draft_plan(finding_ids: List[str]) -> Dict[str, Any]:
    if not finding_ids:
        raise ToolError("Pass at least one finding_id")
    guardrails = load_guardrails(table("CONFIG_TABLE"))
    approvals = table("APPROVALS_TABLE")
    findings = table("FINDINGS_TABLE")
    expiry = (datetime.now(timezone.utc) + timedelta(days=int(guardrails["approval_expiry_days"]))).isoformat()

    items, skipped = [], []
    for finding_id in dict.fromkeys(finding_ids):
        f = get_finding(finding_id)
        if not f:
            skipped.append({"finding_id": finding_id, "reason": "not found"})
            continue
        if f.get("status") not in PLANNABLE:
            skipped.append({"finding_id": finding_id, "reason": f"status is {f.get('status')}"})
            continue
        reason = blocked_reason(f, guardrails)
        if reason:
            skipped.append({"finding_id": finding_id, "reason": reason})
            continue

        approval_id = f"appr-{finding_id}"
        needed = required_approvals(cost(f), guardrails)
        existing = get_approval(approval_id)
        if not existing:
            approvals.put_item(Item=to_ddb({
                "approval_id": approval_id,
                "finding_id": finding_id,
                "status": "PENDING",
                "required_approvals": needed,
                "votes": [],
                "created_at": now_iso(),
                "expires_at": expiry,
                "requested_by": "agent",
                "planned_actions": planned_actions(f, guardrails),
                "ttl": int((datetime.now(timezone.utc) + timedelta(days=90)).timestamp()),
            }))
        findings.update_item(
            Key={"finding_id": finding_id},
            UpdateExpression="SET #s = :s",
            ExpressionAttributeNames={"#s": "status"},
            ExpressionAttributeValues={":s": "PENDING_APPROVAL"},
        )
        items.append({
            "approval_id": approval_id,
            "finding_id": finding_id,
            "resource": f"{f['resource_type']} {f['resource_id']}",
            "monthly_cost_usd": cost(f),
            "required_approvals": int(existing["required_approvals"]) if existing else needed,
            "approval_status": existing["status"] if existing else "PENDING",
            "actions": planned_actions(f, guardrails),
        })

    total = round(sum(i["monthly_cost_usd"] for i in items), 2)
    return {
        "items": items,
        "skipped": skipped,
        "monthly_savings_usd": total,
        "annual_savings_usd": round(total * 12, 2),
        "next_step": "Stop here. People approve each item in the dashboard's Approvals page. "
                     "Call get_approval_status later; only APPROVED items can be executed.",
    }


def approval_status(approval_ids: Optional[List[str]] = None) -> Dict[str, Any]:
    if approval_ids:
        found = [a for a in (get_approval(i) for i in approval_ids) if a]
    else:
        t = table("APPROVALS_TABLE")
        found = from_ddb(t.scan(FilterExpression=Attr("status").is_in(["PENDING", "APPROVED"])).get("Items", []))
    out = []
    for a in found:
        approves = sum(1 for v in a.get("votes", []) if v.get("decision") == "approve")
        out.append({
            "approval_id": a["approval_id"],
            "finding_id": a["finding_id"],
            "status": a["status"],
            "approvals": f"{approves}/{int(a.get('required_approvals', 1))}",
            "voters": [v["user"] for v in a.get("votes", [])],
        })
    return {"items": out, "approved": [o["approval_id"] for o in out if o["status"] == "APPROVED"]}


def start_teardown(approval_id: str) -> Dict[str, Any]:
    approval = get_approval(approval_id)
    if not approval:
        raise ToolError(f"No approval with id {approval_id}")
    if approval["status"] != "APPROVED":
        return {
            "executed": False,
            "refused": True,
            "reason": f"Approval {approval_id} is {approval['status']}. A person must approve it in the "
                      f"dashboard before it can be executed. Do not retry until get_approval_status shows APPROVED.",
        }
    finding = get_finding(approval["finding_id"]) or {}
    if finding.get("status") in ("TEARDOWN_COMPLETE", "TEARDOWN_IN_PROGRESS"):
        return {"executed": False, "refused": True, "reason": f"Finding is already {finding['status']}"}

    job = create_job(table("JOBS_TABLE"), "teardown", approval_id=approval_id, dry_run=False, requested_by="agent")
    lam().invoke(FunctionName=os.environ["TEARDOWN_FUNCTION"], InvocationType="Event",
                 Payload=json.dumps({"approval_id": approval_id, "dry_run": False, "job_id": job["job_id"]}))
    return {"executed": True, "job_id": job["job_id"], "status": "QUEUED",
            "next_step": "Call get_job_status with this job_id. The teardown re-checks guardrails and "
                         "that the resource is still idle before deleting."}
