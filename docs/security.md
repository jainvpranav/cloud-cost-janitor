# Security Guide

## Threat Model

### Assets to Protect
1. **AWS Credentials** - Cross-account role ARNs, assumed role credentials
2. **OpenAI API Key** - Stored in Lambda environment
3. **Resource Inventory** - Findings data with resource IDs, costs, tags
4. **Approval Decisions** - Audit trail of who approved what
5. **Teardown Actions** - Actual resource deletion capability

### Trust Boundaries
```
┌─────────────────────────────────────────────────────────────┐
│                    DEPLOYMENT ACCOUNT                        │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │   Scanner   │ │ Enrichment  │ │      Teardown           │ │
│  │   Lambda    │ │   Lambda    │ │      Lambda             │ │
│  └──────┬──────┘ └──────┬──────┘ └───────────┬─────────────┘ │
│         │             │                      │                │
│         ▼             ▼                      ▼                │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │              DynamoDB (Findings, Approvals)              │ │
│  └─────────────────────────────────────────────────────────┘ │
│         │             │                      │                │
│         ▼             ▼                      ▼                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────────────────┐ │
│  │    SNS      │ │  API GW     │ │    OpenAI API           │ │
│  │ (Email)     │ │  + Lambda   │ │    (External)           │ │
│  └─────────────┘ └─────────────┘ └─────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
         │
         ▼ STS AssumeRole (ExternalId)
┌─────────────────────────────────────────────────────────────┐
│                    TARGET ACCOUNT(S)                         │
│  ┌─────────────────────────────────────────────────────────┐ │
│  │  EC2, EBS, ELB, CloudWatch, AutoScaling, Pricing APIs   │ │
│  └─────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────┘
```

### Attack Vectors & Mitigations

| Vector | Risk | Mitigation |
|--------|------|------------|
| Compromised Lambda | Resource deletion | Guardrails, dual approval, dry-run default |
| Stolen OpenAI key | Cost abuse | Monitor usage, rotate keys, budget alerts |
| Cross-account role abuse | Unauthorized scanning | ExternalId condition, least privilege |
| API Gateway abuse | Data exfiltration | Rate limiting, auth (production) |
| SNS subscription hijack | Spam/phishing | Email confirmation required |
| Prompt injection | Malicious enrichment | Structured output, validation |
| Approval bypass | Unauthorized teardown | Dual approval, guardrails, audit logs |

---

## Security Controls

### 1. Identity & Access Management

#### Cross-Account Role (Target Account)
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "AWS": "arn:aws:iam::DEPLOY_ACCOUNT:root" },
    "Action": "sts:AssumeRole",
    "Condition": {
      "StringEquals": {
        "sts:ExternalId": "cost-janitor-prod"
      }
    }
  }]
}
```

**Key Points**:
- ExternalId prevents confused deputy attacks
- Role should have ReadOnlyAccess or custom policy
- No inline policies allowing writes

#### Lambda Execution Roles (Deployment Account)
Each Lambda has dedicated role with minimal permissions:
- **Scanner**: Read-only AWS APIs + DynamoDB write + Lambda invoke + SNS publish
- **Enrichment**: DynamoDB read/write + SNS publish
- **Teardown**: EC2/EBS/ELB delete + DynamoDB read/write
- **API**: DynamoDB read/write + Lambda invoke (teardown)

### 2. Data Protection

#### Encryption at Rest
- DynamoDB: AWS managed keys (default)
- S3 (frontend): SSE-S3
- Lambda env vars: KMS (optional, use Secrets Manager for production)

#### Encryption in Transit
- All AWS API calls: TLS 1.2+
- API Gateway: HTTPS only
- CloudFront: HTTPS only, TLS 1.2 minimum

#### Secrets Management
**Current**: OpenAI API key in Lambda environment variable
**Production Recommendation**: AWS Secrets Manager

```yaml
# CloudFormation addition
OpenAISecret:
  Type: AWS::SecretsManager::Secret
  Properties:
    Name: cost-janitor/openai-api-key
    GenerateSecretString:
      SecretStringTemplate: '{"api_key": ""}'
      GenerateStringKey: "api_key"
      ExcludeCharacters: '"@/\'

EnrichmentFunction:
  Environment:
    Variables:
      OPENAI_API_KEY: '{{resolve:secretsmanager:cost-janitor/openai-api-key:SecretString:api_key}}'
```

### 3. Network Security

#### VPC Configuration (Optional)
```yaml
# Add to each Lambda
VpcConfig:
  SubnetIds: [!Ref PrivateSubnet1, !Ref PrivateSubnet2]
  SecurityGroupIds: [!Ref LambdaSecurityGroup]

LambdaSecurityGroup:
  Type: AWS::EC2::SecurityGroup
  Properties:
    GroupDescription: Cost Janitor Lambda SG
    VpcId: !Ref VPC
    SecurityGroupEgress:
      - IpProtocol: tcp
        FromPort: 443
        ToPort: 443
        CidrIp: 0.0.0.0/0  # For AWS APIs, OpenAI
```

#### API Gateway Security
```yaml
# Add API Key + Usage Plan
ApiKey:
  Type: AWS::ApiGateway::ApiKey
  Properties:
    Name: cost-janitor-api-key
    Enabled: true

UsagePlan:
  Type: AWS::ApiGateway::UsagePlan
  Properties:
    ApiStages:
      - ApiId: !Ref ApiGateway
        Stage: !Ref Environment
    Throttle:
      RateLimit: 100
      BurstLimit: 200
    Quota:
      Limit: 10000
      Period: DAY
```

### 4. Application Security

#### Guardrails (Enforced in Teardown)
```python
GUARDRAILS = {
    "blocked_tags": {
        "Environment": ["prod", "production", "Prod", "Production"],
        "CostJanitor": ["protect", "do-not-delete", "keep"],
    },
    "dual_approval_threshold_usd": 100.0,
    "max_teardown_cost_usd": 1000.0,
    "dry_run_default": True,
    "require_snapshot_for_ebs": True,
    "max_resources_per_run": 10,
}
```

#### Input Validation
- All API inputs validated via JSON schema
- Finding IDs validated against UUID pattern
- Approval decisions restricted to `approve|reject`

#### Output Encoding
- React auto-escapes JSX
- API returns JSON with proper Content-Type

#### Prompt Injection Protection
```python
# Enrichment uses structured output
response_format={"type": "json_object"}

# Validate response schema
required_fields = ["risk_assessment", "recommendation", "confidence"]
for field in required_fields:
    if field not in enrichment:
        raise ValueError(f"Missing required field: {field}")

# Confidence bounds
enrichment["confidence"] = max(0.0, min(1.0, enrichment.get("confidence", 0)))
```

### 5. Audit & Compliance

#### CloudTrail Logging
Enable CloudTrail for all accounts:
```bash
aws cloudtrail create-trail \
  --name cost-janitor-audit \
  --s3-bucket-name your-audit-bucket \
  --is-multi-region-trail \
  --enable-log-file-validation
```

#### Key Events to Monitor
| Event | Source | Alert |
|-------|--------|-------|
| `AssumeRole` | CloudTrail | Unexpected principal |
| `DeleteVolume` | CloudTrail | Without snapshot |
| `TerminateInstances` | CloudTrail | Production tags |
| `InvokeFunction` (teardown) | CloudTrail | Non-API Gateway source |
| `PutItem` (approvals) | DynamoDB Streams | Status changes |

#### DynamoDB Streams for Audit
```yaml
FindingsTable:
  Type: AWS::DynamoDB::Table
  Properties:
    StreamSpecification:
      StreamViewType: NEW_AND_OLD_IMAGES
```

### 6. Incident Response

#### Compromised OpenAI Key
1. Revoke key in OpenAI dashboard
2. Generate new key
3. Update Secrets Manager
4. Rotate within 1 hour

#### Compromised Cross-Account Role
1. Delete role in target account
2. Create new role with new ExternalId
3. Update bootstrap config
4. Redeploy stack

#### Unauthorized Teardown
1. Check CloudTrail for `TerminateInstances`/`DeleteVolume`
2. Identify approval ID from finding
3. Review approval votes
4. Check guardrail bypass
5. Restore from snapshot/AMI if needed

---

## Compliance Checklist

### SOC 2 Type II
- [ ] Access controls (IAM least privilege)
- [ ] Encryption at rest/in transit
- [ ] Audit logging (CloudTrail)
- [ ] Change management (GitHub + CFN)
- [ ] Incident response plan
- [ ] Vendor management (OpenAI DPA)

### GDPR (if applicable)
- [ ] No personal data in findings
- [ ] Data retention policy (TTL 90 days)
- [ ] Right to deletion (manual process)
- [ ] Data processing agreement with OpenAI

### PCI DSS (if scanning payment accounts)
- [ ] Network segmentation
- [ ] No cardholder data in logs
- [ ] Quarterly vulnerability scans
- [ ] Annual penetration test

---

## Security Testing

### Static Analysis
```bash
# Python
bandit -r backend/
safety check -r backend/scanner/requirements.txt

# JavaScript
npm audit
```

### Dynamic Testing
```bash
# OWASP ZAP scan on API Gateway
zap.sh -daemon -port 8080
zap-api-scan.py -t https://api.example.com/prod -f openapi -r zap-report.html
```

### Penetration Testing Scope
- API Gateway endpoints
- Lambda function URLs (if any)
- Cross-account role trust policy
- SNS subscription confirmation
- Frontend XSS/CSRF

### Dependency Scanning
```bash
# Automated in CI/CD
pip-audit -r requirements.txt
npm audit --audit-level high
```

---

## Security Configuration Checklist

### Pre-Deployment
- [ ] ExternalId is unique and secret
- [ ] Target account role has read-only permissions
- [ ] OpenAI key in Secrets Manager (prod)
- [ ] API Gateway has auth (prod)
- [ ] CloudTrail enabled in all accounts
- [ ] Guardrails configured appropriately
- [ ] SNS subscriptions confirmed

### Post-Deployment
- [ ] Verify scanner can assume role
- [ ] Verify enrichment works
- [ ] Test approval flow end-to-end
- [ ] Test teardown dry-run
- [ ] Verify CloudTrail logs appear
- [ ] Test guardrail blocks prod resources
- [ ] Verify TTL cleanup works

### Ongoing
- [ ] Monthly access review (IAM roles)
- [ ] Quarterly key rotation (OpenAI, ExternalId)
- [ ] Annual penetration test
- [ ] Monitor CloudTrail for anomalies
- [ ] Review guardrail effectiveness
- [ ] Update dependencies monthly