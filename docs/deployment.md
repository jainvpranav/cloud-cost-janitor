# Deployment Guide

## Prerequisites

### AWS Account Setup
1. **Target Account** (where resources are scanned):
   - Create IAM role `CostJanitorScanner` with trust policy:
   ```json
   {
     "Version": "2012-10-17",
     "Statement": [{
       "Effect": "Allow",
       "Principal": { "AWS": "arn:aws:iam::DEPLOY_ACCOUNT:root" },
       "Action": "sts:AssumeRole",
       "Condition": { "StringEquals": { "sts:ExternalId": "cost-janitor-prod" } }
     }]
   }
   ```
   - Attach policy: `arn:aws:iam::aws:policy/ReadOnlyAccess` (or custom least-privilege)

2. **Deployment Account** (where stack runs):
   - Admin permissions for CloudFormation, Lambda, DynamoDB, API Gateway, S3, CloudFront, SNS, IAM

### Required Tools
- AWS CLI v2 configured
- GitHub repository
- OpenAI API key

---

## Manual Deployment (One-Time)

### 1. Create Artifacts Bucket
```bash
aws s3 mb s3://your-artifacts-bucket --region us-east-1
aws s3api put-bucket-versioning --bucket your-artifacts-bucket --versioning-configuration Status=Enabled
```

### 2. Create Frontend Bucket
```bash
aws s3 mb s3://your-frontend-bucket --region us-east-1
aws s3 website s3://your-frontend-bucket --index-document index.html --error-document index.html
```

### 3. Deploy CloudFormation Stack
```bash
aws cloudformation deploy \
  --template-file infrastructure/template.yaml \
  --stack-name cost-janitor-prod \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides \
    Environment=prod \
    OpenAIApiKey=sk-your-openai-key \
    NotificationEmail=admin@company.com \
    FrontendBucketName=your-frontend-bucket \
  --region us-east-1
```

### 4. Get Stack Outputs
```bash
aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs'
```

### 5. Configure GitHub Secrets
Go to GitHub repo → Settings → Secrets → Actions → New repository secret:

| Secret | Value |
|--------|-------|
| `AWS_DEPLOY_ROLE_ARN` | Role for GitHub Actions (with CloudFormation/Lambda/S3/CloudFront permissions) |
| `ARTIFACTS_BUCKET` | your-artifacts-bucket |
| `OPENAI_API_KEY` | sk-your-openai-key |
| `NOTIFICATION_EMAIL` | admin@company.com |
| `FRONTEND_BUCKET` | your-frontend-bucket |
| `CLOUDFRONT_DISTRIBUTION_ID` | From stack output `FrontendUrl` |
| `API_GATEWAY_ID` | From stack output `ApiEndpoint` |

### 6. Run Bootstrap
```bash
pip install -r requirements-bootstrap.txt
python bootstrap.py \
  --stack-name cost-janitor-prod \
  --region us-east-1 \
  --role-arn arn:aws:iam::TARGET_ACCOUNT:role/CostJanitorScanner \
  --account-id TARGET_ACCOUNT \
  --notification-emails admin@company.com finops@company.com
```

### 7. Trigger First Scan
```bash
aws events put-events --entries '[{"Source":"cost-janitor","DetailType":"ManualScan","Detail":"{}"}]' --region us-east-1
```

---

## CI/CD Pipeline Setup

### GitHub Actions Permissions
Create IAM role for GitHub Actions with trust policy:
```json
{
  "Version": "2012-10-17",
  "Statement": [{
    "Effect": "Allow",
    "Principal": { "Federated": "arn:aws:iam::DEPLOY_ACCOUNT:oidc-provider/token.actions.githubusercontent.com" },
    "Action": "sts:AssumeRoleWithWebIdentity",
    "Condition": {
      "StringLike": {
        "token.actions.githubusercontent.com:sub": "repo:YOUR_ORG/YOUR_REPO:*"
      }
    }
  }]
}
```

Attach policies:
- `AWSCloudFormationFullAccess`
- `AWSLambda_FullAccess`
- `AmazonDynamoDBFullAccess`
- `AmazonAPIGatewayAdministrator`
- `AmazonS3FullAccess`
- `CloudFrontFullAccess`
- `IAMFullAccess` (for role creation)

Use this role ARN as `AWS_DEPLOY_ROLE_ARN`.

### Pipeline Triggers
- **Backend**: Push to `main` with changes in `backend/**` or `infrastructure/**`
- **Frontend**: Push to `main` with changes in `frontend/**`

### Manual Trigger
```bash
# Via GitHub CLI
gh workflow run backend.yml
gh workflow run frontend.yml
```

---

## Multi-Account Deployment

### Option 1: StackSets (Recommended)
```bash
aws cloudformation create-stack-set \
  --stack-set-name cost-janitor \
  --template-body file://infrastructure/template.yaml \
  --parameters ParameterKey=Environment,ParameterValue=prod \
               ParameterKey=OpenAIApiKey,ParameterValue=sk-xxx \
               ParameterKey=NotificationEmail,ParameterValue=admin@company.com \
  --permission-model SERVICE_MANAGED \
  --auto-deployment Enabled=true,RetainStacksOnAccountRemoval=false \
  --region us-east-1

aws cloudformation create-stack-instances \
  --stack-set-name cost-janitor \
  --accounts '["111111111111","222222222222"]' \
  --regions '["us-east-1"]' \
  --parameter-overrides ParameterKey=RoleArn,ParameterValue=arn:aws:iam::${ACCOUNT}:role/CostJanitorScanner
```

### Option 2: Separate Stacks Per Account
Deploy stack in each account with account-specific parameters.

### Option 3: Central Scanner with Multiple Roles
Modify scanner config to accept array of role ARNs (code change required).

---

## Environment Variables

### Lambda Environment Variables (Set via CloudFormation)
| Lambda | Variable | Source |
|--------|----------|--------|
| Scanner | `FINDINGS_TABLE` | Stack output |
| Scanner | `CONFIG_TABLE` | Stack output |
| Scanner | `ENRICHMENT_FUNCTION` | Stack output |
| Scanner | `APPROVAL_TOPIC_ARN` | Stack output |
| Enrichment | `OPENAI_API_KEY` | Parameter |
| Enrichment | `PROMPT_REGISTRY_TABLE` | Stack output |
| Teardown | `FINDINGS_TABLE` | Stack output |
| Teardown | `APPROVALS_TABLE` | Stack output |
| Teardown | `CONFIG_TABLE` | Stack output |
| API | `TEARDOWN_FUNCTION` | Stack output |

---

## Post-Deployment Verification

### 1. Verify Stack Resources
```bash
aws cloudformation list-stack-resources --stack-name cost-janitor-prod
```

### 2. Test Scanner
```bash
aws lambda invoke --function-name cost-janitor-scanner-prod --payload '{}' /tmp/out.json
cat /tmp/out.json
```

### 3. Test API
```bash
# Get API endpoint from stack output
API=$(aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text)
curl "$API/findings"
curl "$API/config"
```

### 4. Verify Frontend
```bash
FRONTEND=$(aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs[?OutputKey==`FrontendUrl`].OutputValue' --output text)
open "$FRONTEND"
```

### 5. Check CloudWatch Logs
```bash
aws logs describe-log-groups --log-group-name-prefix /aws/lambda/cost-janitor
```

---

## Updating Configuration

### Via Dashboard
1. Open frontend URL
2. Navigate to Settings
3. Modify thresholds, tags, emails
4. Click Save

### Via CLI
```bash
aws dynamodb update-item \
  --table-name cost-janitor-config-prod \
  --key '{"config_key": {"S": "scan_config"}}' \
  --update-expression "SET cpu_threshold_percent = :val" \
  --expression-attribute-values '{":val": {"N": "3.0"}}'
```

### Update Prompt Template
```bash
aws dynamodb put-item \
  --table-name cost-janitor-prompts-prod \
  --item '{
    "model_name": {"S": "cost-janitor-enrichment"},
    "version": {"S": "v2"},
    "template": {"S": "Your new prompt template..."},
    "is_active": {"BOOL": true}
  }'
```

---

## Rollback Procedure

### Lambda Code Rollback
```bash
# List versions
aws lambda list-versions-by-function --function-name cost-janitor-scanner-prod

# Update to previous version
aws lambda update-alias --function-name cost-janitor-scanner-prod --name LIVE --function-version 5
```

### CloudFormation Rollback
```bash
# If stack update failed
aws cloudformation rollback-stack --stack-name cost-janitor-prod

# Or delete and redeploy
aws cloudformation delete-stack --stack-name cost-janitor-prod
# Wait for DELETE_COMPLETE, then redeploy
```

---

## Cost Optimization

### Reduce Costs
1. **DynamoDB**: Switch to provisioned capacity if predictable
2. **Lambda**: Right-size memory (test with 256MB for scanner)
3. **API Gateway**: Enable caching for GET /findings
4. **CloudFront**: Increase TTL for static assets
5. **OpenAI**: Cache enrichment results for identical findings

### Monitor Costs
```bash
# AWS Cost Explorer CLI
aws ce get-cost-and-usage \
  --time-period Start=2024-01-01,End=2024-01-31 \
  --granularity MONTHLY \
  --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE
```

---

## Troubleshooting

### Scanner Not Finding Resources
- Verify cross-account role trust policy
- Check ExternalId matches (`cost-janitor-prod`)
- Confirm role has required read permissions
- Check CloudWatch Logs for errors

### Enrichment Failing
- Verify OpenAI API key is valid
- Check Lambda timeout (increase if needed)
- Check prompt registry has active template
- Monitor OpenAI rate limits

### Approval Emails Not Sending
- Verify SNS subscription confirmed (check email)
- Check SNS topic policy allows Lambda
- Verify Lambda has `sns:Publish` permission

### Teardown Not Working
- Check approval status is `APPROVED`
- Verify required approvals met
- Check guardrails not blocking (prod tags, cost limits)
- Review CloudWatch Logs for teardown Lambda

### Frontend Not Loading
- Check CloudFront distribution status (Deployed)
- Verify S3 bucket has index.html
- Check OAI permissions on S3 bucket
- Verify CloudFront custom error pages (404→index.html)

---

## Security Hardening (Production)

1. **Enable WAF** on API Gateway
2. **Add Cognito Auth** to API Gateway
3. **Use Secrets Manager** for OpenAI key
4. **Enable VPC** for Lambdas
5. **Add CloudTrail** logging
6. **Enable GuardDuty** in target accounts
7. **Rotate ExternalId** periodically
8. **Add Resource Policies** to DynamoDB tables