# Troubleshooting Guide

## Quick Diagnostics

### Health Check Commands
```bash
# 1. Stack status
aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].StackStatus'

# 2. Lambda health
for fn in scanner enrichment teardown api; do
  aws lambda get-function --function-name cost-janitor-${fn}-prod --query 'Configuration.[FunctionName,State,LastUpdateStatus,Runtime]'
done

# 3. DynamoDB tables
for table in findings approvals config prompts; do
  aws dynamodb describe-table --table-name cost-janitor-${table}-prod --query 'Table.[TableName,TableStatus,ItemCount,TableSizeBytes]'
done

# 4. EventBridge rule
aws events describe-rule --name cost-janitor-daily-scan-prod --query '[Name,State,ScheduleExpression]'

# 5. API Gateway
aws apigateway get-rest-apis --query 'items[?name==`cost-janitor-api-prod`].[id,name,createdDate]'

# 6. CloudFront
aws cloudfront get-distribution --id $(aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs[?OutputKey==`FrontendUrl`].OutputValue' --output text | cut -d'/' -f3) --query 'Distribution.[Status,DomainName]'

# 7. SNS subscriptions
aws sns list-subscriptions-by-topic --topic-arn $(aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs[?OutputKey==`ApprovalTopicArn`].OutputValue' --output text)
```

---

## Common Issues

### 1. Scanner Not Running / No Findings

#### Symptoms
- No new findings in dashboard
- EventBridge shows rule triggered but Lambda not invoked

#### Diagnosis
```bash
# Check EventBridge → Lambda permission
aws lambda get-policy --function-name cost-janitor-scanner-prod --query 'Policy' --output text | jq '.Statement[] | select(.Principal.Service=="events.amazonaws.com")'

# Check Lambda errors
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-scanner-prod --start-time $(date -d '2 hours ago' +%s)000 --filter-pattern ERROR

# Check last invocation
aws lambda get-function --function-name cost-janitor-scanner-prod --query 'Configuration.LastInvokeTime'
```

#### Solutions
| Cause | Fix |
|-------|-----|
| Missing EventBridge permission | `aws lambda add-permission --function-name cost-janitor-scanner-prod --principal events.amazonaws.com --statement-id EventBridgeInvoke --action lambda:InvokeFunction --source-arn arn:aws:events:region:account:rule/cost-janitor-daily-scan-prod` |
| Lambda timeout (5 min) | Increase timeout in CloudFormation, or chunk scan by region |
| Cross-account role failure | Verify trust policy, ExternalId, permissions |
| Target account throttling | Add retry logic, reduce API call rate |

---

### 2. Findings Stuck in PENDING_ENRICHMENT

#### Symptoms
- Findings appear but no enrichment, no approval emails

#### Diagnosis
```bash
# Check enrichment Lambda errors
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-enrichment-prod --start-time $(date -d '2 hours ago' +%s)000 --filter-pattern ERROR

# Check OpenAI API calls
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-enrichment-prod --start-time $(date -d '2 hours ago' +%s)000 --filter-pattern "OpenAI"

# Check prompt registry
aws dynamodb get-item --table-name cost-janitor-prompts-prod --key '{"model_name": {"S": "cost-janitor-enrichment"}, "version": {"S": "v1"}}'
```

#### Solutions
| Cause | Fix |
|-------|-----|
| Invalid OpenAI API key | Update Lambda env var or Secrets Manager |
| OpenAI rate limit | Add exponential backoff, reduce concurrency |
| Prompt registry empty | Run bootstrap.py or manually seed |
| Lambda timeout (3 min) | Increase timeout, optimize prompt |
| Invalid JSON response | Fix prompt to enforce JSON output |

#### Manual Re-processing
```bash
# Re-trigger enrichment for stuck findings
aws dynamodb scan --table-name cost-janitor-findings-prod \
  --filter-expression "#s = :pending" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":pending": {"S": "PENDING_ENRICHMENT"}}' \
  --projection-expression "finding_id" \
  --query 'Items[*].finding_id.S' --output text | tr '\t' '\n' | while read id; do
  aws lambda invoke --function-name cost-janitor-enrichment-prod --payload "{\"finding_id\": \"$id\"}" /tmp/out.json
  echo "Re-processed $id: $(cat /tmp/out.json)"
done
```

---

### 3. Approval Emails Not Received

#### Symptoms
- Findings enriched, approvals created, but no emails

#### Diagnosis
```bash
# Check SNS topic
aws sns get-topic-attributes --topic-arn $(aws cloudformation describe-stacks --stack-name cost-janitor-prod --query 'Stacks[0].Outputs[?OutputKey==`ApprovalTopicArn`].OutputValue' --output text)

# Check subscriptions
aws sns list-subscriptions-by-topic --topic-arn <topic-arn>

# Check Lambda SNS publish permission
aws lambda get-policy --function-name cost-janitor-enrichment-prod --query 'Policy' --output text | jq '.Statement[] | select(.Action=="sns:Publish")'

# Check CloudWatch for SNS errors
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-enrichment-prod --filter-pattern "SNS"
```

#### Solutions
| Cause | Fix |
|-------|-----|
| Email not confirmed | Check inbox for AWS confirmation email, click link |
| SNS topic policy missing | Add Lambda permission to publish |
| Email in spam folder | Check spam/junk, whitelist no-reply@sns.amazonaws.com |
| Wrong topic ARN | Verify stack output matches Lambda env var |

---

### 4. Teardown Fails / Guardrail Violations

#### Symptoms
- Teardown Lambda returns error or guardrail violation
- Resource not deleted despite approval

#### Diagnosis
```bash
# Check teardown logs
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-teardown-prod --start-time $(date -d '2 hours ago' +%s)000

# Check finding status and guardrails
aws dynamodb get-item --table-name cost-janitor-findings-prod --key '{"finding_id": {"S": "f-ec2-i-12345-20240115"}}'

# Check approval votes
aws dynamodb get-item --table-name cost-janitor-approvals-prod --key '{"approval_id": {"S": "appr-f-ec2-i-12345-20240115"}}'

# Check guardrails config
aws dynamodb get-item --table-name cost-janitor-config-prod --key '{"config_key": {"S": "guardrails"}}'
```

#### Solutions
| Error | Cause | Fix |
|-------|-------|-----|
| "Blocked tag: Environment=prod" | Resource has prod tag | Remove tag or add exception in guardrails |
| "Cost $150 > $100 requires 2 approvals" | Dual approval needed | Get second approver vote |
| "Cost $1200 exceeds maximum" | Above max teardown cost | Increase guardrail or manual deletion |
| "Approval not approved" | Status not APPROVED | Check votes, wait for second approval |
| "Insufficient approvals" | Only 1 of 2 required | Get second approver |
| "Resource not found" | Already deleted | Update finding status manually |
| "AccessDenied" on delete | Missing IAM permissions | Add delete permissions to TeardownRole |

#### Manual Status Update
```bash
# If teardown succeeded but status not updated
aws dynamodb update-item --table-name cost-janitor-findings-prod \
  --key '{"finding_id": {"S": "f-ec2-i-12345-20240115"}}' \
  --update-expression "SET #s = :complete, teardown_at = :now, teardown_result = :result" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":complete": {"S": "TEARDOWN_COMPLETE"}, ":now": {"S": "'$(date -u +%Y-%m-%dT%H:%M:%SZ)'"}, ":result": {"S": "Manually verified deleted"}}'
```

---

### 5. API Gateway Returns 5xx Errors

#### Symptoms
- Dashboard shows "Failed to load"
- API calls return 500/502/504

#### Diagnosis
```bash
# Check API Gateway metrics
aws cloudwatch get-metric-statistics --namespace AWS/ApiGateway --metric-name 5XXError --dimensions Name=ApiName,Value=cost-janitor-api-prod --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 60 --statistics Sum

# Check API Lambda errors
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-api-prod --start-time $(date -d '1 hour ago' +%s)000 --filter-pattern ERROR

# Check Lambda throttles
aws cloudwatch get-metric-statistics --namespace AWS/Lambda --metric-name Throttles --dimensions Name=FunctionName,Value=cost-janitor-api-prod --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 60 --statistics Sum
```

#### Solutions
| Cause | Fix |
|-------|-----|
| Lambda timeout (30s) | Increase API Lambda timeout |
| DynamoDB throttling | Enable on-demand or increase provisioned capacity |
| Lambda concurrency limit | Request limit increase or use reserved concurrency |
| Malformed request | Check API Gateway integration request mapping |
| CORS errors | Add CORS configuration to API Gateway |

---

### 6. Frontend Not Loading / Blank Page

#### Symptoms
- CloudFront URL shows blank page or 404
- React app doesn't load

#### Diagnosis
```bash
# Check CloudFront distribution
aws cloudfront get-distribution --id <distribution-id> --query 'Distribution.[Status,LastModifiedTime,DistributionConfig.Origins[0].DomainName]'

# Check S3 bucket
aws s3 ls s3://your-frontend-bucket/

# Check index.html exists
aws s3api head-object --bucket your-frontend-bucket --key index.html

# Check CloudFront cache behavior
curl -I https://<distribution-id>.cloudfront.net/
```

#### Solutions
| Cause | Fix |
|-------|-----|
| S3 bucket empty | Run frontend deploy pipeline |
| CloudFront not deployed | Wait for distribution status = Deployed |
| Wrong index.html path | Verify build output in S3 |
| SPA routing 404 | CloudFront custom error page 404→/index.html |
| CORS on API calls | Add CORS to API Gateway |
| Wrong API URL in build | Check REACT_APP_API_URL env var |

#### Force Cache Invalidation
```bash
aws cloudfront create-invalidation --distribution-id <id> --paths "/*"
```

---

### 6a. Local Dev: "Cannot GET /findings" or Empty Dashboard

#### Symptoms
- `Could not load findings` in the UI, sometimes followed by a raw HTML page
- Every KPI, chart and table is empty but there is no error
- Browser console shows `GET http://localhost:3000/findings 404`
- Votes appear to succeed but nothing changes

#### Cause
`REACT_APP_API_URL` is not set, so the frontend sends **relative** requests. Those
go to the CRA dev server, not the API. The dev server answers an unknown path with
`Cannot GET /findings` (axios does not send an `Accept: text/html` header, so
`historyApiFallback` does not apply).

This used to fail silently: the HTML body landed in `res.data`, `res.data?.items`
resolved to `undefined`, and every list endpoint reported success with zero items —
a plausible-looking but completely empty dashboard. The client now detects an HTML
body and raises a visible error instead.

#### Fix
```bash
cd frontend
cp .env.example .env      # Windows: copy .env.example .env
# edit .env:
#   REACT_APP_API_URL=https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
npm start                 # restart required: CRA reads .env at startup
```

Confirm the proxy picked it up — startup should log:
```
[setupProxy] proxying /findings, /approvals, /teardown, /config -> https://...
```

If it logs `[setupProxy] REACT_APP_API_URL is not set`, the `.env` is missing,
misnamed, or missing the `REACT_APP_` prefix.

#### Verify
```bash
curl http://localhost:3000/findings     # should return JSON, not HTML
```

---

### 7. High Costs / Unexpected Charges

#### Diagnosis
```bash
# Lambda costs
aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-01-31 --granularity DAILY --metrics UnblendedCost --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["AWS Lambda"]}}'

# DynamoDB costs
aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-01-31 --granularity DAILY --metrics UnblendedCost --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon DynamoDB"]}}'

# OpenAI costs (check OpenAI dashboard)
# API Gateway costs
aws ce get-cost-and-usage --time-period Start=2024-01-01,End=2024-01-31 --granularity DAILY --metrics UnblendedCost --filter '{"Dimensions": {"Key": "SERVICE", "Values": ["Amazon API Gateway"]}}'
```

#### Optimization
| Component | Optimization |
|-----------|--------------|
| Scanner Lambda | Reduce memory to 256MB, optimize boto3 calls |
| Enrichment Lambda | Cache OpenAI responses, batch findings |
| DynamoDB | Switch to provisioned if predictable load |
| API Gateway | Enable caching for GET /findings |
| CloudFront | Increase TTL, enable compression |
| OpenAI | Use gpt-4o-mini, shorter prompts |

---

### 8. Cross-Account Access Denied

#### Symptoms
- Scanner fails with `AccessDenied` on AssumeRole
- Findings empty for target account

#### Diagnosis
```bash
# Test role assumption manually
aws sts assume-role --role-arn arn:aws:iam::TARGET_ACCOUNT:role/CostJanitorScanner --role-session-name test --external-id cost-janitor-prod

# Check target account trust policy
aws iam get-role --role-name CostJanitorScanner --query 'Role.AssumeRolePolicyDocument'

# Check target account permissions
aws iam get-role-policy --role-name CostJanitorScanner --policy-name ScannerPolicy
```

#### Solutions
| Cause | Fix |
|-------|-----|
| Wrong ExternalId | Match exactly: `cost-janitor-prod` |
| Role doesn't exist | Create role in target account |
| Missing permissions | Attach ReadOnlyAccess or custom policy |
| Role session name conflict | Use unique session name |
| Account ID mismatch | Verify account ID in config |

---

### 9. DynamoDB Throttling / Performance

#### Symptoms
- `ProvisionedThroughputExceededException`
- Slow query responses
- High ConsumedCapacity metrics

#### Diagnosis
```bash
# Check consumed capacity
aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name ConsumedReadCapacityUnits --dimensions Name=TableName,Value=cost-janitor-findings-prod --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 300 --statistics Average,Maximum

# Check throttled requests
aws cloudwatch get-metric-statistics --namespace AWS/DynamoDB --metric-name ReadThrottleEvents --dimensions Name=TableName,Value=cost-janitor-findings-prod --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) --end-time $(date -u +%Y-%m-%dT%H:%M:%S) --period 300 --statistics Sum
```

#### Solutions
| Issue | Fix |
|-------|-----|
| On-demand but bursty | Enable provisioned with auto-scaling |
| Hot partition (finding_id) | Add random suffix to finding_id |
| Large item sizes | Move enrichment to separate table |
| Scan operations | Use Query with GSI instead |

---

### 10. OpenAI API Issues

#### Symptoms
- Enrichment fails with API errors
- High latency
- Invalid JSON responses

#### Diagnosis
```bash
# Test OpenAI API directly
curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/chat/completions \
  -d '{"model": "gpt-4o-mini", "messages": [{"role": "user", "content": "test"}], "max_tokens": 10}'

# Check enrichment logs for specific errors
aws logs filter-log-events --log-group-name /aws/lambda/cost-janitor-enrichment-prod --filter-pattern "OpenAI"
```

#### Solutions
| Error | Fix |
|-------|-----|
| 401 Unauthorized | Invalid API key, update secret |
| 429 Rate Limited | Add retry with exponential backoff |
| 500 Server Error | Retry, fallback to default enrichment |
| Invalid JSON | Fix prompt, add `response_format: {type: "json_object"}` |
| High latency | Increase Lambda timeout, reduce max_tokens |

---

## Emergency Procedures

### Complete System Reset
```bash
# 1. Disable scanner
aws events disable-rule --name cost-janitor-daily-scan-prod

# 2. Clear all findings (keep config)
aws dynamodb scan --table-name cost-janitor-findings-prod --projection-expression finding_id --query 'Items[*].finding_id.S' --output text | tr '\t' '\n' | xargs -I {} aws dynamodb delete-item --table-name cost-janitor-findings-prod --key '{"finding_id": {"S": "{}"}}'

# 3. Clear approvals
aws dynamodb scan --table-name cost-janitor-approvals-prod --projection-expression approval_id --query 'Items[*].approval_id.S' --output text | tr '\t' '\n' | xargs -I {} aws dynamodb delete-item --table-name cost-janitor-approvals-prod --key '{"approval_id": {"S": "{}"}}'

# 4. Re-enable scanner after fixes
aws events enable-rule --name cost-janitor-daily-scan-prod
```

### Rollback Lambda Code
```bash
# List versions
aws lambda list-versions-by-function --function-name cost-janitor-scanner-prod --query 'Versions[?Version!=`$LATEST`].Version' --output text

# Update alias to previous version
aws lambda update-alias --function-name cost-janitor-scanner-prod --name LIVE --function-version 5
```

### Disable Teardown Entirely
```bash
# Update guardrails to block all teardowns
aws dynamodb update-item --table-name cost-janitor-config-prod \
  --key '{"config_key": {"S": "guardrails"}}' \
  --update-expression "SET max_teardown_cost_usd = :zero" \
  --expression-attribute-values '{":zero": {"N": "0"}}'
```

---

## Log Analysis Queries

### CloudWatch Logs Insights

**Scanner Errors Last Hour**:
```sql
fields @timestamp, @message
| filter @logStream like /scanner/
| filter @message like /ERROR|Exception|Fail/
| sort @timestamp desc
| limit 50
```

**Enrichment Latency**:
```sql
fields @timestamp, @duration, @billedDuration, @memorySize, @maxMemoryUsed
| filter @logStream like /enrichment/
| stats avg(@duration), max(@duration), pct(@duration, 95)
| by bin(5m)
```

**Teardown Guardrail Blocks**:
```sql
fields @timestamp, @message
| filter @message like /Guardrail|blocked|violation/
| sort @timestamp desc
| limit 20
```

**Approval Flow**:
```sql
fields @timestamp, @message
| filter @logStream like /api/
| filter @message like /approval|vote|teardown/
| sort @timestamp desc
| limit 50
```

---

## Support Contacts

| Issue Type | Contact |
|------------|---------|
| AWS Infrastructure | Cloud/Platform team |
| OpenAI API | AI/ML team |
| Frontend Bugs | Frontend team |
| Security Incident | Security team (immediate) |
| Cost Anomalies | FinOps team |

---

## Runbook Index

| Scenario | Runbook |
|----------|---------|
| Scanner down | Section 1 |
| Enrichment stuck | Section 2 |
| No approval emails | Section 3 |
| Teardown blocked | Section 4 |
| API errors | Section 5 |
| Frontend broken | Section 6 |
| Cost spike | Section 7 |
| Cross-account fail | Section 8 |
| DynamoDB throttle | Section 9 |
| OpenAI issues | Section 10 |