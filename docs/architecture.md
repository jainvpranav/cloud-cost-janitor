# Architecture Documentation

## System Overview

Cloud Cost Janitor is an automated AWS cost optimization platform that discovers idle resources, enriches findings with AI analysis, and provides human-in-the-loop approval for safe teardown.

## High-Level Architecture

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  EventBridge    │────▶│  Scanner Lambda  │────▶│  DynamoDB       │
│  (Daily Cron)   │     │  (Discovery)     │     │  Findings       │
└─────────────────┘     └──────────────────┘     └────────┬────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  SNS Email      │◀────│  Enrichment      │◀────│  OpenAI API     │
│  Notifications  │     │  Lambda          │     │  (GPT-4o-mini)  │
└─────────────────┘     └──────────────────┘     └─────────────────┘
                                                          │
                                                          ▼
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│  React Dashboard│◀────│  API Gateway     │◀────│  DynamoDB       │
│  (CloudFront)   │     │  + Lambda        │     │  Approvals      │
└─────────────────┘     └────────┬─────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌──────────────────┐
                        │  Teardown Lambda │
                        │  (Guarded)       │
                        └──────────────────┘
```

## Component Details

### 1. EventBridge Scheduler
- **Schedule**: Daily at 6:00 AM UTC (`cron(0 6 * * ? *)`)
- **Target**: Scanner Lambda
- **Payload**: Empty (triggers full scan)

### 2. Scanner Lambda
**Runtime**: Python 3.11, 512MB, 300s timeout

**Responsibilities**:
- Assume cross-account role via STS
- Discover resources across EC2, EBS, ELB/ALB
- Apply idle detection rules
- Estimate monthly costs via AWS Pricing API
- Store findings in DynamoDB
- Trigger enrichment asynchronously

**IAM Permissions**:
```json
{
  "EC2": ["DescribeInstances", "DescribeInstanceStatus", "DescribeVolumes", "DescribeSnapshots"],
  "ELBv2": ["DescribeLoadBalancers", "DescribeTargetGroups", "DescribeTargetHealth"],
  "CloudWatch": ["GetMetricStatistics", "ListMetrics"],
  "AutoScaling": ["DescribeAutoScalingGroups"],
  "Pricing": ["GetProducts"],
  "DynamoDB": ["PutItem", "UpdateItem", "GetItem", "Query"],
  "Lambda": ["InvokeFunction"],
  "SNS": ["Publish"],
  "STS": ["AssumeRole"]
}
```

### 3. Enrichment Lambda
**Runtime**: Python 3.11, 1024MB, 180s timeout

**Responsibilities**:
- Fetch finding from DynamoDB
- Retrieve prompt template from registry
- Call OpenAI API with structured prompt
- Parse and validate JSON response
- Update finding with enrichment
- Create approval record
- Send SNS notification

**Prompt Registry** (DynamoDB):
- Model: `cost-janitor-enrichment`
- Versions: `v1` (detailed), `v2` (concise)
- Active version configurable

### 4. API Gateway + Lambda
**Runtime**: Python 3.11, 256MB, 30s timeout

**Endpoints**:
| Method | Path | Description |
|--------|------|-------------|
| GET | `/findings` | List findings (filterable) |
| GET | `/approvals` | List pending approvals |
| POST | `/approvals/{id}/vote` | Submit approve/reject vote |
| POST | `/teardown` | Trigger guarded teardown |
| GET | `/config` | Get current configuration |
| PUT | `/config` | Update configuration |

### 5. Teardown Lambda
**Runtime**: Python 3.11, 512MB, 300s timeout

**Responsibilities**:
- Validate approval status
- Enforce guardrails
- Execute or simulate deletion
- Update finding status

**Guardrails**:
- Block resources tagged `Environment=prod|production`
- Require 2 approvals for resources >$100/mo
- Block resources >$1000/mo entirely
- Dry-run by default
- Snapshot EBS before deletion
- Max 10 resources per invocation

### 6. Frontend (React + CloudFront)
**Hosting**: S3 static website + CloudFront CDN
**Pages**: Dashboard, Insights, Findings, Approvals, Docs, Settings
**Auth**: None (add Cognito for production)

**Structure**:
| Layer | Location | Responsibility |
|-------|----------|----------------|
| Shell | `App.js`, `components/Layout.jsx` | Routing, sidebar, topbar, error boundary |
| Design system | `index.css`, `components/UI.jsx`, `components/Icons.jsx` | Tokens, primitives, inline SVG icons |
| Charts | `components/Charts.jsx` | Inline SVG charts, no charting dependency |
| Data | `lib/metrics.js`, `lib/insights.js`, `hooks/useApi.js` | KPI derivation, insight generation, fetching || API | `api/client.js` | axios instance, response guard, error messages |
| Theme | `theme/ThemeProvider.jsx` | `light` / `dark` / `system`, persisted |

**Design decisions worth knowing**:
- **KPIs are derived client-side** from the findings and approvals the API already
  returns. There is no separate aggregate endpoint, so the headline numbers cannot
  disagree with the table underneath them.
- **No chart or icon dependency.** Both are inline SVG, which keeps the bundle small
  and avoids supply-chain surface for six chart types and ~60 icons.
- **Theming is token-driven.** Light and dark are the same class names against
  different custom properties, so a new component is themed by using tokens rather
  than by writing dark-mode overrides.
- **Approvals read the embedded finding** from the approval record instead of issuing
  one request per row.
- **Findings and approvals use different status vocabularies** — `STATUS` and
  `APPROVAL_STATUS` in `lib/metrics.js` are deliberately separate constants.

**Local development** uses `src/setupProxy.js` to forward API paths through the dev
server, keeping the browser same-origin. Production calls API Gateway directly and
depends on the CORS headers described in [api.md](api.md#cors).

## Data Models

### Finding (DynamoDB: `cost-janitor-findings-{env}`)
```json
{
  "finding_id": "f-ec2-i-12345-20240115",
  "account_id": "123456789012",
  "resource_type": "EC2|EBS|ELB",
  "resource_id": "i-12345",
  "resource_arn": "arn:aws:ec2:...",
  "region": "us-east-1",
  "monthly_cost_usd": 45.67,
  "status": "PENDING_ENRICHMENT|PENDING_APPROVAL|APPROVED|REJECTED|TEARDOWN_COMPLETE",
  "detected_at": "2024-01-15T06:00:00Z",
  "evidence": { "cpu_avg_24h": 2.1, "network_in": 0 },
  "tags": { "Environment": "staging", "Team": "platform" },
  "enrichment": {
    "risk_assessment": "low",
    "business_impact": "Non-prod dev instance",
    "recommendation": "delete",
    "confidence": 0.92,
    "reasoning": "...",
    "suggested_action": "terminate instance"
  },
  "ttl": 1705363200
}
```

**Indexes**:
- `status-index` (GSI): Query by status
- `account-index` (GSI): Query by account

### Approval (DynamoDB: `cost-janitor-approvals-{env}`)
```json
{
  "approval_id": "appr-f-ec2-i-12345-20240115",
  "finding_id": "f-ec2-i-12345-20240115",
  "status": "PENDING|APPROVED|REJECTED|EXPIRED",
  "required_approvals": 1|2,
  "votes": [
    { "user": "alice@company.com", "decision": "approve", "at": "2024-01-15T10:00:00Z" }
  ],
  "created_at": "2024-01-15T06:05:00Z",
  "expires_at": "2024-01-22T06:05:00Z",
  "ttl": 1705363200
}
```

**Indexes**:
- `finding-index` (GSI): Lookup by finding_id
- `status-index` (GSI): Query pending approvals

### Config (DynamoDB: `cost-janitor-config-{env}`)
```json
{
  "config_key": "scan_config",
  "role_arn": "arn:aws:iam::123456789012:role/CostJanitorScanner",
  "account_id": "123456789012",
  "cpu_threshold_percent": 5.0,
  "cpu_hours": 24,
  "network_idle_bytes": 1048576,
  "ebs_unattached_days": 7,
  "ebs_no_snapshot_days": 30,
  "lb_idle_days": 7,
  "excluded_tags": {
    "Environment": ["prod", "production"],
    "CostJanitor": ["ignore", "do-not-delete"]
  },
  "notification_emails": ["admin@company.com"]
}
```

```json
{
  "config_key": "guardrails",
  "auto_approve_threshold_usd": 100.0,
  "dual_approval_threshold_usd": 100.0,
  "max_teardown_cost_usd": 1000.0,
  "blocked_tags": { "Environment": ["prod"], "CostJanitor": ["protect"] },
  "max_resources_per_run": 10,
  "dry_run_default": true,
  "require_snapshot_for_ebs": true,
  "approval_expiry_days": 7
}
```

### Prompt Registry (DynamoDB: `cost-janitor-prompts-{env}`)
```json
{
  "model_name": "cost-janitor-enrichment",
  "version": "v1",
  "template": "...prompt template...",
  "created_at": "2024-01-15T06:00:00Z",
  "is_active": true
}
```

## Security Model

### Cross-Account Access
1. User provides Role ARN in target account
2. Scanner assumes role with `ExternalId: cost-janitor-{env}`
3. Target account trusts this role with condition on ExternalId
4. Least-privilege read-only permissions

### Data Protection
- DynamoDB encryption at rest (AWS managed keys)
- TLS in transit for all API calls
- OpenAI API key stored in Lambda env var (consider Secrets Manager)
- No sensitive data in logs

### Network
- All Lambdas in VPC (optional, for private subnets)
- API Gateway regional endpoint
- CloudFront with OAI for S3 origin

## Cost Estimation

### Scanner Costs (Monthly Estimate)
| Component | Cost |
|-----------|------|
| Lambda (Scanner) | ~$0.50 (1M invocations) |
| Lambda (Enrichment) | ~$2.00 (OpenAI API calls) |
| Lambda (API) | ~$0.20 |
| Lambda (Teardown) | ~$0.10 |
| DynamoDB | ~$1.00 (on-demand) |
| EventBridge | $0.00 (free tier) |
| SNS | ~$0.10 |
| API Gateway | ~$3.50 (1M requests) |
| CloudFront | ~$1.00 |
| S3 | ~$0.05 |
| **Total** | **~$8.50/month** |

### OpenAI Costs
- ~$0.002 per enrichment (GPT-4o-mini)
- 100 findings/day = ~$6/month

## Scaling Considerations

### Horizontal Scaling
- Scanner: Single invocation per account (add Step Functions for multi-account)
- Enrichment: Async, auto-scales with Lambda concurrency
- API: Auto-scales with Lambda
- DynamoDB: On-demand billing handles bursts

### Multi-Account Strategy
1. Deploy stack per account (or use StackSets)
2. Central dashboard aggregates via cross-account roles
3. Or: Single scanner with multiple role ARNs in config

## Failure Handling

| Failure Point | Mitigation |
|---------------|------------|
| Scanner timeout | 5min timeout, chunk by region |
| OpenAI API error | Fallback enrichment, retry with exponential backoff |
| Approval expired | TTL cleanup, re-scan creates new finding |
| Teardown partial failure | Idempotent operations, status tracking |
| DynamoDB throttle | On-demand capacity, retry logic |

## Monitoring & Observability

### CloudWatch Metrics
- Lambda invocations, errors, duration
- DynamoDB consumed capacity
- API Gateway latency, 4xx/5xx
- SNS delivery success/failure

### Recommended Alarms
- Scanner error rate > 1%
- Enrichment latency > 30s
- Approval queue > 50 pending
- Teardown failure rate > 0%

### Logging
- Structured JSON logs via Lambda Powertools (recommended)
- Correlation IDs across components
- Audit trail for all teardown actions