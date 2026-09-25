#!/usr/bin/env python3
"""
Bootstrap script for Cloud Cost Janitor.
Run once after CloudFormation deployment to initialize configuration.
"""

import boto3
import json
import os
import sys
from datetime import datetime, timezone

# Add backend to path for imports
sys.path.insert(0, os.path.join(os.path.dirname(__file__), 'backend'))

from scanner.rules import ScanConfig


def get_stack_outputs(stack_name: str, region: str) -> dict:
    """Get CloudFormation stack outputs."""
    cf = boto3.client('cloudformation', region_name=region)
    response = cf.describe_stacks(StackName=stack_name)
    outputs = {}
    for output in response['Stacks'][0].get('Outputs', []):
        outputs[output['OutputKey']] = output['OutputValue']
    return outputs


def bootstrap_config(table_name: str, region: str, role_arn: str, account_id: str, notification_emails: list):
    """Initialize scan configuration in DynamoDB."""
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(table_name)

    config = ScanConfig(
        role_arn=role_arn,
        account_id=account_id,
    )

    item = {
        'config_key': 'scan_config',
        'role_arn': config.role_arn,
        'account_id': config.account_id,
        'cpu_threshold_percent': config.cpu_threshold_percent,
        'cpu_hours': config.cpu_hours,
        'network_idle_bytes': config.network_idle_bytes,
        'ebs_unattached_days': config.ebs_unattached_days,
        'ebs_no_snapshot_days': config.ebs_no_snapshot_days,
        'lb_idle_days': config.lb_idle_days,
        'excluded_tags': config.excluded_tags,
        'notification_emails': notification_emails,
        'created_at': datetime.now(timezone.utc).isoformat(),
        'updated_at': datetime.now(timezone.utc).isoformat(),
    }

    table.put_item(Item=item)
    print(f"✓ Config saved to {table_name}")


def bootstrap_prompts(table_name: str, region: str):
    """Seed the prompt registry with default prompts."""
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(table_name)

    prompts = {
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

    for model_name, versions in prompts.items():
        for version, template in versions.items():
            table.put_item(Item={
                'model_name': model_name,
                'version': version,
                'template': template,
                'created_at': datetime.now(timezone.utc).isoformat(),
                'is_active': version == 'v1',
            })
            print(f"✓ Prompt seeded: {model_name}@{version}")


def bootstrap_guardrails(table_name: str, region: str):
    """Initialize guardrails configuration."""
    dynamodb = boto3.resource('dynamodb', region_name=region)
    table = dynamodb.Table(table_name)

    guardrails = {
        'config_key': 'guardrails',
        'auto_approve_threshold_usd': 100.0,
        'dual_approval_threshold_usd': 100.0,
        'max_teardown_cost_usd': 1000.0,
        'blocked_tags': {
            'Environment': ['prod', 'production', 'Prod', 'Production'],
            'CostJanitor': ['protect', 'do-not-delete', 'keep'],
        },
        'max_resources_per_run': 10,
        'dry_run_default': True,
        'require_snapshot_for_ebs': True,
        'require_confirmation_for_prod': True,
        'approval_expiry_days': 7,
        'created_at': datetime.now(timezone.utc).isoformat(),
    }

    table.put_item(Item=guardrails)
    print(f"✓ Guardrails saved to {table_name}")


def main():
    import argparse

    parser = argparse.ArgumentParser(description='Bootstrap Cloud Cost Janitor')
    parser.add_argument('--stack-name', default='cost-janitor-prod', help='CloudFormation stack name')
    parser.add_argument('--region', default='us-east-1', help='AWS region')
    parser.add_argument('--role-arn', required=True, help='Cross-account role ARN for scanner')
    parser.add_argument('--account-id', required=True, help='Target AWS account ID')
    parser.add_argument('--notification-emails', nargs='+', default=['admin@company.com'], help='Notification emails')
    parser.add_argument('--dry-run', action='store_true', help='Print actions without executing')
    args = parser.parse_args()

    print(f"Bootstrapping Cloud Cost Janitor...")
    print(f"Stack: {args.stack_name}")
    print(f"Region: {args.region}")
    print(f"Role ARN: {args.role_arn}")
    print(f"Account ID: {args.account_id}")
    print(f"Emails: {args.notification_emails}")
    print()

    if args.dry_run:
        print("DRY RUN - would execute:")
        print("  1. Get stack outputs")
        print("  2. Write scan config")
        print("  3. Seed prompt registry")
        print("  4. Write guardrails config")
        return

    try:
        # Get table names from stack outputs
        outputs = get_stack_outputs(args.stack_name, args.region)
        print("Stack outputs retrieved:")
        for k, v in outputs.items():
            print(f"  {k}: {v}")

        config_table = outputs.get('ConfigTableName')
        prompts_table = outputs.get('PromptRegistryTableName')
        # FindingsTableName, ApprovalsTableName also available

        if not config_table or not prompts_table:
            print("ERROR: Required stack outputs not found. Ensure stack deployed successfully.")
            sys.exit(1)

        # Bootstrap
        bootstrap_config(config_table, args.region, args.role_arn, args.account_id, args.notification_emails)
        bootstrap_prompts(prompts_table, args.region)
        bootstrap_guardrails(config_table, args.region)

        print()
        print("✅ Bootstrap complete!")
        print()
        print("Next steps:")
        print(f"1. Visit the CloudFront URL (from stack output: FrontendUrl)")
        print(f"2. Go to Settings page to verify configuration")
        print(f"3. Trigger first scan:")
        print(f"   aws events put-events --entries '[{{\"Source\":\"cost-janitor\",\"DetailType\":\"ManualScan\",\"Detail\":\"{{}}\"}}]'")

    except Exception as e:
        print(f"ERROR: {e}")
        sys.exit(1)


if __name__ == '__main__':
    main()