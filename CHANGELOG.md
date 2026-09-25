# Changelog

All notable changes to Cloud Cost Janitor will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] - 2024-01-15

### Added
- **Infrastructure**: Complete CloudFormation stack with:
  - DynamoDB tables (Findings, Approvals, Config, Prompts) with TTL and GSIs
  - EventBridge daily scheduler (6 AM UTC)
  - Lambda functions (Scanner, Enrichment, Teardown, API)
  - API Gateway with REST endpoints
  - SNS topic for approval notifications
  - S3 + CloudFront for frontend hosting
  - IAM least-privilege roles for all components
- **Scanner Lambda**:
  - Cross-account role assumption with ExternalId
  - EC2 idle detection (CPU <5%, network <1MB, 24h window)
  - EBS orphaned volume detection (unattached >7d, no snapshot >30d)
  - ELB/ALB unused detection (0 requests >7d, no healthy targets)
  - AWS Pricing API integration with fallback rates
  - Auto Scaling Group exclusion
- **Enrichment Lambda**:
  - OpenAI GPT-4o-mini integration
  - TrueFoundry prompt registry (DynamoDB-backed)
  - Structured JSON output with validation
  - Versioned prompts (v1 detailed, v2 concise)
  - Fallback enrichment on API failure
- **Approval System**:
  - DynamoDB-backed approval queue
  - Dual-approval for resources >$100/month
  - 7-day expiration with TTL cleanup
  - SNS email notifications
  - Vote tracking per user
- **Teardown Lambda**:
  - Guardrails: prod tag blocking, cost limits, dual approval
  - Dry-run default with simulation output
  - EBS snapshot before deletion
  - Support for EC2 terminate, EBS delete, ELB/ALB delete
  - Max 10 resources per invocation
- **React Dashboard**:
  - Findings page with status tabs, pagination, cost display
  - Approvals page with vote buttons, AI reasoning display
  - Settings page for config, thresholds, tags, emails
  - Responsive design with CSS variables
- **CI/CD Pipelines**:
  - Backend workflow: package Lambdas, deploy CloudFormation, update code
  - Frontend workflow: build React, sync to S3, invalidate CloudFront
  - GitHub OIDC authentication for AWS
- **Bootstrap Script**:
  - One-time configuration from stack outputs
  - Seeds scan config, prompt registry, guardrails
  - Dry-run mode for safety

### Security
- Cross-account access via ExternalId-protected roles
- Guardrails prevent production resource deletion
- Dual-approval for high-cost resources
- Dry-run by default
- Audit trail via DynamoDB and CloudTrail

### Documentation
- Architecture guide
- API reference
- Deployment guide
- Operations guide
- Development guide
- Security guide
- Troubleshooting guide

---

## [Unreleased]

### Added
- **Frontend**: Application shell with routes for dashboard, insights, findings,
  approvals, docs and settings, plus a 404 page. Each route is wrapped in an
  `ErrorBoundary` so one failing page degrades instead of blanking the app.
- **Frontend**: Design system built on CSS custom properties — token layers for
  colour, spacing, type, radius and elevation, with light and dark as the same
  class names against different tokens.
- **Frontend**: Light, dark and system theming. The preference persists to
  `localStorage` and is applied before first paint by an inline script, so there
  is no flash of the wrong theme.
- **Frontend**: Inline SVG chart library (Sparkline, BarChart, ColumnChart,
  DonutChart, StackedBar, Funnel) and icon set, avoiding a charting dependency.
- **Frontend**: Findings explorer page with a sortable, filterable table, detail
  modal and CSV export.
- **Frontend**: Insights page with cost breakdowns by type, region and account,
  the approval funnel, confidence distribution, risk mix, ageing buckets and
  detection trend.
- **Frontend**: In-app "How it works" documentation with a searchable scroll-spy
  table of contents, pipeline diagram, rule tables and API reference.
- **Frontend**: `src/setupProxy.js` forwards API paths through the dev server, so
  local development needs no CORS configuration.
- **API**: `GET /findings/{finding_id}` for fetching a single finding.
- **API**: CORS headers on every response and `OPTIONS` preflight handling.
- **Tests**: Route smoke tests and API client tests (19 total).

### Changed
- **Frontend**: KPIs are derived client-side from the findings and approvals the
  API already returns, so headline figures cannot disagree with the rows beneath
  them. No separate aggregate endpoint.
- **Frontend**: Approvals read the finding embedded in each approval record rather
  than issuing one request per row, removing an N+1 that scaled with queue size.
- **Infrastructure**: `ALLOWED_ORIGIN` is set to the CloudFront domain, since the
  UI and API are on different origins.

### Fixed
- **API client**: An unset `REACT_APP_API_URL` made every list request return an
  HTML error page, which was parsed as "zero findings". The dashboard rendered
  empty with no error, and votes appeared to succeed while doing nothing. The
  client now detects an HTML body and raises actionable guidance, and no longer
  surfaces a raw HTML page into the UI.
- **Scanner**: EC2 findings were written with `monthly_cost_usd: 0`, never calling
  the instance pricing helper. That zero is the value every ranking, KPI and chart
  is built on.
- **Scanner**: The load balancer rule read `request_count` while its evidence
  recorded `request_count_7d`, so a load balancer with traffic could be reported
  as idle.
- **Enrichment**: Used the removed OpenAI v0.x module-level `openai.api_key`
  against a v1.x pin, which raises on import. Now uses a client instance.
- **Infrastructure**: `PathPart: "{approval_id}/vote"` was never valid — an API
  Gateway path part is a single segment. Split into nested resources.
- **Infrastructure**: Added an explicit `OPTIONS` method per resource; API Gateway
  rejects preflight on a resource that has none.
- **CORS**: The UI is served from CloudFront and the API from API Gateway, but no
  response carried `Access-Control-Allow-Origin` and `OPTIONS` was unhandled, so
  the deployed app could not read anything.
- **KPI layer**: `computeMetrics` read `STATUS.PENDING` for approvals, but
  approvals use a different vocabulary than findings. Pending approvals were being
  counted as decided, so approval rate and turnaround were wrong. Now uses a
  separate `APPROVAL_STATUS` map.
- **KPI layer**: A TDZ self-reference on `approvedMonthly` crashed the dashboard
  and insights pages on every render. The shell's `ErrorBoundary` swallowed it into
  a "something broke" page.
- **Docs**: The scroll-spy took down the whole documentation page where
  `IntersectionObserver` is unavailable. It now degrades to a plain list.
- **Repo**: `.gitignore` had an unanchored `lib/` (a Python virtualenv convention)
  that silently excluded `frontend/src/lib/`, so `format.js`, `metrics.js` and
  `insights.js` were untracked and a fresh clone would not build. Anchored to `/lib/`.

### Planned
- Multi-account support via StackSets
- Slack/Teams notifications
- Cost anomaly detection (ML)
- Resource dependency graph
- Automated remediation (resize vs delete)
- Cognito authentication for dashboard
- Terraform provider
- Kubernetes operator