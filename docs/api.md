# API Reference

## Base URL
```
https://{api-gateway-id}.execute-api.{region}.amazonaws.com/{stage}
```

## Authentication
Currently no authentication. Add API Key or Cognito for production.

## CORS

The UI is served from CloudFront and this API from API Gateway, so every browser
call is cross-origin. All responses therefore carry:

```
Access-Control-Allow-Origin: https://<cloudfront-domain>
Access-Control-Allow-Headers: Content-Type,Authorization,X-Amz-Date,X-Api-Key,X-Amz-Security-Token
Access-Control-Allow-Methods: GET,POST,PUT,DELETE,OPTIONS
Access-Control-Max-Age: 86400
```

`OPTIONS` is answered with `204` before any routing, and every resource in the
CloudFormation template has an explicit `OPTIONS` method — API Gateway rejects
preflight on a resource that has none, so adding a route means adding its `OPTIONS`
method too.

`Access-Control-Allow-Origin` comes from the `ALLOWED_ORIGIN` environment variable
on the API Lambda, set by the template to the CloudFront domain. It defaults to `*`
when the variable is absent, which is convenient locally and too permissive for
production.

Local development does not rely on any of this: `src/setupProxy.js` forwards API
paths through the dev server, so the browser stays same-origin. See
[development.md](development.md#2-configure-the-api-url-required).

## Endpoints

---

### GET /findings

List findings with optional filters.

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | Filter by status: `PENDING_ENRICHMENT`, `PENDING_APPROVAL`, `APPROVED`, `REJECTED`, `TEARDOWN_COMPLETE` |
| `account_id` | string | Filter by account |
| `limit` | integer | Max results (default: 50, max: 100) |
| `last_key` | string | Pagination token (JSON) |

**Response** (200):
```json
{
  "items": [
    {
      "finding_id": "f-ec2-i-12345-20240115",
      "account_id": "123456789012",
      "resource_type": "EC2",
      "resource_id": "i-12345",
      "region": "us-east-1",
      "monthly_cost_usd": 45.67,
      "status": "PENDING_APPROVAL",
      "detected_at": "2024-01-15T06:00:00Z",
      "evidence": { "cpu_avg_24h": 2.1 },
      "tags": { "Environment": "staging" },
      "enrichment": {
        "risk_assessment": "low",
        "recommendation": "delete",
        "confidence": 0.92
      }
    }
  ],
  "last_key": "eyJmaW5kaW5nX2lkIjogImYtZWMyL... (base64 encoded)"
}
```

---

### GET /findings/{finding_id}

Fetch a single finding.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `finding_id` | string | Finding identifier |

**Response** (200): the finding object, same shape as an item from `GET /findings`.

**Response** (404):
```json
{ "error": "Finding not found" }
```

> The approvals endpoint embeds the full finding on each approval record, so the
> dashboard reads it from there rather than calling this per row.

---

### GET /approvals

List approval requests.

**Query Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `status` | string | `PENDING`, `APPROVED`, `REJECTED`, or `all` (default: all) |
| `limit` | integer | Max results (default: 50) |
| `last_key` | string | Pagination token |

**Response** (200):
```json
{
  "items": [
    {
      "approval_id": "appr-f-ec2-i-12345-20240115",
      "finding_id": "f-ec2-i-12345-20240115",
      "status": "PENDING",
      "required_approvals": 2,
      "votes": [
        { "user": "alice@company.com", "decision": "approve", "at": "2024-01-15T10:00:00Z" }
      ],
      "created_at": "2024-01-15T06:05:00Z",
      "expires_at": "2024-01-22T06:05:00Z",
      "finding": { ... }
    }
  ],
  "last_key": "..."
}
```

---

### POST /approvals/{approval_id}/vote

Submit a vote on an approval request.

**Path Parameters**:
| Parameter | Type | Description |
|-----------|------|-------------|
| `approval_id` | string | Approval ID from GET /approvals |

**Request Body**:
```json
{
  "decision": "approve|reject",
  "user": "Alice"
}
```

`user` is required (the dashboard's "Approving as" name). Names are compared case-insensitively, so a
second approval must come from a different name. When the approval becomes `APPROVED` or `REJECTED`,
the finding's status is updated to match.

**Response** (200):
```json
{
  "approval_id": "appr-f-ec2-i-12345-20240115",
  "status": "APPROVED",
  "required_approvals": 2,
  "votes": [
    { "user": "alice@company.com", "decision": "approve", "at": "2024-01-15T10:00:00Z" },
    { "user": "bob@company.com", "decision": "approve", "at": "2024-01-15T11:00:00Z" }
  ]
}
```

**Error Responses**:
- 400: Invalid decision, user already voted, approval not pending
- 404: Approval not found

---

### POST /teardown

Trigger teardown for an approved finding.

**Request Body**:
```json
{
  "approval_id": "appr-f-ec2-i-12345-20240115",
  "dry_run": true
}
```

**Response** (202 - Async):
```json
{
  "message": "Teardown triggered",
  "dry_run": true,
  "job_id": "teardown-3f2a9c1b7d4e"
}
```

Poll `GET /jobs/{job_id}` for the result. A dry run is allowed while the approval is still `PENDING`.

**Teardown Lambda Response** (via CloudWatch Logs):
```json
{
  "success": true,
  "action": "Terminated EC2 instance i-12345",
  "resource_id": "i-12345",
  "dry_run": false
}
```

---

### GET /config

Get current configuration. Guardrails are returned as a nested `guardrails` object.

**Response** (200):
```json
{
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

---

### PUT /config

Update configuration. Fields are merged into what is stored, so partial updates are safe. Guardrail
fields (`dual_approval_threshold_usd`, `max_teardown_cost_usd`, ...) can be sent flat or inside
`guardrails`; they are saved to the `guardrails` row. `scope_tags` limits scans to matching resources.

**Request Body** (all fields optional):
```json
{
  "role_arn": "arn:aws:iam::123456789012:role/CostJanitorScanner",
  "account_id": "123456789012",
  "cpu_threshold_percent": 3.0,
  "cpu_hours": 48,
  "network_idle_bytes": 524288,
  "ebs_unattached_days": 14,
  "ebs_no_snapshot_days": 60,
  "lb_idle_days": 14,
  "excluded_tags": {
    "Environment": ["prod", "production", "staging"],
    "CostJanitor": ["ignore", "do-not-delete", "keep"]
  },
  "notification_emails": ["admin@company.com", "finops@company.com"]
}
```

**Response** (200):
```json
{
  "message": "Config updated"
}
```

---

### POST /scan

Start a scan in the background (same as the daily EventBridge run).

**Response** (202):
```json
{ "message": "Scan started", "job_id": "scan-8a1f0c2d3e4b" }
```

---

### GET /jobs/{job_id}

Status of a scan or teardown job.

**Response** (200):
```json
{
  "job_id": "scan-8a1f0c2d3e4b",
  "kind": "scan",
  "status": "SUCCEEDED",
  "findings_count": 4,
  "idle_resources": 4,
  "monthly_waste_usd": 35.62,
  "by_type": { "EBS": 2, "EC2": 1, "ELB": 1 }
}
```

`status` is `QUEUED`, `RUNNING`, `SUCCEEDED`, `FAILED` or `REFUSED` (teardown guardrail or approval check).
Teardown jobs carry `result` (`action`, or `simulated_actions` for a dry run) or `error` and `details`.

---

### GET /activity

Latest agent tool calls and dashboard actions, newest first (today and yesterday).

| Parameter | Type | Description |
|---|---|---|
| `limit` | integer | Max rows (default 50, max 100) |
| `since` | string | Only rows with `ts` greater than this value |

```json
{
  "items": [
    { "ts": "2026-09-26T08:06:22.93+00:00#a1b2c3", "at": "2026-09-26T08:06:22.93+00:00",
      "tool": "draft_teardown_plan", "actor": "agent", "ok": true,
      "result_summary": "4 items sent for approval, 0 skipped, $35.62/mo" }
  ]
}
```

---

### POST /mcp

MCP endpoint for the TrueForge agent (streamable HTTP, stateless, JSON responses). Requires the
`x-api-key` header; not browser-facing and has no CORS. Tools are listed in `agent/janitor-agent.md`.

---

## Error Format

All errors follow this structure:
```json
{
  "error": "Error message",
  "code": "ERROR_CODE"
}
```

**Common HTTP Status Codes**:
| Code | Description |
|------|-------------|
| 200 | Success |
| 202 | Accepted (async operation) |
| 400 | Bad Request |
| 404 | Not Found |
| 403 | Guardrail violation / Forbidden |
| 500 | Internal Server Error |

---

## Finding Status Flow

```
PENDING_ENRICHMENT → PENDING_APPROVAL → APPROVED → TEARDOWN_COMPLETE
                        ↓
                      REJECTED
                        ↓
                      EXPIRED (after 7 days)
```

---

## Guardrail Rules (Enforced in Teardown)

| Rule | Threshold | Action |
|------|-----------|--------|
| Production tag | `Environment=prod\|production` | Block |
| CostJanitor tag | `CostJanitor=protect\|do-not-delete\|keep` | Block |
| Auto-approve | Cost ≤ $100/mo | 1 approval |
| Dual approval | Cost > $100/mo | 2 approvals |
| Max cost | Cost > $1000/mo | Block entirely |
| Dry-run default | All teardowns | Simulate first |
| EBS snapshot | Before delete | Required |
| Max resources | Per invocation | 10 |

---

## Example Workflows

### 1. Full Approval Flow
```bash
# 1. List pending approvals
curl https://api.example.com/prod/approvals

# 2. Vote approve
curl -X POST https://api.example.com/prod/approvals/appr-abc/vote \
  -H "Content-Type: application/json" \
  -d '{"decision": "approve", "user": "alice@company.com"}'

# 3. Second approver votes
curl -X POST https://api.example.com/prod/approvals/appr-abc/vote \
  -H "Content-Type: application/json" \
  -d '{"decision": "approve", "user": "bob@company.com"}'

# 4. Trigger teardown (dry-run first)
curl -X POST https://api.example.com/prod/teardown \
  -H "Content-Type: application/json" \
  -d '{"approval_id": "appr-abc", "dry_run": true}'

# 5. Execute real teardown
curl -X POST https://api.example.com/prod/teardown \
  -H "Content-Type: application/json" \
  -d '{"approval_id": "appr-abc", "dry_run": false}'
```

### 2. Update Scan Thresholds
```bash
curl -X PUT https://api.example.com/prod/config \
  -H "Content-Type: application/json" \
  -d '{
    "cpu_threshold_percent": 3.0,
    "ebs_unattached_days": 14,
    "notification_emails": ["admin@company.com", "finops@company.com"]
  }'
```

### 3. Pagination
```bash
# First page
curl "https://api.example.com/prod/findings?limit=20&status=PENDING_APPROVAL"

# Subsequent pages (use last_key from previous response)
curl "https://api.example.com/prod/findings?limit=20&status=PENDING_APPROVAL&last_key=eyJmaW5kaW5nX2lkIj..."
```