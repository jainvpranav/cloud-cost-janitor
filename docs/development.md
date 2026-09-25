# Development Guide

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

#### 2. Start Development Server
```bash
# Set API URL for local development
export REACT_APP_API_URL=http://localhost:3001
npm start
```

#### 3. Mock API for Development
```bash
# Create mock server
cat > frontend/src/mockApi.js << 'EOF'
export const mockFindings = [
  {
    finding_id: "f-ec2-i-12345-20240115",
    resource_type: "EC2",
    resource_id: "i-12345",
    region: "us-east-1",
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
];

export const mockApprovals = [
  {
    approval_id: "appr-f-ec2-i-12345-20240115",
    finding_id: "f-ec2-i-12345-20240115",
    status: "PENDING",
    required_approvals: 1,
    votes: [],
    created_at: "2024-01-15T06:05:00Z",
    expires_at: "2024-01-22T06:05:00Z"
  }
];
EOF
```

#### 4. Run Tests
```bash
npm test -- --watchAll=false
```

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