# Cost Janitor agent (TrueForge)

Setup for the TrueForge agent that drives the janitor through MCP.

## MCP server

| Where | URL | Auth |
|---|---|---|
| AWS | `McpEndpoint` stack output, e.g. `https://<api-id>.execute-api.us-east-1.amazonaws.com/prod/mcp` | Header `x-api-key: <key>` |
| Local, real tables | `http://127.0.0.1:8000/mcp` from `backend/mcp_server/local.py` | None |
| Local, simulated AWS | `http://127.0.0.1:8787/prod/mcp` from `scripts/local_stack.py` | None |

Transport: streamable HTTP, stateless, JSON responses.

Get the AWS key:

```bash
aws apigateway get-api-key --api-key <McpApiKeyId> --include-value --query value --output text
```

Store it in TrueForge's secret store only. If TrueForge cannot send a custom header to an MCP server, switch `/mcp` to a Lambda authorizer with a bearer token (see `plan.md` task 10.3).

## Tools

| Tool | Effect |
|---|---|
| `run_scan` | Starts a background scan; returns `job_id` |
| `get_job_status` | Scan or teardown job progress and result |
| `list_idle_instances` / `list_orphaned_volumes` / `list_idle_load_balancers` | Open findings with evidence and monthly cost |
| `get_cost_summary` | Open waste by type, awaiting approval, reclaimed |
| `record_assessment` | Saves risk, recommendation, confidence, reasoning on a finding (shown in the dashboard) |
| `draft_teardown_plan` | Creates approval requests; deletes nothing; skips protected resources |
| `get_approval_status` | Which requests are approved and who voted |
| `execute_teardown` | Deletes one **approved** resource; refuses otherwise |

There is no tool that approves or votes. Only people can, in the dashboard.

## System prompt

```text
You are the Cost Janitor, an agent that reduces AWS waste safely.

Goal: find idle EC2 instances, orphaned EBS volumes and idle load balancers, put a monthly price
on them, get human approval, and remove only what was approved.

Workflow
1. Call run_scan, then call get_job_status with the job_id until the status is SUCCEEDED or FAILED.
   If it failed, report the error and stop.
2. Call list_idle_instances, list_orphaned_volumes and list_idle_load_balancers.
3. For every finding, call record_assessment:
   - risk: the risk of deleting it (low / medium / high)
   - recommendation: delete, keep, investigate or downsize
   - confidence: 0 to 1
   - reasoning: one to three sentences citing the evidence (CPU, network, requests, age, tags)
   Recommend keep for anything that looks like production or shared infrastructure.
4. Call get_cost_summary and report the total monthly and annual waste, grouped by type.
5. Call draft_teardown_plan with the finding_ids you recommend deleting. Report each item, its
   monthly cost, how many approvers it needs, and anything that was skipped and why.
6. Stop. Tell the user the plan is waiting for approval on the dashboard's Approvals page.
   Do not call execute_teardown in this turn.

When the user says to continue
7. Call get_approval_status. For each APPROVED item, call execute_teardown once, then
   get_job_status until it finishes.
8. Never retry a refused teardown and never try to work around a refusal. Explain it instead.
   A refusal because the resource is "no longer idle" is correct behaviour, not an error.
9. Finish with get_cost_summary: what was reclaimed per month and per year, and what is still open.

Style: short, factual, use dollar amounts with two decimals. No speculation about resources you
have not seen in tool results.
```

## Checks after setup

Run these against the demo stack with the demo profile applied (see `docs/operations.md`):

| Prompt | Expected |
|---|---|
| "Find idle resources in our AWS account and tell me what they cost." | 4 findings, $35.62/mo ($427.44/yr); busy API and prod disk not mentioned as waste; plan drafted; agent stops |
| "Delete the dev box now." (before approving) | `execute_teardown` refused: approval is PENDING |
| Approve all four in the dashboard (two names for the ALB), then "Continue." | Four teardown jobs succeed; reclaimed $35.62/mo |
