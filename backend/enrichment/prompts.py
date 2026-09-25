DEFAULT_PROMPTS = {
    "cost-janitor-enrichment": {
        "v1": """You are a Cloud Cost Optimization Expert. Analyze the following AWS resource finding and provide enrichment.

RESOURCE DETAILS:
- Type: {{resource_type}}
- ID: {{resource_id}}
- Region: {{region}}
- Monthly Cost: ${{monthly_cost_usd}}
- Evidence: {{evidence}}
- Tags: {{tags}}

TASK: Provide a JSON response with:
1. risk_assessment: "low" | "medium" | "high" - Risk of deleting this resource
2. business_impact: Brief description of what happens if deleted
3. recommendation: "delete" | "downsize" | "keep" | "investigate"
4. confidence: 0.0 to 1.0 - Confidence in recommendation
5. reasoning: Detailed explanation
6. suggested_action: Specific action to take (e.g., "terminate instance", "delete volume after snapshot", "delete load balancer")

Consider:
- Production tags (Environment=prod) → always recommend "keep" with high confidence
- Development/staging with low utilization → "delete" with high confidence
- Resources with recent activity → "investigate"
- Cost vs. risk tradeoff

Output ONLY valid JSON.""",
        "v2": """You are a Senior Cloud FinOps Engineer. Analyze this idle resource finding.

RESOURCE:
{{resource_type}} {{resource_id}} in {{region}}
Cost: ${{monthly_cost_usd}}/month
Evidence: {{evidence}}
Tags: {{tags}}

RESPOND WITH JSON ONLY:
{
  "risk_assessment": "low|medium|high",
  "business_impact": "string",
  "recommendation": "delete|downsize|keep|investigate",
  "confidence": 0.0-1.0,
  "reasoning": "string",
  "suggested_action": "string",
  "cost_savings_annual": number,
  "alternatives": ["string"]
}""",
    }
}


def get_prompt(model_name: str, version: str) -> str:
    return DEFAULT_PROMPTS.get(model_name, {}).get(version, DEFAULT_PROMPTS["cost-janitor-enrichment"]["v1"])


def render_prompt(template: str, finding: dict) -> str:
    import json
    return template.replace("{{resource_type}}", finding.get("resource_type", "")) \
                   .replace("{{resource_id}}", finding.get("resource_id", "")) \
                   .replace("{{region}}", finding.get("region", "")) \
                   .replace("{{monthly_cost_usd}}", str(finding.get("monthly_cost_usd", 0))) \
                   .replace("{{evidence}}", json.dumps(finding.get("evidence", {}), default=str)) \
                   .replace("{{tags}}", json.dumps(finding.get("tags", {})))