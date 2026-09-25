# Cloud Cost Janitor

Automated AWS cost optimization system that finds idle resources, enriches findings with AI, and provides human-in-the-loop approval for teardown.

## Architecture

```
EventBridge (daily 6 AM UTC)
    → Lambda Scanner (EC2/EBS/ELB)
        → DynamoDB Findings
        → Lambda Enrichment (OpenAI GPT-4o-mini)
            → DynamoDB Approvals
            → SNS Email Notifications
    → React Dashboard (CloudFront + S3)
        → Approval Queue (2-person for >$100/mo)
        → Teardown Lambda (guarded)
```

## Components

### Backend (AWS Lambda + Python)
- **Scanner**: Discovers idle EC2, orphaned EBS, unused Load Balancers
- **Enrichment**: OpenAI-powered analysis with TrueFoundry prompt registry
- **API**: REST endpoints for findings, approvals, config
- **Teardown**: Guarded resource deletion with dual-approval

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
- **Cost limits**: Auto-approve under $100, block >$1000
- **Snapshot safety**: EBS volumes snapshotted before deletion

## Quick Start

### Prerequisites
- AWS CLI configured
- OpenAI API key
- GitHub repository with secrets

### GitHub Secrets Required
```
AWS_DEPLOY_ROLE_ARN       # Role for GitHub Actions to deploy
ARTIFACTS_BUCKET          # S3 bucket for Lambda zips
OPENAI_API_KEY            # OpenAI API key
NOTIFICATION_EMAIL        # Email for approval notifications
FRONTEND_BUCKET           # S3 bucket for frontend hosting
CLOUDFRONT_DISTRIBUTION_ID
API_GATEWAY_ID
```

### Deploy
```bash
# Push to main triggers both pipelines
git push origin main
```

### Configure (Automated via Bootstrap)
```bash
# Install bootstrap dependencies
pip install -r requirements-bootstrap.txt

# Run bootstrap (after CloudFormation deploy)
python bootstrap.py \
  --stack-name cost-janitor-prod \
  --region us-east-1 \
  --role-arn arn:aws:iam::123456789012:role/CostJanitorScanner \
  --account-id 123456789012 \
  --notification-emails admin@company.com finops@company.com
```

### Configure (Manual)
1. Visit the CloudFront URL
2. Go to Settings
3. Enter your cross-account Role ARN and Account ID
4. Adjust thresholds as needed
5. Add notification emails

## Scan Rules

| Resource | Idle Criteria |
|----------|---------------|
| EC2 | CPU < 5% for 24h, < 1MB network, not in ASG |
| EBS | `available` > 7 days, no snapshot in 30 days |
| ELB/ALB | 0 requests for 7 days, no healthy targets |

## Cost Estimation

Uses AWS Pricing API with fallback to hardcoded on-demand rates (us-east-1, Linux).

## Development

The frontend needs the API base URL before it will show any data.

```bash
cd frontend
npm install

cp .env.example .env      # Windows: copy .env.example .env
# edit .env and set REACT_APP_API_URL to the ApiUrl stack output

npm start                 # proxies API paths, so no CORS setup needed locally
npm test -- --watchAll=false
npm run build

# Backend - deploy via CloudFormation or SAM
```

Without `REACT_APP_API_URL` every request goes to the dev server instead of the
API and fails with `Cannot GET /findings`. See
[docs/development.md](docs/development.md) for details.

## Project Structure

```
cloud-cost-janitor/
├── infrastructure/
│   └── template.yaml          # CloudFormation stack
├── backend/
│   ├── scanner/               # Resource discovery
│   ├── enrichment/            # OpenAI analysis
│   ├── approval/              # REST API
│   └── teardown/              # Guarded deletion
├── frontend/                  # React dashboard
│   └── src/
│       ├── App.js             # Shell and routes
│       ├── api/               # axios client
│       ├── theme/             # Light/dark/system
│       ├── lib/               # Formatting, KPIs, insights
│       ├── hooks/             # Data fetching
│       ├── components/        # Design system, charts, layout
│       └── pages/             # One file per route
├── docs/                      # Architecture, API, deployment, ops, security
└── .github/workflows/         # CI/CD pipelines
```

## License

MIT