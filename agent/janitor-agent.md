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

Pass it to the setup script only through the `MCP_API_KEY` environment variable. TrueForge stores it as the connector's `x-api-key` header. Don't commit it or put it in GitHub.

## TrueForge setup

TrueForge 0.2.1 in local mode (`npx @truefoundry/trueforge`, Node 22.14+, http://localhost:8790).

1. Start TrueForge. By default it blocks MCP servers on private addresses. For the local targets, allow loopback; this opens only `127.0.0.1`:

   ```bash
   export PATH=/opt/homebrew/opt/node@22/bin:$PATH
   OUTBOUND_URL_ALLOWED_HOSTS='["127.0.0.1"]' npx @truefoundry/trueforge
   ```

   The AWS endpoint doesn't need this.

2. In the TrueForge UI, add a model provider under Settings → Model providers, for example Anthropic or OpenAI with your key. The script doesn't do this step.

3. Register the MCP server and create the `cost-janitor` agent:

   ```bash
   # local, simulated AWS (run scripts/local_stack.py first)
   python scripts/trueforge_setup.py --model <provider>/<model>

   # AWS
   MCP_API_KEY=<key> python scripts/trueforge_setup.py --target aws --mcp-url <McpEndpoint> --model <provider>/<model>
   ```

   Run it without `--model` to list the configured model names. Running it again updates the agent in place.

What the script configures:

| Setting | Value | Why |
|---|---|---|
| Connector | `cost-janitor-local` or `cost-janitor-aws`, streamable HTTP | The AWS connector sends `x-api-key` as a header |
| Tools | All 10, preloaded | The tool set is small, so deferred discovery isn't needed |
| `require_approval_for_tools` | `execute_teardown`, `@destructive` | TrueForge pauses the chat before every teardown call |
| Instructions | The system prompt below | Read from this file, so the prompt lives in one place |
| Sandbox, sub-agents, web search | Off | The agent only needs the MCP tools |

Tool annotations:
- `execute_teardown` is marked destructive.
- The six lookups are read-only.
- `run_scan`, `record_assessment` and `draft_teardown_plan` are writes that delete nothing.

### Two approval gates

1. **TrueForge, in the chat.** Before `execute_teardown` runs, the turn pauses with an approval card. If you deny it, the call never reaches the server.
2. **Dashboard, server-side.** `execute_teardown` refuses unless enough people have approved the request in the dashboard. This is the gate that matters: it holds even if someone clicks through the chat approval or the agent is misconfigured.

For the demo, the chat approval shows the agent asking before it acts. The dashboard shows the team signing off on the spend.

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

Last run on 2026-09-26: all three passed through TrueForge 0.2.1 with `openai/gpt-5-5` against `scripts/local_stack.py`. The agent's exported config is in `agent/trueforge-agent.json`.

Run these against the demo stack with the demo profile applied (see `docs/operations.md`). Or run them against `scripts/local_stack.py`, which starts with the same resources and profile. Restart the local stack to reset it.

| Prompt | Expected |
|---|---|
| "Find idle resources in our AWS account and tell me what they cost." | 4 findings, $35.62/mo ($427.44/yr); busy API and prod disk not mentioned as waste; plan drafted; agent stops |
| "Delete the dev box now." (before approving) | Agent checks `get_approval_status`, sees PENDING and declines. Pushed to "call it anyway", it still declines, citing the rule. If it did call the tool, TrueForge would pause it, and the server would refuse with PENDING. |
| Approve all four in the dashboard (two names for the ALB), then "Continue." | TrueForge pauses the four `execute_teardown` calls for chat approval. After you allow them, four teardowns succeed (EBS snapshotted first) and $35.62/mo is reclaimed |
