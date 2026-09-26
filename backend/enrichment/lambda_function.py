import json
import os
import uuid
from datetime import datetime, timezone, timedelta
from typing import Dict, Any

import boto3
from botocore.config import Config
from openai import OpenAI

from common.ddb import to_ddb
from prompts import get_prompt, render_prompt

dynamodb = boto3.resource("dynamodb", config=Config(retries={"max_attempts": 3}))
sns = boto3.client("sns", config=Config(retries={"max_attempts": 3}))

FINDINGS_TABLE = os.environ["FINDINGS_TABLE"]
APPROVALS_TABLE = os.environ["APPROVALS_TABLE"]
PROMPT_REGISTRY_TABLE = os.environ["PROMPT_REGISTRY_TABLE"]
APPROVAL_TOPIC_ARN = os.environ["APPROVAL_TOPIC_ARN"]
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
ENVIRONMENT = os.environ["ENVIRONMENT"]

# The v1.x SDK requires a client instance; `openai.api_key = ...` is the removed v0.x form.
client = OpenAI(api_key=OPENAI_API_KEY)


def handler(event, context):
    finding_id = event.get("finding_id")
    if not finding_id:
        return {"statusCode": 400, "body": "Missing finding_id"}

    print(f"Enriching finding: {finding_id}")

    finding = get_finding(finding_id)
    if not finding:
        print(f"Finding not found: {finding_id}")
        return {"statusCode": 404, "body": "Finding not found"}

    prompt_version = get_prompt_version("cost-janitor-enrichment", "v1")
    prompt_template = prompt_version.get("template", get_prompt("cost-janitor-enrichment", "v1"))

    prompt = render_prompt(prompt_template, finding)

    try:
        response = client.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": prompt}],
            response_format={"type": "json_object"},
            temperature=0.1,
            max_tokens=500,
        )

        enrichment = json.loads(response.choices[0].message.content)
        enrichment["model_version"] = prompt_version.get("version", "v1")
        enrichment["enriched_at"] = datetime.now(timezone.utc).isoformat()

    except Exception as e:
        print(f"OpenAI error: {e}")
        enrichment = {
            "risk_assessment": "medium",
            "business_impact": "Unable to assess - enrichment failed",
            "recommendation": "investigate",
            "confidence": 0.3,
            "reasoning": f"Enrichment error: {str(e)}",
            "suggested_action": "Manual review required",
            "model_version": "fallback",
            "enriched_at": datetime.now(timezone.utc).isoformat(),
        }

    finding["enrichment"] = enrichment
    finding["status"] = "PENDING_APPROVAL"
    save_finding(finding)

    approval_id = create_approval(finding)
    notify_approvers(finding, approval_id)

    return {"statusCode": 200, "body": json.dumps({"approval_id": approval_id})}


def get_finding(finding_id: str) -> Dict[str, Any]:
    table = dynamodb.Table(FINDINGS_TABLE)
    response = table.get_item(Key={"finding_id": finding_id})
    return response.get("Item")


def get_prompt_version(model_name: str, version: str) -> Dict[str, Any]:
    table = dynamodb.Table(PROMPT_REGISTRY_TABLE)
    response = table.get_item(Key={"model_name": model_name, "version": version})
    item = response.get("Item")
    if item:
        return item
    return {"model_name": model_name, "version": version, "template": get_prompt(model_name, version)}


def save_finding(finding: Dict[str, Any]):
    table = dynamodb.Table(FINDINGS_TABLE)
    table.put_item(Item=to_ddb(finding))


def create_approval(finding: Dict[str, Any]) -> str:
    approval_id = f"appr-{finding['finding_id']}"
    monthly_cost = float(finding.get("monthly_cost_usd", 0))
    required_approvals = 2 if monthly_cost > 100 else 1

    approval = {
        "approval_id": approval_id,
        "finding_id": finding["finding_id"],
        "status": "PENDING",
        "required_approvals": required_approvals,
        "votes": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(days=7)).isoformat(),
        "ttl": int((datetime.now(timezone.utc) + timedelta(days=90)).timestamp()),
    }

    table = dynamodb.Table(APPROVALS_TABLE)
    table.put_item(Item=to_ddb(approval))
    return approval_id


def notify_approvers(finding: Dict[str, Any], approval_id: str):
    enrichment = finding.get("enrichment", {})
    message = f"""
Cost Janitor - Approval Required

Resource: {finding['resource_type']} {finding['resource_id']}
Region: {finding['region']}
Monthly Cost: ${finding['monthly_cost_usd']:.2f}
Annual Savings: ${finding['monthly_cost_usd'] * 12:.2f}

AI Recommendation: {enrichment.get('recommendation', 'N/A')} (Confidence: {enrichment.get('confidence', 0):.0%})
Risk: {enrichment.get('risk_assessment', 'N/A')}

Reasoning: {enrichment.get('reasoning', 'N/A')}

Review at: https://your-dashboard-url/approvals/{approval_id}
"""

    sns.publish(
        TopicArn=APPROVAL_TOPIC_ARN,
        Subject=f"[Cost Janitor] Approval: {finding['resource_type']} {finding['resource_id']} (${finding['monthly_cost_usd']:.2f}/mo)",
        Message=message,
    )