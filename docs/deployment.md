# Deployment Guide

After a one-time setup, every push to `master` deploys the whole platform: API, MCP endpoint for the agent, dashboard and the daily scan. Demo resources are separate and only exist when someone creates them.

## What gets deployed

| Stack | Template | How | When |
|---|---|---|---|
| `cost-janitor-github-oidc` | `infrastructure/github-oidc.yaml` | By hand, once | Before the first push |
| `cost-janitor-prod` | `infrastructure/template.yaml` | `deploy.yml` workflow | Every push to `master` |
| `janitor-demo` | `infrastructure/demo/idle-resources.yaml` | `demo-resources.yml` workflow, `create` | Only on request; auto-deleted after `DEMO_TTL_HOURS` |

## One-time setup

### 1. Deploy the OIDC stack

Run with admin credentials in the target account (a sandbox, not one with real workloads):

```bash
aws cloudformation deploy \
  --stack-name cost-janitor-github-oidc \
  --template-file infrastructure/github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameter-overrides BudgetEmail=<your-email>
```

It creates:

- the GitHub OIDC identity provider (pass `ExistingOidcProviderArn=<arn>` if the account already has one; only one is allowed)
- `cost-janitor-github-deploy`, a role GitHub Actions assumes, trusted only for this repo's `master` branch and `prod` environment
- the Lambda artifacts bucket (30-day expiry)
- a $20/month AWS Budget with email alerts at 25%, 50%, 80% and a 100% forecast

Read the outputs:

```bash
aws cloudformation describe-stacks --stack-name cost-janitor-github-oidc \
  --query 'Stacks[0].Outputs' --output table
```

### 2. Configure GitHub

GitHub → Settings → Environments → create `prod`. Then Settings → Secrets and variables → Actions, scoped to `prod`:

| Name | Kind | Required | Value |
|---|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Secret | Yes | `DeployRoleArn` output |
| `NOTIFICATION_EMAIL` | Secret | Yes | Team email for SNS notices (confirm the subscription email) |
| `OPENAI_API_KEY` | Secret | No | Only if `ENRICHMENT_ENABLED=true` |
| `ARTIFACTS_BUCKET` | Variable | Yes | `ArtifactsBucketName` output |
| `FRONTEND_BUCKET_NAME` | Variable | Yes | Globally unique, must start with `cost-janitor-`, e.g. `cost-janitor-frontend-<team>-<random>` |
| `AWS_REGION` | Variable | No | Default `us-east-1` |
| `DEMO_TTL_HOURS` | Variable | No | Default `8` (max 24) |
| `ENRICHMENT_ENABLED` | Variable | No | Default `false`; the TrueForge agent replaces enrichment |
| `TEARDOWN_SCOPE_TAG_VALUE` | Variable | No | Default `demo`: teardown can only delete resources tagged `CostJanitor=demo`. Set to an empty string to allow any resource. |

The MCP API key is **not** stored in GitHub. The stack creates it; read it after the first deploy (below) and store it only in TrueForge.

### 3. Push

Merge to `master`. `deploy.yml` runs:

1. **test**: backend tests, `cfn-lint`, Lambda packaging, frontend tests and build (the same as `ci.yml`)
2. **backend**: package 5 Lambdas → upload → deploy `cost-janitor-prod` → update Lambda code → redeploy the API stage → smoke test (`/findings` 200, CORS preflight, `/mcp` rejects calls without a key)
3. **frontend**: build with the stack's `ApiEndpoint` → upload (hashed assets cached for a year, `index.html` never cached) → CloudFront invalidation

The first run takes 10–15 minutes because CloudFront is created. The job summary lists `FrontendUrl`, `ApiEndpoint`, `McpEndpoint` and `McpApiKeyId`.

### 4. Get the MCP API key

```bash
aws apigateway get-api-key --api-key <McpApiKeyId> --include-value --query value --output text
```

Paste it into TrueForge's secret store and send it as the `x-api-key` header to `McpEndpoint`. See `agent/janitor-agent.md`.

### 5. Seed configuration (optional)

The scanner works with built-in defaults. To write scan config and guardrails explicitly (single account: leave the role ARN empty):

```bash
pip install -r requirements-bootstrap.txt
python bootstrap.py --stack-name cost-janitor-prod --region us-east-1 --role-arn "" --account-id <account-id>
```

## Demo resources

GitHub → Actions → **Demo resources** → Run workflow → `create`. It deploys `janitor-demo` into the default VPC (about $0.062/hour) and schedules deletion after `DEMO_TTL_HOURS`. An hourly scheduled run deletes it once expired; `delete` removes it immediately. See [operations.md](operations.md#demo-runbook).

## Pipeline reference

| Workflow | Trigger | Purpose |
|---|---|---|
| `ci.yml` | Pull requests, pushes to other branches, called by `deploy.yml` | Tests, lint, package, build |
| `deploy.yml` | Push to `master`, manual | Deploy platform |
| `demo-resources.yml` | Manual (`create` / `delete`), hourly schedule | Demo stack lifecycle |

```bash
gh workflow run deploy.yml
gh workflow run demo-resources.yml -f action=create
gh workflow run demo-resources.yml -f action=delete
```

If the very first deploy fails, CloudFormation leaves the stack in `ROLLBACK_COMPLETE`; the next run deletes it and starts over automatically.

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
| API | `ALLOWED_ORIGIN` | CloudFront domain (set by the template) |

`ALLOWED_ORIGIN` becomes the `Access-Control-Allow-Origin` header. The UI and the
API are on different origins, so this must match the CloudFront domain or the
browser will block every read. The template sets it automatically. If you override
it, use the exact scheme and host with no trailing slash, e.g.
`https://d111111abcdef8.cloudfront.net`.

### Frontend Build Variables
| Variable | Required | Description |
|----------|----------|-------------|
| `REACT_APP_API_URL` | yes | API base URL from the `ApiUrl` stack output. Baked into the bundle at build time. |

Set this in the frontend CI workflow before `npm run build`. Create React App only
exposes `REACT_APP_`-prefixed variables, and a build with this unset produces a
bundle that cannot reach the API.

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

### 4a. Verify CORS

The browser blocks cross-origin reads silently, so check this explicitly rather than
inferring it from the page looking empty.

```bash
API=$(aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs[?OutputKey==`ApiEndpoint`].OutputValue' --output text)

# Preflight must return 204 with the allow headers
curl -i -X OPTIONS "$API/findings" \
  -H "Origin: $FRONTEND" \
  -H "Access-Control-Request-Method: GET"

# A real read must include Access-Control-Allow-Origin
curl -i "$API/findings" -H "Origin: $FRONTEND" | grep -i access-control-allow-origin
```

If preflight returns `403 Missing Authentication Token`, the resource has no
`OPTIONS` method in the template. If the header is missing entirely, check
`ALLOWED_ORIGIN` on the API Lambda.

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