# Development Guide

## Quick path: everything local, no AWS

```bash
python3 -m venv .venv
.venv/bin/pip install -r backend/requirements-dev.txt

.venv/bin/python -m pytest backend/tests -q        # 45 tests: rules, scanner, teardown, API/CORS, MCP
.venv/bin/python scripts/local_stack.py            # API + MCP on http://127.0.0.1:8787/prod
```

`local_stack.py` runs the real Lambda handlers against a simulated account (moto) seeded with the
six demo resources and CloudWatch CPU data. "Run scan" in the dashboard finds the same four items as
the real demo. Scans and teardowns run in background threads, like async Lambda invokes.

Dashboard against it:

```bash
cd frontend
echo "REACT_APP_API_URL=http://127.0.0.1:8787/prod" > .env.local
npm start
```

## MCP server

`backend/mcp_server/` is one codebase for both targets:

| Where | Entry point | How |
|---|---|---|
| Lambda | `lambda_function.handler` | Mangum; a fresh ASGI app per invocation because the SDK's session manager can only start once |
| Local, real AWS tables | `local.py` | `cd backend && ../.venv/bin/python mcp_server/local.py --port 8000` after exporting the table and function names from the stack outputs |
| Local, simulated AWS | `scripts/local_stack.py` | `/prod/mcp` on port 8787 |

Environment for `local.py` (values from `aws cloudformation describe-stacks --stack-name cost-janitor-prod`):

```bash
export FINDINGS_TABLE=cost-janitor-findings-prod APPROVALS_TABLE=cost-janitor-approvals-prod \
       CONFIG_TABLE=cost-janitor-config-prod JOBS_TABLE=cost-janitor-jobs-prod \
       ACTIVITY_TABLE=cost-janitor-activity-prod \
       SCANNER_FUNCTION=cost-janitor-scanner-prod TEARDOWN_FUNCTION=cost-janitor-teardown-prod
```

The folder is `mcp_server`, not `mcp`, because a local `mcp/` directory would shadow the MCP SDK
package in tests. It uses SDK 2.x (`mcp.server.mcpserver.MCPServer`, the renamed FastMCP).

## Lambda packaging

`./scripts/package_lambdas.sh` builds `dist/{scanner,enrichment,teardown,api,mcp}.zip` exactly as CI
does. Every zip gets `backend/common/`; teardown also gets the scanner's `aws_client.py` and
`rules.py`. Dependencies are installed as manylinux wheels for Python 3.11; boto3 comes from the
Lambda runtime.


## Local Development Setup

### Prerequisites
- Python 3.11+
- Node.js 20+
- AWS CLI configured
- Docker (for localstack)

### Backend Development

#### 1. Install Dependencies
```bash
cd backend/scanner && pip install -r requirements.txt
cd ../enrichment && pip install -r requirements.txt
cd ../approval && pip install -r requirements.txt
cd ../teardown && pip install -r requirements.txt
```

#### 2. Run with LocalStack
```bash
# Start LocalStack
docker run -d -p 4566:4566 -p 4510-4559:4510-4559 localstack/localstack

# Set environment
export AWS_ENDPOINT_URL=http://localhost:4566
export AWS_ACCESS_KEY_ID=test
export AWS_SECRET_ACCESS_KEY=test
export AWS_DEFAULT_REGION=us-east-1

# Create tables
aws --endpoint-url=http://localhost:4566 dynamodb create-table \
  --table-name cost-janitor-findings-dev \
  --attribute-definitions AttributeName=finding_id,AttributeType=S \
  --key-schema AttributeName=finding_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST

# ... repeat for other tables
```

#### 3. Test Scanner Locally
```python
# test_scanner.py
import os
os.environ['FINDINGS_TABLE'] = 'cost-janitor-findings-dev'
os.environ['CONFIG_TABLE'] = 'cost-janitor-config-dev'
os.environ['ENRICHMENT_FUNCTION'] = 'test'
os.environ['APPROVAL_TOPIC_ARN'] = 'test'
os.environ['ENVIRONMENT'] = 'dev'

from scanner.lambda_function import handler

# Mock event
event = {}
context = type('obj', (object,), {'aws_request_id': 'test'})()

result = handler(event, context)
print(result)
```

#### 4. Run Unit Tests
```bash
# Create test file
cat > backend/scanner/test_rules.py << 'EOF'
import pytest
from rules import evaluate_ec2, evaluate_ebs, evaluate_lb, ScanConfig

def test_ec2_idle():
    instance = {
        "InstanceId": "i-123",
        "InstanceType": "t3.medium",
        "State": {"Name": "running"},
        "Placement": {"AvailabilityZone": "us-east-1a"},
        "Tags": [{"Key": "Environment", "Value": "dev"}],
        "LaunchTime": "2024-01-01T00:00:00Z"
    }
    metrics = {"cpu_avg": 2.0, "cpu_max": 5.0, "network_in_bytes": 1000}
    asg_ids = set()
    config = ScanConfig()

    finding = evaluate_ec2(instance, metrics, asg_ids, config)
    assert finding is not None
    assert finding["resource_type"] == "EC2"
    assert finding["resource_id"] == "i-123"

def test_ec2_not_idle_high_cpu():
    instance = {"InstanceId": "i-123", "InstanceType": "t3.medium", "State": {"Name": "running"}, "Placement": {"AvailabilityZone": "us-east-1a"}, "Tags": []}
    metrics = {"cpu_avg": 50.0, "cpu_max": 80.0, "network_in_bytes": 1000000}
    config = ScanConfig()

    finding = evaluate_ec2(instance, metrics, set(), config)
    assert finding is None

def test_ec2_excluded_tag():
    instance = {"InstanceId": "i-123", "InstanceType": "t3.medium", "State": {"Name": "running"}, "Placement": {"AvailabilityZone": "us-east-1a"}, "Tags": [{"Key": "Environment", "Value": "prod"}]}
    metrics = {"cpu_avg": 1.0, "cpu_max": 2.0, "network_in_bytes": 0}
    config = ScanConfig()

    finding = evaluate_ec2(instance, metrics, set(), config)
    assert finding is None

def test_ebs_orphaned():
    volume = {"VolumeId": "vol-123", "State": "available", "Size": 100, "VolumeType": "gp3", "AvailabilityZone": "us-east-1a", "CreateTime": "2024-01-01T00:00:00Z", "Tags": []}
    snapshots = []
    config = ScanConfig(ebs_unattached_days=7)

    finding = evaluate_ebs(volume, snapshots, config)
    assert finding is not None
    assert finding["resource_type"] == "EBS"
    assert finding["monthly_cost_usd"] == 8.0  # gp3 100GB * $0.08
EOF

pytest backend/scanner/test_rules.py -v
```

### Frontend Development

#### 1. Install Dependencies
```bash
cd frontend
npm install
```

#### 2. Configure the API URL (required)

The frontend needs to know where the API lives. Without this, requests go to the
dev server itself and every call fails with `Cannot GET /findings`.

```bash
cp .env.example .env      # Windows: copy .env.example .env
```

Then edit `frontend/.env`:

```
REACT_APP_API_URL=https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
```

The value comes from the `ApiUrl` stack output. No trailing slash. Keep the stage
suffix unless your stage is `prod`.

> Create React App only exposes variables prefixed with `REACT_APP_`, and it reads
> `.env` at startup, so restart `npm start` after any change.

#### 3. Start the Development Server
```bash
npm start
```

In development the browser calls **relative** paths and `src/setupProxy.js` forwards
`/findings`, `/approvals`, `/teardown` and `/config` to `REACT_APP_API_URL`. The
browser therefore only ever talks to `localhost:3000`, so there is no CORS preflight
locally and you do not need the API to allow your origin. Startup prints the target:

```
[setupProxy] proxying /findings, /approvals, /teardown, /config -> https://...
```

If you see `[setupProxy] REACT_APP_API_URL is not set` instead, step 2 was skipped.

Production builds have no dev server, so they call `REACT_APP_API_URL` directly from
the browser. That is why the API sends CORS headers — see [api.md](api.md#cors).

#### 4. Run Tests
```bash
npm test -- --watchAll=false
```

Two suites ship with the frontend:

| Suite | What it covers |
|-------|----------------|
| `src/App.smoke.test.jsx` | Every route renders, and `computeMetrics` returns sane KPIs for empty and populated data |
| `src/api/client.test.js` | Response handling, the HTML-body misconfiguration, and `toMessage` |

The smoke tests assert the `ErrorBoundary` did **not** fire. This matters: the app
shell catches render errors, so a test that only checks "something rendered" passes
even when the page underneath is a crash.

#### 5. Mocking the API

There is no mock server in the repo. To work without a deployed backend, mock the
client module in the test you are writing:

```js
jest.mock('./api/client', () => {
  const list = async () => ({ data: { items: [], last_key: null } });
  return {
    toMessage: (e) => (e && e.message) || 'error',
    findingsApi: { list, get: list },
    approvalsApi: { list, vote: list, teardown: list },
    configApi: { get: list, update: list },
  };
});
```

A representative finding record looks like this, and is what the KPI layer expects:

```js
{
  finding_id: "f-ec2-i-12345-20240115",
  resource_type: "EC2",
  resource_id: "i-12345",
  region: "us-east-1",
  account_id: "123456789012",
  monthly_cost_usd: 45.67,
  status: "PENDING_APPROVAL",
  detected_at: "2024-01-15T06:00:00Z",
  evidence: { cpu_avg_24h: 2.1, instance_type: "t3.medium" },
  tags: { Environment: "dev", Team: "platform" },
  enrichment: {
    risk_assessment: "low",
    recommendation: "delete",
    confidence: 0.92,
    reasoning: "Dev instance with <5% CPU for 24h",
    suggested_action: "terminate instance"
  }
}
```

> **Status vocabularies differ.** Findings use
> `PENDING_ENRICHMENT | PENDING_APPROVAL | APPROVED | REJECTED | TEARDOWN_COMPLETE`.
> Approvals use `PENDING | APPROVED | REJECTED`. They are separate constants —
> `STATUS` and `APPROVAL_STATUS` in `src/lib/metrics.js` — because conflating them
> silently mis-counts every approval KPI.

#### 6. Build
```bash
npm run build
```

---

## Frontend Structure

```
frontend/src/
├── index.js                  # Mounts ThemeProvider above the router
├── App.js                    # Shell, routes, pending-approval count
├── setupProxy.js             # Dev-only API proxy (CRA reads this automatically)
├── api/client.js             # axios instance, response guard, toMessage
├── theme/ThemeProvider.jsx   # light | dark | system, persisted to localStorage
├── lib/
│   ├── format.js             # money, counts, percentages, dates
│   ├── metrics.js            # every KPI, derived from findings + approvals
│   └── insights.js           # severity-tagged observations
├── hooks/useApi.js           # useFindings, useApprovals, useAsync
├── components/
│   ├── UI.jsx                # design-system primitives
│   ├── Icons.jsx             # inline SVG icon set
│   ├── Charts.jsx            # inline SVG charts
│   ├── Layout.jsx            # Sidebar, Topbar, ErrorBoundary
│   ├── FindingCard.jsx       # finding and approval UI
│   └── Docs.jsx              # documentation rendering
└── pages/                    # Dashboard, Insights, Findings, Approvals,
                              # Docs, Settings, NotFound
```

KPIs are computed client-side from the records the API already returns, so the
numbers on screen always agree with the rows beneath them. There is deliberately no
second aggregate endpoint that could disagree.

Routes: `/`, `/insights`, `/approvals`, `/findings`, `/docs`, `/settings`.

---

## Code Style

### Python (Backend)
- **Formatter**: Black (`black backend/`)
- **Linter**: Ruff (`ruff check backend/`)
- **Type Hints**: Required for all functions
- **Docstrings**: Google style for public functions

```python
def calculate_cost(instance_type: str, region: str) -> float:
    """Calculate monthly cost for EC2 instance.

    Args:
        instance_type: EC2 instance type (e.g., 't3.medium')
        region: AWS region (e.g., 'us-east-1')

    Returns:
        Monthly cost in USD
    """
    ...
```

### JavaScript/React (Frontend)
- **Formatter**: Prettier (`npx prettier --write frontend/src/`)
- **Linter**: ESLint (`npm run lint`)
- **Components**: Functional components with hooks
- **State**: React Query for server state, useState for UI state

---

## Adding New Resource Types

### 1. Update Scanner Rules (`backend/scanner/rules.py`)
```python
def evaluate_rds(instance: Dict, metrics: Dict, config: ScanConfig) -> Optional[Dict]:
    """Evaluate RDS instance for idle status."""
    # Check CPU, connections, read/write IOPS
    # Return finding dict or None
    pass
```

### 2. Update AWS Client (`backend/scanner/aws_client.py`)
```python
def get_rds_instances(self) -> List[Dict]:
    rds = self._get_client("rds")
    instances = []
    paginator = rds.get_paginator("describe_db_instances")
    for page in paginator.paginate():
        instances.extend(page["DBInstances"])
    return instances

def get_rds_metrics(self, instance_id: str, hours: int = 24) -> Dict:
    # CloudWatch metrics for RDS
    pass
```

### 3. Update Scanner Lambda (`backend/scanner/lambda_function.py`)
```python
def scan_rds(client: AWSClient, config: ScanConfig) -> List[Dict]:
    findings = []
    instances = client.get_rds_instances()
    for instance in instances:
        metrics = client.get_rds_metrics(instance["DBInstanceIdentifier"])
        finding = evaluate_rds(instance, metrics, config)
        if finding:
            findings.append(finding)
    return findings
```

### 4. Add Cost Estimation
```python
def estimate_rds_cost(instance_class: str, engine: str, region: str) -> float:
    # Use Pricing API or fallback
    pass
```

### 5. Update CloudFormation IAM
Add to ScannerRole policy:
```yaml
- rds:DescribeDBInstances
- rds:DescribeDBClusters
- cloudwatch:GetMetricStatistics (for AWS/RDS namespace)
```

### 6. Update Teardown Lambda
```python
elif resource_type == "RDS":
    client.delete_db_instance(
        DBInstanceIdentifier=resource_id,
        SkipFinalSnapshot=False,
        FinalDBSnapshotIdentifier=f"cost-janitor-{resource_id}-{datetime.now():%Y%m%d}"
    )
```

### 7. Update Frontend
- Add RDS to resource type filters
- Add RDS-specific evidence display
- Update cost formatting

---

## Testing Strategy

### Unit Tests (Target: 80% coverage)
```bash
# Backend
pytest backend/scanner/test_rules.py
pytest backend/enrichment/test_prompts.py
pytest backend/teardown/test_guardrails.py

# Frontend
npm test -- --coverage
```

### Integration Tests
```bash
# Deploy to dev environment
aws cloudformation deploy --stack-name cost-janitor-dev --template-file infrastructure/template.yaml --parameter-overrides Environment=dev

# Run integration test suite
python tests/integration/test_full_flow.py
```

### Contract Tests
```bash
# API contract validation
pytest tests/contract/test_api_schema.py
```

---

## Debugging

### Local Lambda Debugging
```bash
# Use AWS SAM CLI
sam local invoke ScannerFunction --event events/scan-event.json

# Or debug with VS Code
# launch.json:
{
  "type": "python",
  "request": "launch",
  "name": "Debug Scanner",
  "module": "lambda_function",
  "cwd": "${workspaceFolder}/backend/scanner",
  "env": {
    "FINDINGS_TABLE": "cost-janitor-findings-dev",
    "CONFIG_TABLE": "cost-janitor-config-dev"
  }
}
```

### CloudWatch Logs Insights Queries
```sql
-- Find enrichment errors
fields @timestamp, @message
| filter @message like /ERROR/
| sort @timestamp desc
| limit 20

-- Scanner performance
fields @duration, @billedDuration, @memorySize, @maxMemoryUsed
| sort @timestamp desc
| limit 100

-- Teardown guardrail violations
fields @timestamp, @message
| filter @message like /Guardrail violation/
| sort @timestamp desc
```

---

## Release Process

### Versioning
- Semantic versioning: `MAJOR.MINOR.PATCH`
- Tag releases: `git tag v1.2.0`

### Release Checklist
- [ ] All tests pass
- [ ] Documentation updated
- [ ] CHANGELOG.md updated
- [ ] Version bumped
- [ ] Docker images built (if applicable)
- [ ] Deploy to staging
- [ ] Smoke tests pass
- [ ] Deploy to production
- [ ] Verify production health

### Hotfix Process
```bash
git checkout -b hotfix/1.2.1 main
# Make fix
git commit -m "fix: resolve teardown guardrail issue"
git tag v1.2.1
git push origin v1.2.1
# CI/CD deploys automatically
```

---

## Contributing

### Branch Strategy
- `main`: Production-ready
- `develop`: Integration branch (optional)
- `feature/*`: New features
- `fix/*`: Bug fixes
- `hotfix/*`: Production hotfixes

### Pull Request Template
```markdown
## Description
Brief description of changes

## Type
- [ ] Feature
- [ ] Bug fix
- [ ] Documentation
- [ ] Refactor

## Testing
- [ ] Unit tests added/updated
- [ ] Integration tests pass
- [ ] Manual testing done

## Checklist
- [ ] Code follows style guide
- [ ] Self-review completed
- [ ] Documentation updated
```

---

## Useful Commands

### Package Lambda for Deployment
```bash
cd backend/scanner
rm -rf package && mkdir package
pip install -r requirements.txt -t package/
cp *.py package/
cd package && zip -r ../../../scanner.zip .
```

### View Lambda Logs
```bash
aws logs tail /aws/lambda/cost-janitor-scanner-prod --follow --since 1h
```

### Update Single Lambda
```bash
aws lambda update-function-code \
  --function-name cost-janitor-scanner-prod \
  --zip-file fileb://scanner.zip
```

### Dry-run CloudFormation
```bash
aws cloudformation deploy --template-file infrastructure/template.yaml --stack-name cost-janitor-prod --no-execute-changeset
```