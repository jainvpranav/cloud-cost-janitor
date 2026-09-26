# Cloud Cost Janitor

Automated AWS cost optimization system that finds idle resources, enriches findings with AI, and provides human-in-the-loop approval for teardown.

## Architecture

```
TrueForge agent ──MCP over HTTPS (API key)──▶ API Gateway /mcp ──▶ MCP Lambda
                                                                   │  run_scan, list_*, draft_teardown_plan,
                                                                   │  execute_teardown (only if APPROVED)
EventBridge (daily 6 AM UTC) ──▶ Scanner Lambda (EC2/EBS/ELB) ──▶ DynamoDB (findings, approvals, jobs, activity)
                                                                   │
Approvers ──▶ React dashboard (CloudFront + S3) ──▶ API Lambda ────┘  votes, live activity, Run scan
                                                   └──▶ Teardown Lambda (guardrails, still-idle check, snapshot)
```

The agent finds and prices waste and drafts a teardown plan. People approve in the dashboard.
Only then can the agent's teardown call go through. See [plan.md](plan.md) for the full build plan.

## Components

### Backend (AWS Lambda + Python)
- **Scanner**: Discovers idle EC2, orphaned EBS, unused Load Balancers
- **MCP server**: Tools for the TrueForge agent (`backend/mcp_server/`, prompt in `agent/janitor-agent.md`)
- **Enrichment**: Optional OpenAI analysis (off by default; the agent's assessments replace it)
- **API**: REST endpoints for findings, approvals, votes, scans, jobs, activity and config
- **Teardown**: Guarded deletion: approval, dual approval, live tag check, still-idle re-check, EBS snapshot

### Frontend (React + CloudFront)
- **Dashboard**: KPI strip, generated insights, findings explorer with card/table views
- **Insights**: Cost breakdowns, approval funnel, confidence and risk distribution, ageing
- **Findings**: Sortable, filterable table over every finding with CSV export
- **Approvals**: Review queue with voting, dual-approval and dry-run teardown
- **Docs**: In-app "How it works" reference
- **Settings**: Thresholds, guardrails and notification config
- Light/dark/system theming, inline SVG charts and icons (no charting dependency)

### Infrastructure (CloudFormation)
- DynamoDB tables (Findings, Approvals, Config, Prompts)
- EventBridge daily trigger
- API Gateway + Lambda
- S3 + CloudFront for frontend
- SNS for notifications
- IAM least-privilege roles

## Guardrails

- **Production protection**: Blocks resources tagged `Environment=prod|production`
- **Dual approval**: Required for resources >$100/month
- **Dry-run default**: All teardowns simulate first
- **Cost limits**: Two approvers above $100/mo (configurable), block >$1000
- **Snapshot safety**: EBS volumes snapshotted before deletion

## Quick Start

### Deploy (one-time setup, then push)
1. Deploy `infrastructure/github-oidc.yaml` once with admin credentials (GitHub OIDC role, artifacts bucket, $20 budget).
2. Set GitHub secrets and variables on the `prod` environment:

| Name | Kind | Required |
|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Secret | Yes (output of the OIDC stack) |
| `NOTIFICATION_EMAIL` | Secret | Yes |
| `OPENAI_API_KEY` | Secret | No |
| `ARTIFACTS_BUCKET` | Variable | Yes (output of the OIDC stack) |
| `FRONTEND_BUCKET_NAME` | Variable | Yes (globally unique, starts with `cost-janitor-`) |

3. Push to `master`. `deploy.yml` tests, deploys the stack, updates every Lambda and publishes the dashboard.

AWS steps in order: [docs/aws-setup.md](docs/aws-setup.md). Full reference: [docs/deployment.md](docs/deployment.md). Demo resources are created only on request:
Actions → **Demo resources** → `create` ([docs/operations.md](docs/operations.md#demo-runbook)).

### Run locally without AWS
```bash
python3 -m venv .venv && .venv/bin/pip install -r backend/requirements-dev.txt
.venv/bin/python scripts/local_stack.py                     # API + MCP on :8787, simulated AWS
cd frontend && npm ci && REACT_APP_API_URL=http://127.0.0.1:8787/prod npm start
```

## Scan Rules

| Resource | Idle Criteria |
|----------|---------------|
| EC2 | CPU < 5% for 24h, < 1MB network, not in ASG |
| EBS | `available` > 7 days, no snapshot in 30 days |
| ELB/ALB | 0 requests for 7 days, no healthy targets |

## Cost Estimation

EC2 uses the AWS Pricing API, then us-east-1 on-demand list prices; EBS and load balancers use list prices. All monthly figures use a 730-hour month. Each finding records its `price_source`.

## Development

```bash
.venv/bin/python -m pytest backend/tests -q     # backend, API, MCP and teardown tests (moto)
.venv/bin/cfn-lint infrastructure/*.yaml infrastructure/demo/*.yaml
./scripts/package_lambdas.sh                     # builds dist/*.zip like CI

cd frontend
npm ci
cp .env.example .env      # set REACT_APP_API_URL to the ApiEndpoint output (or the local stack)
npm start                 # proxies API paths, so no CORS setup needed locally
npm test -- --watchAll=false
```

See [docs/development.md](docs/development.md) for details.

## Project Structure

```
cloud-cost-janitor/
├── plan.md                    # Operational plan, struck off as executed
├── agent/janitor-agent.md     # TrueForge agent prompt and MCP setup
├── infrastructure/
│   ├── template.yaml          # Platform stack (deployed on push)
│   ├── github-oidc.yaml       # One-time CI role, artifacts bucket, budget
│   └── demo/idle-resources.yaml  # Demo waste (on request only)
├── backend/
│   ├── common/                # DynamoDB helpers, config, jobs, activity log
│   ├── scanner/               # Resource discovery and pricing
│   ├── mcp_server/            # MCP tools for the agent
│   ├── approval/              # REST API
│   ├── teardown/              # Guarded deletion
│   ├── enrichment/            # Optional OpenAI analysis
│   └── tests/
├── scripts/                   # Packaging, local stack, demo profile/reset/cleanup
├── frontend/                  # React dashboard
├── docs/                      # Architecture, API, deployment, ops, security
└── .github/workflows/         # ci.yml, deploy.yml, demo-resources.yml
```

## License

MIT