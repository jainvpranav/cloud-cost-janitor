# Operations Guide

## Daily Operations

### Morning Checklist (Automated)
- [ ] EventBridge triggered scanner at 6:00 AM UTC
- [ ] Scanner completed without errors (check CloudWatch)
- [ ] New findings appear in dashboard
- [ ] Enrichment completed for new findings
- [ ] Approval notifications sent via email

### Manual Verification
```bash
# Check last scan time
aws dynamodb scan --table-name cost-janitor-findings-prod \
  --filter-expression "attribute_exists(detected_at)" \
  --projection-expression "detected_at" \
  --max-items 1 \
  --query 'Items[0].detected_at.S'

# Count findings by status
aws dynamodb scan --table-name cost-janitor-findings-prod \
  --select COUNT \
  --query 'Count'
```

---

## Weekly Operations

### Approval Review
1. Open Approvals page in dashboard
2. Review each pending approval:
   - Check AI recommendation and confidence
   - Verify resource tags (not production)
   - Confirm cost is reasonable
3. Vote approve/reject with team member

### Cost Tracking
```bash
# Monthly savings from completed teardowns
aws dynamodb scan --table-name cost-janitor-findings-prod \
  --filter-expression "#s = :complete" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":complete": {"S": "TEARDOWN_COMPLETE"}}' \
  --projection-expression "monthly_cost_usd" \
  --query 'Items[*].monthly_cost_usd.N'
```

### Cleanup Expired Approvals
```bash
# TTL handles this automatically, but verify
aws dynamodb scan --table-name cost-janitor-approvals-prod \
  --filter-expression "#s = :expired" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":expired": {"S": "EXPIRED"}}' \
  --select COUNT
```

---

## Monthly Operations

### Threshold Tuning
Review and adjust based on false positives/negatives:
- CPU threshold: Lower if missing idle instances
- EBS days: Increase if deleting too aggressively
- LB days: Adjust based on traffic patterns

### Prompt Optimization
1. Review enrichment quality in dashboard
2. Update prompt template in DynamoDB if needed
3. Test with `bootstrap.py --dry-run` first

### Cost Report
Generate monthly savings report:
```python
# Run in Python shell
import boto3
dynamodb = boto3.resource('dynamodb', region_name='us-east-1')
table = dynamodb.Table('cost-janitor-findings-prod')

response = table.scan(
    FilterExpression='#s = :complete',
    ExpressionAttributeNames={'#s': 'status'},
    ExpressionAttributeValues={':complete': {'S': 'TEARDOWN_COMPLETE'}},
    ProjectionExpression='monthly_cost_usd, teardown_at'
)

total_monthly = sum(float(item['monthly_cost_usd']) for item in response['Items'])
annual_savings = total_monthly * 12
print(f"Monthly savings: ${total_monthly:.2f}")
print(f"Annual savings: ${annual_savings:.2f}")
```

---

## Incident Response

### Scanner Failed
**Symptoms**: No new findings, CloudWatch alarms firing

**Diagnosis**:
```bash
# Check Lambda errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/cost-janitor-scanner-prod \
  --start-time $(date -d '1 hour ago' +%s)000 \
  --filter-pattern ERROR

# Check last successful invocation
aws lambda get-function --function-name cost-janitor-scanner-prod \
  --query 'Configuration.LastModifyStatus'
```

**Resolution**:
1. Check cross-account role permissions
2. Verify target account not throttling
3. Increase Lambda timeout if needed
4. Re-deploy scanner Lambda if code issue

### Enrichment Stuck
**Symptoms**: Findings stuck in `PENDING_ENRICHMENT`

**Diagnosis**:
```bash
# Check enrichment Lambda errors
aws logs filter-log-events \
  --log-group-name /aws/lambda/cost-janitor-enrichment-prod \
  --start-time $(date -d '1 hour ago' +%s)000 \
  --filter-pattern ERROR

# Check OpenAI API status
curl -H "Authorization: Bearer $OPENAI_API_KEY" https://api.openai.com/v1/models
```

**Resolution**:
1. Verify OpenAI API key valid and has quota
2. Check prompt registry has active template
3. Increase Lambda memory/timeout
4. Re-process stuck findings:
```bash
aws lambda invoke --function-name cost-janitor-enrichment-prod \
  --payload '{"finding_id": "f-ec2-i-12345-20240115"}' /tmp/out.json
```

### Teardown Failed
**Symptoms**: Approval shows APPROVED but resource still exists

**Diagnosis**:
```bash
# Check teardown Lambda logs
aws logs filter-log-events \
  --log-group-name /aws/lambda/cost-janitor-teardown-prod \
  --start-time $(date -d '1 day ago' +%s)000

# Check finding status
aws dynamodb get-item --table-name cost-janitor-findings-prod \
  --key '{"finding_id": {"S": "f-ec2-i-12345-20240115"}}'
```

**Resolution**:
1. Check guardrail violations in logs
2. Verify IAM permissions for deletion
3. For EBS: Check snapshot creation succeeded
4. For ELB: Verify no deletion protection enabled
5. Manual cleanup if needed, then update finding status

### API Gateway Errors
**Symptoms**: Dashboard shows errors, 5xx responses

**Diagnosis**:
```bash
# Check API Gateway metrics
aws cloudwatch get-metric-statistics \
  --namespace AWS/ApiGateway \
  --metric-name 5XXError \
  --dimensions Name=ApiName,Value=cost-janitor-api-prod \
  --start-time $(date -d '1 hour ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S) \
  --period 300 --statistics Sum
```

**Resolution**:
1. Check API Lambda logs
2. Verify DynamoDB not throttling
3. Check Lambda concurrency limits
4. Redeploy API Lambda if needed

---

## Scaling Operations

### Increase Scan Frequency
```bash
# Update EventBridge rule to run every 6 hours
aws events put-rule \
  --name cost-janitor-daily-scan-prod \
  --schedule-expression "cron(0 */6 * * ? *)"
```

### Multi-Region Scanning
Modify scanner to iterate regions:
```python
# In scanner/lambda_function.py
REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1']
for region in REGIONS:
    client = AWSClient(role_arn=config.role_arn, region=region)
    # ... scan logic
```

### Add Resource Types
1. Add new scanner function in `rules.py`
2. Add detection logic in `aws_client.py`
3. Add cost estimation
4. Update CloudFormation IAM permissions
5. Update frontend to display new type

---

## Backup & Recovery

### DynamoDB Backup
```bash
# On-demand backup
aws dynamodb create-backup \
  --table-name cost-janitor-findings-prod \
  --backup-name findings-backup-$(date +%Y%m%d)

# Point-in-time recovery (enable once)
aws dynamodb update-continuous-backups \
  --table-name cost-janitor-findings-prod \
  --point-in-time-recovery-specification PointInTimeRecoveryEnabled=true
```

### Configuration Backup
```bash
# Export config
aws dynamodb get-item --table-name cost-janitor-config-prod \
  --key '{"config_key": {"S": "scan_config"}}' > scan_config.json

aws dynamodb get-item --table-name cost-janitor-config-prod \
  --key '{"config_key": {"S": "guardrails"}}' > guardrails.json

# Backup prompts
aws dynamodb scan --table-name cost-janitor-prompts-prod > prompts.json
```

### Restore Procedure
```bash
# Restore table from backup
aws dynamodb restore-table-from-backup \
  --target-table-name cost-janitor-findings-prod-restored \
  --backup-arn arn:aws:dynamodb:us-east-1:123456789012:table/cost-janitor-findings-prod/backup/xxx

# Update CloudFormation to point to restored table (or rename)
```

---

## Security Operations

### Rotate OpenAI Key
```bash
# Update Lambda environment variable
aws lambda update-function-configuration \
  --function-name cost-janitor-enrichment-prod \
  --environment Variables={OPENAI_API_KEY=sk-new-key,...}
```

### Rotate ExternalId
1. Generate new ExternalId
2. Update target account role trust policy
3. Update scanner Lambda environment
4. Deploy stack update

### Audit Access
```bash
# Check who invoked teardown
aws cloudtrail lookup-events \
  --lookup-attributes AttributeKey=EventName,AttributeValue=Invoke \
  --resource-name cost-janitor-teardown-prod \
  --start-time $(date -d '7 days ago' +%Y-%m-%d)
```

---

## Performance Tuning

### DynamoDB Optimization
```bash
# Check consumed capacity
aws cloudwatch get-metric-statistics \
  --namespace AWS/DynamoDB \
  --metric-name ConsumedReadCapacityUnits \
  --dimensions Name=TableName,Value=cost-janitor-findings-prod \
  --period 3600 --statistics Sum \
  --start-time $(date -d '1 day ago' -u +%Y-%m-%dT%H:%M:%S) \
  --end-time $(date -u +%Y-%m-%dT%H:%M:%S)
```

### Lambda Optimization
| Function | Current Memory | Recommended Test |
|----------|---------------|------------------|
| Scanner | 512MB | 1024MB (faster API calls) |
| Enrichment | 1024MB | Keep (OpenAI SDK) |
| API | 256MB | 512MB if high concurrency |
| Teardown | 512MB | Keep |

### Cost Optimization
```bash
# Enable Compute Savings Plans for consistent Lambda usage
# Use DynamoDB on-demand → provisioned if > 100K reads/day
# CloudFront: Increase TTL, enable compression
```

---

## Monitoring Dashboard

### Key CloudWatch Dashboards
Create dashboard with widgets:
1. **Scanner**: Invocations, Errors, Duration, Throttles
2. **Enrichment**: Invocations, Errors, Duration, OpenAI latency
3. **API**: Request count, 4xx/5xx, Latency (p50, p95, p99)
4. **Teardown**: Invocations, Success/Failure, Guardrail blocks
5. **DynamoDB**: Read/Write capacity, Throttles, Item count
6. **SNS**: Publish success/failure

### Recommended Alarms
```bash
# Scanner error rate
aws cloudwatch put-metric-alarm \
  --alarm-name "CostJanitor-Scanner-Errors" \
  --metric-name Errors \
  --namespace AWS/Lambda \
  --dimensions Name=FunctionName,Value=cost-janitor-scanner-prod \
  --statistic Sum --period 300 --evaluation-periods 2 \
  --threshold 1 --comparison-operator GreaterThanThreshold \
  --alarm-actions arn:aws:sns:us-east-1:123456789012:alerts

# Approval queue backlog
aws cloudwatch put-metric-alarm \
  --alarm-name "CostJanitor-Approval-Backlog" \
  --metric-name ApprovalsPending \
  --namespace Custom/CostJanitor \
  --statistic Maximum --period 3600 --evaluation-periods 1 \
  --threshold 50 --comparison-operator GreaterThanThreshold
```

---

## Runbook: Manual Scan Trigger
```bash
# Trigger immediate scan
aws events put-events --entries '[{
  "Source": "cost-janitor",
  "DetailType": "ManualScan",
  "Detail": "{\"triggered_by\": \"ops\", \"reason\": \"ad-hoc\"}"
}]'

# Monitor progress
aws logs tail /aws/lambda/cost-janitor-scanner-prod --follow
```

---

## Runbook: Emergency Stop
```bash
# Disable EventBridge rule
aws events disable-rule --name cost-janitor-daily-scan-prod

# Set all findings to REJECTED (prevent teardown)
aws dynamodb scan --table-name cost-janitor-findings-prod \
  --filter-expression "#s IN (:pending, :enrichment)" \
  --expression-attribute-names '{"#s": "status"}' \
  --expression-attribute-values '{":pending": {"S": "PENDING_APPROVAL"}, ":enrichment": {"S": "PENDING_ENRICHMENT"}}' \
  --projection-expression "finding_id" \
  --query 'Items[*].finding_id.S' \
  --output text | tr '\t' '\n' | while read id; do
    aws dynamodb update-item --table-name cost-janitor-findings-prod \
      --key "{\"finding_id\": {\"S\": \"$id\"}}" \
      --update-expression "SET #s = :rejected" \
      --expression-attribute-names '{"#s": "status"}' \
      --expression-attribute-values '{":rejected": {"S": "REJECTED"}}'
  done
```