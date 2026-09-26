# Cost Janitor: Operational Plan

Goal: a TrueForge agent that finds idle EC2 instances, orphaned EBS volumes and idle load balancers on AWS, prices them, drafts a teardown plan, and deletes only what a person approved in the dashboard. A push to `master` deploys the whole platform (backend, API, MCP endpoint, dashboard). Demo resources live in a separate stack that is created only on request.

Architecture reference: https://claude.ai/artifact/KWkzcJiXVidCLPbsF8c8K6

## How to read this file

- `- [ ]` open, `- [x] ~~task~~` done. Tasks are struck off as they are executed.
- **Owner**: `[claude]` = done in this repo by Claude. `[you]` = needs a person (AWS console, GitHub settings, TrueForge UI, a decision).
- Every task has a **Done when** check where it isn't obvious. A task is not done until that check passes.
- Work happens on branch `feat/agent-mcp`, merged to `master` by PR. Nothing is pushed and nothing touches AWS without explicit approval.

## Status

| Phase | Title | Owner | State |
|---|---|---|---|
| 0 | Decisions and prerequisites | you | Open |
| 1 | Data layer fixes (blockers) | claude | Done |
| 2 | Detection and pricing fixes | claude | Done |
| 3 | Teardown hardening | claude | Done |
| 4 | MCP server | claude | Done |
| 5 | Platform stack (CloudFormation) | claude | Done (lint clean; not yet deployed) |
| 6 | API and CORS | claude | Done |
| 7 | Dashboard: everything visible in the UI | claude | Done (browser-verified on local stack) |
| 8 | GitHub Actions | claude | Done (not yet run on GitHub) |
| 9 | Demo stack (on request only) | claude | Done (not yet deployed) |
| 10 | TrueForge agent (local) | claude + you | Prompt ready; TrueForge setup open |
| 11 | First deploy and end-to-end check | you + claude | Open |
| 12 | Rehearsal, demo, cleanup | you | Open |

Phases 1–3, 4 and 7 can run in parallel (different files). 5 depends on 4. 8 depends on 5. 10 can start once 4 runs locally.

---

## Budget: $20 total

Everything below is us-east-1 list price. The platform stack is almost free; the only real spend is the demo stack while it exists.

### Platform stack (always on after push)

| Item | Usage during the hackathon | Est. cost |
|---|---|---|
| Lambda (5 functions) | a few thousand invocations | $0.00 (free tier) |
| DynamoDB on-demand (6 tables) | < 100k requests, < 1 GB | < $0.10 |
| API Gateway REST | < 100k requests at $3.50/M | < $0.35 |
| S3 + CloudFront | ~5 MB site, a few hundred loads | < $0.10 |
| CloudWatch Logs | 7-day retention (set in 5.14) | < $0.10 |
| SNS, EventBridge, Pricing API, API key | | $0.00 |
| **Total** | | **< $1 for the month** |

Not used, to save money: NAT gateways, VPC Lambdas, Secrets Manager ($0.40/secret/month), KMS customer keys, WAF.

### Demo stack (only while created)

| Resource | Why | Rate | Per hour |
|---|---|---|---|
| `demo-forgotten-dev-box` t3.micro, 8 GiB gp3 root | idle → flagged | $0.0104/hr + $0.64/mo | $0.0113 |
| `demo-busy-api` t3.micro, 8 GiB gp3 root, standard credits | busy → not flagged | same | $0.0113 |
| `demo-orphan-data` gp3 20 GiB | flagged | $0.08/GB-mo | $0.0022 |
| `demo-old-backup-disk` gp2 100 GiB | flagged | $0.10/GB-mo | $0.0137 |
| `demo-prod-db-disk` gp3 5 GiB, `Environment=prod` | protected → not flagged | $0.08/GB-mo | $0.0005 |
| `demo-legacy-alb` internal ALB, empty target group | flagged | $0.0225/hr | $0.0225 |
| Public IPv4 | none: instances get no public IP, ALB is internal | $0.005/hr each | $0.0000 |
| **Total** | | | **≈ $0.062/hr ≈ $1.49/day** |

Cost scenarios: demo day with one rehearsal (8 hours total) ≈ **$0.50**. Forgotten for a week ≈ $10.40, which is why the auto-delete in 9.4 exists.

What the agent reports as waste: $7.59 + $1.60 + $10.00 + $16.43 = **$35.62/mo** ($427.44/yr).

Dual approval without a big volume: the demo profile sets `dual_approval_threshold_usd` to 10, so the $16.43 ALB needs two approvers. The earlier 1,100 GiB volume idea ($0.15/hr, $25 if forgotten a week) is dropped.

### Budget guards

- [x] ~~**B.1** `[claude]` `AWS::Budgets::Budget` in the one-time `github-oidc.yaml` stack: $20 monthly cost budget, email alerts at 25%, 50%, 80% actual and 100% forecast. (First two budgets per account are free.)~~
- [x] ~~**B.2** `[claude]` Demo stack auto-delete: scheduled workflow deletes `janitor-demo` once it is older than `DEMO_TTL_HOURS` (default 8). See 9.4.~~ _(hourly schedule in demo-resources.yml; TTL capped at 24h)_
- [x] ~~**B.3** `[claude]` Every demo resource tagged `CostJanitor=demo` and `Project=janitor-demo` so Cost Explorer can filter it. `[you]` activate both as cost allocation tags in Billing.~~ _(tags in place; activating them in Billing is still [you])_
- [x] ~~**B.4** `[claude]` Teardown snapshots tagged `CostJanitor=pre-delete`; `scripts/demo_cleanup.py` removes them after the demo. Snapshots of mostly empty volumes cost cents.~~ _(scripts/demo_cleanup.py)_

---

## Phase 0: Decisions and prerequisites `[you]`

- [ ] **0.1** Pick a sandbox AWS account with no real workloads. Keep the account id out of git.
  Done when: `aws sts get-caller-identity` works with admin credentials.
- [ ] **0.2** Confirm region `us-east-1`.
- [ ] **0.3** Confirm push access to `github.com/jainvpranav/cloud-cost-janitor` and that Actions are enabled.
- [ ] **0.4** Pick the TrueForge model provider and have its key ready (stored in TrueForge only).
- [ ] **0.5** Pick a globally unique frontend bucket name, e.g. `cost-janitor-frontend-<team>-<random>`.
- [ ] **0.6** Pick the budget alert email (goes into the one-time stack as a parameter, not into git).
- [ ] **0.7** Presenter laptop runs TrueForge on Node 22 (`/opt/homebrew/opt/node@22/bin`).
- [ ] **0.8** Two people available to approve the dual-approval item on stage.

---

## Phase 1: Data layer fixes (blockers) `[claude]`

Without these, no finding is ever saved and the dashboard stays empty.

- [x] ~~**1.1** `backend/common/ddb.py`:~~
  - `to_ddb(obj)` → `json.loads(json.dumps(obj, default=str), parse_float=Decimal)`
  - `DecimalEncoder` → Decimal to `int` when integral, else `float`
  Done when: unit test round-trips nested floats with none left.
- [x] ~~**1.2** Use `to_ddb` in every `put_item`/`update_item` value: scanner `save_finding` (~line 174), teardown `save_finding`, enrichment `save_finding` and `create_approval`, api `vote_approval` and `update_config`.~~
  Done when: moto test writes a finding with float cost and reads it back.
- [x] ~~**1.3** Every `json.dumps` response body in `api.py` uses `cls=DecimalEncoder` (fixes the 500 on vote at line 165; numbers come back as numbers).~~
- [x] ~~**1.4** Test harness: `backend/requirements-dev.txt` (`pytest`, `moto[dynamodb,ec2,elbv2,cloudwatch,lambda]`, `boto3`), `backend/tests/conftest.py` creating all tables with the template's key schema and GSIs.~~ _(45 tests pass)_
  Done when: `pytest backend/tests -q` passes.

- [x] ~~**1.5** Scanner crashed on every run: `get_scan_config` passed `role_arn`/`account_id` to `ScanConfig`, which had no such fields~~ _(found during execution; fields added)_
---

## Phase 2: Detection and pricing fixes `[claude]`

- [x] ~~**2.1** LB tags: `get_load_balancers` calls `describe_tags` in batches of 20 and attaches `Tags`.~~
  Done when: moto test with an `Environment=prod` ALB yields no finding.
- [x] ~~**2.2** LB CloudWatch dimension: `lb_arn.split(":loadbalancer/")[1]`; `AWS/NetworkELB` + `NewFlowCount` for `net/` LBs.~~
- [x] ~~**2.3** No data is not idle: skip instances with fewer datapoints than `max(1, cpu_hours*3600/period/2)`. Period 300s when `cpu_hours <= 3`, else 3600s.~~
- [x] ~~**2.4** `ScanConfig.scope_tags` (default `{}`): when set, only matching resources are scanned.~~
- [x] ~~**2.5** Remove the stray `boto3.Session().client("cloudwatch")` in `get_instance_metrics`.~~
- [x] ~~**2.6** Pricing tables on a 730-hour month (m5.large 70.08, c5.large 62.05, r5.large 91.98, …); sc1 0.015; Gateway LB 9.13.~~
- [x] ~~**2.7** Live EC2 price via `get_pricing()` (hourly × 730, cached per scan, client pinned to `us-east-1`), then table, then 50.0. Each finding gets `price_source` = `pricing_api` | `table` | `default`.~~ _(EC2 live price in scanner via AWSClient.get_ec2_monthly_price)_
- [x] ~~**2.8** Scanner calls enrichment only when `ENRICHMENT_ENABLED=true` (default false). New findings stay `PENDING_ENRICHMENT` until a plan is drafted.~~
- [x] ~~**2.9** Scanner updates a job record (`JobsTable`) when invoked with `job_id`: `RUNNING` → `SUCCEEDED`/`FAILED`, `findings_count`.~~
- [x] ~~**2.10** Re-scan does not duplicate: skip resources that already have an open finding (same `resource_id`, status not `TEARDOWN_COMPLETE`/`REJECTED`), so running a scan twice on stage doesn't double the numbers.~~

---

## Phase 3: Teardown hardening `[claude]`

- [x] ~~**3.1** Guardrails read from the `guardrails` config row, overlaying the constants.~~
- [x] ~~**3.2** Idempotency: conditional update to `TEARDOWN_IN_PROGRESS`; refuse if already in progress or complete.~~
- [x] ~~**3.3** Still-idle re-check with live data before a real delete; if it no longer qualifies, mark `SKIPPED_NOW_ACTIVE`.~~
- [x] ~~**3.4** Guardrail tag check uses live tags, not scan-time tags.~~
- [x] ~~**3.5** Clients built via `AWSClient(role_arn, external_id)` like the scanner; empty `role_arn` = Lambda role.~~
- [x] ~~**3.6** EBS snapshot tagged `CostJanitor=pre-delete`, `SourceVolume=<id>`; waiter `Delay=10, MaxAttempts=80`.~~
- [x] ~~**3.7** Result recorded on the job and the finding (`teardown_result`, `teardown_at`, `realized_monthly_savings_usd`).~~
- [x] ~~**3.8** Dry run lists volumes an EC2 termination would leave behind.~~
- [x] ~~**3.9** Tests: not APPROVED → 400; prod tag → 403; over threshold with one vote → 403; > $1000 → 403; happy path for EC2, EBS, ALB; resource became active → 409.~~ _(plus missing-resource case → RESOURCE_GONE)_

---

## Phase 4: MCP server `[claude]`

One codebase: uvicorn locally, Mangum on Lambda.

- [x] ~~**4.1** `backend/mcp/server.py` (`FastMCP("cost-janitor", stateless_http=True, json_response=True)`), `lambda_function.py` (`Mangum(app)`), pinned `requirements.txt` (`mcp`, `mangum`, `boto3`).~~ _(folder is backend/mcp_server/ because backend/mcp/ shadows the SDK package; SDK 2.x MCPServer; fresh app per Lambda invocation)_
- [x] ~~**4.2** Env-only config: table names, `SCANNER_FUNCTION`, `TEARDOWN_FUNCTION`, `ENVIRONMENT`.~~
- [x] ~~**4.3** Every tool call writes an activity row `{run_id, ts, tool, args_summary, result_summary, ok}` (7-day TTL).~~ _(activity table keyed by day + ts)_
- [x] ~~**4.4** Tools: `run_scan`, `get_job_status`, `list_idle_instances`, `list_orphaned_volumes`, `list_idle_load_balancers`, `get_cost_summary`, `record_assessment`, `draft_teardown_plan`, `get_approval_status`, `execute_teardown`. Docstrings written for the model.~~
- [x] ~~**4.5** No tool can vote or change an approval. `execute_teardown` refuses unless `APPROVED`.~~
- [x] ~~**4.6** `draft_teardown_plan` sets `required_approvals` from the live guardrail threshold (so the demo profile's $10 threshold applies).~~
- [x] ~~**4.7** Tests: exact tool list; refusal on PENDING with no Lambda invoke; one activity row per call.~~ _(includes a protocol-level call through the Lambda handler)_
- [x] ~~**4.8** Local run with `uvicorn`, verified with MCP Inspector.~~ _(verified with curl: initialize + tools/list; run via backend/mcp_server/local.py)_

---

## Phase 5: Platform stack (CloudFormation) `[claude]`

File: `infrastructure/template.yaml`.

- [x] ~~**5.0** `ApiRole` trusted `apigateway.amazonaws.com` but is the API Lambda's execution role; first deploy would fail with "cannot be assumed by Lambda"~~ _(found during execution; now trusts lambda.amazonaws.com and has log permissions)_
- [x] ~~**5.1** Parameters: `OpenAIApiKey` `Default: ''`; `EnrichmentEnabled` (default `false`); `TeardownScopeTagValue` (default `demo`, empty disables the tag condition).~~
- [x] ~~**5.2** Tables: `ActivityTable` (pk `run_id`, sk `ts`, TTL), `JobsTable` (pk `job_id`, TTL). On-demand, SSE on.~~ _(Activity keyed by day + ts)_
- [x] ~~**5.3** `McpRole` + `McpFunction` (python3.11, 512 MB, 25s).~~
- [x] ~~**5.4** Routes: `/mcp` `ANY` with `ApiKeyRequired: true`; `/activity` `GET`; `/jobs/{job_id}` `GET`; `/scan` `POST`. Each browser-facing route also gets `OPTIONS`.~~ _(/mcp is ANY so the SDK can answer GET/DELETE itself)_
- [x] ~~**5.5** `ApiKey`, `UsagePlan` (20 rps, burst 40, 10k/day quota), `UsagePlanKey`.~~
- [x] ~~**5.6** **First-deploy fix:** `ApiDeployment` currently depends only on resources, not methods. On a fresh account CloudFormation can create the deployment before any method exists and fail with "The REST API doesn't contain any methods". Add every method to `DependsOn`.~~
- [x] ~~**5.7** **Redeploy fix:** the deployment resource never changes, so new routes never go live on update. Split into `AWS::ApiGateway::Deployment` (logical id suffixed with a version, e.g. `ApiDeploymentV2`) + explicit `AWS::ApiGateway::Stage`, and bump the suffix whenever routes change.~~ _(explicit Stage + CI runs create-deployment on every push instead of renaming the resource)_
- [x] ~~**5.8** **CORS on gateway errors:** add `AWS::ApiGateway::GatewayResponse` for `DEFAULT_4XX` and `DEFAULT_5XX` with `Access-Control-Allow-Origin` (CloudFront URL), `-Headers`, `-Methods`. Without this, throttling (429), a crashed or timed-out Lambda (502/504) and unknown routes (403) reach the browser with no CORS header and the UI shows "Cannot reach the API" instead of the real error.~~
- [x] ~~**5.9** `TeardownRole`: add `dynamodb:PutItem`, `ec2:DescribeSnapshots`, `ec2:DescribeVolumes`, `ec2:DescribeInstances`, `ec2:CreateTags`, ELB describe actions, `cloudwatch:GetMetricStatistics`, Config/Jobs table access. Delete actions conditioned on `aws:ResourceTag/CostJanitor` when `TeardownScopeTagValue` is set. Remove invalid `elasticloadbalancingv2:*`.~~
- [x] ~~**5.10** `TeardownFunction` timeout 900; env `CONFIG_TABLE`, `JOBS_TABLE`.~~
- [x] ~~**5.11** `ScannerRole`: `elasticloadbalancing:DescribeTags`, Jobs table write. Scanner env `JOBS_TABLE`, `ENRICHMENT_ENABLED`.~~
- [x] ~~**5.12** `ApiRole`: read Activity/Jobs; `lambda:InvokeFunction` on Scanner (for `POST /scan`) and Teardown. Env vars for both tables and `SCANNER_FUNCTION`.~~
- [x] ~~**5.13** `DailyScanRule` stays, but the scanner passes a `job_id` of `scheduled-<date>`.~~
- [x] ~~**5.14** `AWS::Logs::LogGroup` per function with `RetentionInDays: 7`.~~
- [x] ~~**5.15** Outputs: `ApiId`, `ApiEndpoint`, `McpEndpoint`, `McpApiKeyId`, `FrontendUrl`, `FrontendBucketName`, `CloudFrontDistributionId`, all table names. Fix the truncated `ConfigTableName` output.~~
- [x] ~~**5.16** `infrastructure/github-oidc.yaml` (one-time): GitHub OIDC provider, `ArtifactsBucket` (private, versioned, 30-day expiry), `GitHubDeployRole` trusted for `repo:jainvpranav/cloud-cost-janitor:ref:refs/heads/master` and `:environment:prod`, `$20` budget (B.1). Outputs `DeployRoleArn`, `ArtifactsBucketName`.~~ _(parameter for an existing OIDC provider (only one allowed per account))_
- [x] ~~**5.17** Deploy role permissions limited to the services the stacks use: CloudFormation, IAM (roles prefixed `cost-janitor-*`), Lambda, API Gateway, DynamoDB, S3, CloudFront, SNS, EventBridge, Logs, and EC2/ELB create-delete for the demo stack.~~ _(frontend bucket name must start with cost-janitor-)_
- [x] ~~**5.18** `cfn-lint` clean on all templates; `aws cloudformation validate-template` passes.~~ _(cfn-lint clean on all three templates; validate-template needs AWS credentials, runs in CI)_

---

## Phase 6: API and CORS `[claude]`

### Current CORS state

| Path | State |
|---|---|
| Successful responses and route errors from the API Lambda | OK: `CORS_HEADERS` added in `handler` |
| `OPTIONS` preflight | OK: Lambda answers 204; every resource has an `OPTIONS` method |
| Origin | OK: `ALLOWED_ORIGIN` = CloudFront URL from the template |
| Local dev | OK: `setupProxy.js` keeps the browser same-origin |
| Errors generated by API Gateway (403, 429, 502, 504) | **Missing**: fixed in 5.8 |
| Bad JSON body | **Missing**: `json.loads` runs outside `try`, Lambda crashes, 502 without CORS. Fixed in 6.2 |
| New routes `/activity`, `/jobs`, `/scan` | **Missing**: added in 5.4 with `OPTIONS`, proxied in 7.6 |
| `/mcp` | Not browser-facing; no CORS needed. API key required |

- [x] ~~**6.1** `ALLOWED_ORIGIN` accepts a comma-separated list; handler echoes the request `Origin` when it's in the list. Template sets CloudFront URL plus `http://localhost:3000` so a production build can be tested locally.~~
- [x] ~~**6.2** Move body parsing inside `try`; invalid JSON → 400 with CORS headers.~~
- [x] ~~**6.3** `GET /approvals` with no `status` or `status=all` returns every status (today it silently returns only `PENDING`, so the Dashboard and Insights approval funnel never shows approved or rejected items).~~
- [x] ~~**6.4** `POST /scan` → invokes Scanner async with a new `job_id`; returns 202 `{job_id}`.~~
- [x] ~~**6.5** `POST /teardown` returns 202 `{job_id}`; `GET /jobs/{job_id}` returns status and result.~~
- [x] ~~**6.6** `GET /activity?since=<iso>&limit=50`.~~
- [x] ~~**6.7** `GET /config` also returns the `guardrails` row; `PUT /config` writes scan fields to `scan_config` and guardrail fields to `guardrails` (check which fields `Settings.jsx` sends).~~ _(GET returns guardrails as a nested object; PUT merges instead of overwriting)_
- [x] ~~**6.8** `limit` capped at 500 on list routes.~~
- [x] ~~**6.9** Tests for every route, including OPTIONS and an error path, asserting CORS headers are present.~~

---

## Phase 7: Dashboard: everything visible in the UI `[claude]`

### UI coverage

| Capability | API | Page | State |
|---|---|---|---|
| Findings list, filters, CSV | `GET /findings` | Findings | Exists |
| KPIs, insights, reclaimed savings | `GET /findings`, `GET /approvals` | Dashboard, Insights | Exists; approvals fixed by 6.3 |
| Vote | `POST /approvals/{id}/vote` | Approvals, Dashboard | Exists; **broken for 2nd approver** (7.1) |
| Dry run / execute teardown | `POST /teardown` | Approvals | Exists; add job status (7.4) |
| Thresholds and guardrails | `GET/PUT /config` | Settings | Exists; guardrails saving fixed by 6.7 |
| Run a scan without the agent | `POST /scan` | Dashboard | **New** (7.3) |
| Live agent activity | `GET /activity` | Dashboard | **New** (7.2) |
| Scan / teardown progress | `GET /jobs/{id}` | Dashboard, Approvals | **New** (7.3, 7.4) |
| Price source, agent assessment | finding fields | Finding card | **New** (7.5) |
| Demo mode indicator | `GET /config` (`scope_tags`) | Layout top bar | **New** (7.7) |

- [x] ~~**7.1** Approver identity: `CURRENT_USER` is the constant `'current-user'` (`hooks/useApi.js:154`), so every browser votes as the same user and the API rejects the second approval as "User already voted". Dual approval can never complete. Replace with an "Approving as" name field in the top bar, kept in `localStorage` (wrapped in try/catch), required before voting. Used in Approvals and Dashboard.~~
- [x] ~~**7.2** `components/ActivityFeed.jsx` on the Dashboard: tool name, short result, relative time, red for refusals. Polls every 3s.~~
- [x] ~~**7.3** "Run scan" button on the Dashboard → `POST /scan`, shows job progress, refreshes findings on success.~~
- [x] ~~**7.4** Approvals: after dry run or execute, poll `GET /jobs/{id}` and show the result inline.~~
- [x] ~~**7.5** Finding card shows `price_source` badge and the agent's assessment (risk, recommendation, confidence, reasoning).~~ _(assessment panel already existed; added price-source badge)_
- [x] ~~**7.6** `setupProxy.js` also proxies `/activity`, `/jobs`, `/scan`.~~
- [x] ~~**7.7** Top-bar chip "Demo mode" when `scope_tags` is set.~~
- [x] ~~**7.8** `useApi.js` gets `pollMs` (3000 on Dashboard, Approvals, Findings), paused when `document.hidden`.~~
- [x] ~~**7.9** Status labels for `TEARDOWN_IN_PROGRESS` and `SKIPPED_NOW_ACTIVE` in `lib/metrics.js`.~~ _(plus RESOURCE_GONE)_
- [x] ~~**7.10** Tests: ActivityFeed, approver name gate, route smoke tests still pass.~~ _(22 frontend tests pass)_
- [x] ~~**7.11** Browser check: `npm start` against the deployed API; click every page; approve with two different names; no console errors, no CORS errors.~~ _(verified in the browser against scripts/local_stack.py: scan, plan, name gate, Alice+Bob dual approval, dry run, execute, reclaimed $35.62; no console errors)_

- [x] ~~**7.12** Dev proxy crashed on start (`app.use` got the extra paths as middleware) and, once fixed, returned API JSON on page reloads of `/approvals` and `/findings`~~ _(found during browser testing; now a path filter that skips page navigations)_
- [x] ~~**7.13** Every percentage rendered 100× too small (`pct()` expected 0–100, callers pass 0–1); confidence bar nearly empty at 90%~~ _(found during browser testing)_
- [x] ~~**7.14** "Needs two sign-offs" hint hardcoded $100 while the threshold is configurable~~ _(reads the guardrail)_
- [x] ~~**7.15** `scripts/local_stack.py`: whole backend against a simulated AWS account for UI testing and local TrueForge work~~
---

## Phase 8: GitHub Actions `[claude]`

### Problems in the current workflows

| # | Problem | Effect |
|---|---|---|
| W1 | Triggers on `main`; branch is `master` | Push never deploys |
| W2 | Frontend needs `API_GATEWAY_ID`, `CLOUDFRONT_DISTRIBUTION_ID` secrets | Don't exist before first deploy; go stale |
| W3 | Backend and frontend run independently | Frontend can deploy before the stack exists |
| W4 | No tests or lint before deploy | Broken code reaches AWS |
| W5 | `OPENAI_API_KEY` required | Deploy fails without it |
| W6 | Teardown zip lacks `aws_client.py`/`rules.py`; nothing packages `common/` or `mcp/` | Import errors at runtime |
| W7 | `update-function-code` without waiting | Occasional `ResourceConflictException` |
| W8 | `index.html` uploaded with `max-age=31536000, immutable` | Browsers keep the old app for a year after a redeploy; CloudFront invalidation doesn't clear browser caches |
| W9 | No PR checks | Problems found after merge |

- [x] ~~**8.1** `.github/workflows/ci.yml` (pull requests, pushes to non-master branches): `pytest`, `cfn-lint`, frontend `npm ci`, `npm test -- --watchAll=false`, `npm run build`.~~
- [x] ~~**8.2** Replace `backend.yml` and `frontend.yml` with `.github/workflows/deploy.yml`:~~
  - on push to `master` and `workflow_dispatch`; `concurrency: deploy-prod`; `environment: prod`
  - `test` job (same as CI)
  - `backend` job: `scripts/package_lambdas.sh` → upload 5 zips → deploy stack → `update-function-code` + `aws lambda wait function-updated-v2` per function → seed prompts only if enrichment is on
  - `frontend` job (needs backend): read `ApiEndpoint`, `FrontendBucketName`, `CloudFrontDistributionId` from stack outputs; build; sync `static/` with `max-age=31536000, immutable`; upload `index.html`, `manifest.json`, `asset-manifest.json` with `no-cache`; invalidate `/index.html`
  - final step prints `FrontendUrl`, `ApiEndpoint`, `McpEndpoint` in the job summary
- [x] ~~**8.3** `scripts/package_lambdas.sh`: `dist/{scanner,enrichment,teardown,api,mcp}.zip`; copies `common/` into all, scanner modules into teardown and mcp; `pip install --platform manylinux2014_x86_64 --only-binary=:all: --python-version 3.11`.~~
- [x] ~~**8.4** `.github/workflows/demo-resources.yml`: see 9.3 and 9.4.~~
- [x] ~~**8.5** Update `README.md` and `docs/deployment.md` with the secrets table below and the one-time setup.~~

### What happens on push to `master`

Once Phase 11.1–11.2 (one-time) is done, a push runs test → backend → frontend and the platform is fully up: API, MCP endpoint, dashboard, daily scan. It does **not** create demo resources.

### Secrets and variables

GitHub → Settings → Secrets and variables → Actions, scoped to the `prod` environment.

| Name | Kind | Required | Source |
|---|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Secret | Yes | `DeployRoleArn` output of `github-oidc` stack |
| `NOTIFICATION_EMAIL` | Secret | Yes | Team email for SNS notices |
| `OPENAI_API_KEY` | Secret | No | Only if `EnrichmentEnabled=true` |
| `ARTIFACTS_BUCKET` | Variable | Yes | `ArtifactsBucketName` output of `github-oidc` stack |
| `FRONTEND_BUCKET_NAME` | Variable | Yes | Name from 0.5 |
| `AWS_REGION` | Variable | No | Defaults to `us-east-1` |
| `DEMO_TTL_HOURS` | Variable | No | Defaults to `8` |

Removed: `API_GATEWAY_ID`, `CLOUDFRONT_DISTRIBUTION_ID`, `FRONTEND_BUCKET`.

Not in GitHub: the MCP API key. After deploy: `aws apigateway get-api-key --api-key <McpApiKeyId> --include-value`, paste into TrueForge's secret store only.

---

## Phase 9: Demo stack (on request only) `[claude]`

Separate stack `janitor-demo`. Never created by a push.

- [x] ~~**9.1** `infrastructure/demo/idle-resources.yaml`. Params: `VpcId`, `SubnetA`, `SubnetB`, `AmiId` (default SSM `/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64`), `ExpiresAt`. Resources as in the Budget table:~~
  - instances with `AssociatePublicIpAddress: false`, 8 GiB gp3 root, `DeleteOnTermination: true`, IMDSv2 required
  - busy box: `CreditSpecification: standard`, user data starts one busy-loop process (≈ 50% CPU on 2 vCPU)
  - ALB `Scheme: internal`, security group with no inbound rules, empty target group, no listener
  - all tagged `CostJanitor=demo`, `Project=janitor-demo`, `ExpiresAt=<iso>`
- [x] ~~**9.2** Outputs list every resource id and the expected findings.~~
- [x] ~~**9.3** `demo-resources.yml`, `workflow_dispatch` only, input `action: create | delete`. `create` looks up the default VPC and two subnets in different AZs, deploys with `ExpiresAt = now + DEMO_TTL_HOURS`. `delete` deletes the stack and waits.~~
- [x] ~~**9.4** Same workflow, `schedule: '17 * * * *'`: if `janitor-demo` exists and its `ExpiresAt` has passed, delete it. Idempotent when the stack is absent.~~
- [x] ~~**9.5** `scripts/demo_profile.py apply|restore`: `PUT /config` with `cpu_hours:1`, `network_idle_bytes:52428800`, `ebs_unattached_days:0`, `lb_idle_days:0`, `scope_tags:{CostJanitor:[demo]}`, `dual_approval_threshold_usd:10`; `restore` puts production values back.~~ _(also has a show action)_
- [x] ~~**9.6** `scripts/demo_reset.py --yes`: clears findings, approvals, activity and jobs.~~
- [x] ~~**9.7** `scripts/demo_cleanup.py`: lists snapshots tagged `CostJanitor=pre-delete`, deletes after confirmation.~~
- [x] ~~**9.8** Expected result in `docs/operations.md`: 4 findings, $35.62/mo; busy box and prod disk not flagged; ALB needs 2 approvals.~~

---

## Phase 10: TrueForge agent (local) `[claude + you]`

- [ ] **10.1** `[you]` Add the model provider in TrueForge (`http://localhost:8790`).
- [x] ~~**10.2** `[claude]` `agent/janitor-agent.md`: system prompt, tool rules, stop-for-approval behavior, output format.~~ _(agent/janitor-agent.md)_
- [ ] **10.3** `[claude + you]` Register the MCP server: local `http://localhost:8000/mcp`; cloud `McpEndpoint` with header `x-api-key`. If TrueForge can't send headers, switch `/mcp` to a Lambda authorizer with a bearer token.
- [ ] **10.4** `[claude + you]` Create the "cost-janitor" agent. Turn on per-tool approval for `execute_teardown` if TrueForge supports it.
- [ ] **10.5** Scripted checks: finds 4 items and $35.62; refuses to delete before approval; deletes after approval. _(all three verified by calling the MCP tools against scripts/local_stack.py; still to run through TrueForge itself)_
- [ ] **10.6** Save the final prompt and any TrueForge export in `agent/`.

---

## Phase 11: First deploy and end-to-end check `[you + claude]`

- [ ] **11.1** `[you]` One-time: `aws cloudformation deploy --stack-name cost-janitor-github-oidc --template-file infrastructure/github-oidc.yaml --capabilities CAPABILITY_NAMED_IAM --parameter-overrides BudgetEmail=<email>`
- [ ] **11.2** `[you]` Set the secrets and variables; create the `prod` environment in GitHub.
- [ ] **11.3** `[you]` Approve the push of `feat/agent-mcp`; PR; `ci.yml` green.
- [ ] **11.4** `[you]` Merge to `master`; `deploy.yml` green (first run takes ~10–15 min because CloudFront is created).
- [ ] **11.5** `[claude]` Smoke and CORS checks:
  - `curl -i <ApiEndpoint>/findings` → 200, JSON, `Access-Control-Allow-Origin: <FrontendUrl>`
  - `curl -i -X OPTIONS <ApiEndpoint>/approvals/x/vote -H "Origin: <FrontendUrl>" -H "Access-Control-Request-Method: POST"` → 204 with CORS headers
  - `curl -i <ApiEndpoint>/nope -H "Origin: <FrontendUrl>"` → 403 **with** CORS headers (gateway response)
  - `curl -i -X POST <ApiEndpoint>/config -d 'not json' -H "Origin: <FrontendUrl>"` → 400 with CORS headers
  - `/mcp` without key → 403; with key → `tools/list` returns 10 tools
  - `FrontendUrl` loads every page with no console or CORS errors
- [ ] **11.6** `[you]` `bootstrap.py` with empty role ARN (single account).
- [ ] **11.7** `[you]` Run `demo-resources` → `create`. Wait 60+ minutes for CPU metrics.
- [ ] **11.8** `[claude]` `demo_profile.py apply`; scan via MCP; confirm 4 findings, $35.62.
- [ ] **11.9** Full loop: plan → approve (ALB with two names) → execute → Reclaimed on dashboard → EC2 console shows dev box terminating.
- [ ] **11.10** `demo-resources` → `delete`, then `create` again before the real demo; `demo_reset.py`.

---

## Phase 12: Rehearsal, demo, cleanup `[you]`

- [ ] **12.1** T−2h: platform healthy; TrueForge pointed at cloud MCP.
- [ ] **12.2** T−90m: `demo-resources` → `create`.
- [ ] **12.3** T−30m: rehearsal; record a clean run as backup.
- [ ] **12.4** T−10m: recreate anything rehearsal deleted; `demo_reset.py`.
- [ ] **12.5** Demo (run of show in the architecture doc, with $35.62 as the total).
- [ ] **12.6** After: `demo-resources` → `delete`; `demo_cleanup.py`; `demo_profile.py restore`. Check Cost Explorer next day.

---

## Risks

| Risk | Mitigation |
|---|---|
| Demo stack forgotten | Auto-delete after `DEMO_TTL_HOURS`; budget alerts at $5/$10/$16 |
| TrueForge can't send an API key header | Lambda authorizer with bearer token |
| Agent improvises on stage | MCP Inspector or the dashboard "Run scan" and Approvals buttons do the same thing |
| New instance downloads > 50 MB at boot | No public IP means little boot traffic; create stack ≥ 90 min early |
| `mcp` + Mangum incompatibility | AWS Lambda Web Adapter layer running uvicorn |
| First deploy fails on API Gateway deployment | Fixed by 5.6 |
| Deleting a real resource | Sandbox account, `scope_tags`, tag-conditioned IAM, APPROVED check, still-idle re-check |

## Definition of done

- One-time setup (11.1–11.2), then a push to `master` brings up API, MCP endpoint, dashboard and daily scan with no other manual steps.
- Every capability in the UI coverage table works from the deployed CloudFront URL with no CORS errors, including error responses.
- Demo resources exist only after a manual `create` and are deleted automatically after the TTL.
- The agent, through the cloud MCP endpoint, finds exactly 4 demo resources ($35.62/mo), cannot delete before approval, deletes after approval, and the dashboard shows the savings as reclaimed.
- `pytest`, `cfn-lint` and frontend tests pass in CI. Total AWS spend stays under $20.
