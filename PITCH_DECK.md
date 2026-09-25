# Cloud Cost Janitor
### Automated AWS Waste Elimination with Human-in-the-Loop Safety

---

## The Problem

**Cloud waste is invisible, expensive, and dangerous to fix manually**

| Statistic | Impact |
|-----------|--------|
| **30-45%** of cloud spend is wasted (Flexera 2024) | $147B+ annually globally |
| **Idle EC2, orphaned EBS, zombie LBs** | Top 3 waste categories |
| **Engineers fear deleting** | "What if prod breaks?" → resources linger for months |
| **No unified visibility** | Spread across accounts, regions, teams |

> *"We found $23K/mo in idle resources last quarter. Took 3 weeks to approve deletions."* — Platform Engineer, Series B startup

---

## The Solution

**Cloud Cost Janitor: Discover → Enrich → Approve → Teardown — Automated, Safe, Auditable**

```
┌─────────────┐    ┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│   SCAN      │───▶│  ENRICH     │───▶│  APPROVE    │───▶│  TEARDOWN   │
│  (Daily)    │    │  (AI + TF)  │    │ (Human)     │    │ (Guarded)   │
└─────────────┘    └─────────────┘    └─────────────┘    └─────────────┘
     │                   │                   │                   │
  EC2/EBS/ELB        GPT-4o-mini         2-person gate      Dry-run default
  CloudWatch         Prompt registry     Slack/Email        Prod tag block
  Pricing API        Risk scoring        Audit trail        Snapshot first
```

---

## Why Now?

| Trend | Opportunity |
|-------|-------------|
| **FinOps maturity** | Teams need automation, not dashboards |
| **AI-assisted ops** | LLMs can reason about resource context |
| **Multi-account AWS** | Centralized governance required |
| **Hackathon timeline** | 6-hour MVP proves velocity |

---

## Live Demo Flow (3 min)

### 1. Dashboard — "What did we find today?"
- 47 findings: 23 EC2, 18 EBS, 6 ELB
- **$3,847/mo potential savings**
- Filter by status, account, cost

### 2. Approval Queue — "Is it safe to delete?"
- Card: `i-0a1b2c3d` (t3.medium, dev, $45/mo)
- AI: *"Low risk, dev instance, 2.1% CPU → recommend delete (92% confidence)"*
- Click **Approve** → second approver notified

### 3. Teardown — "Execute with guardrails"
- Dry-run: *"Would terminate i-0a1b2c3d, save $45/mo"*
- Real run: Guards check → no prod tags → dual approval ✓ → terminates
- Audit log: who, when, what, why

---

## Technical Architecture

```
EventBridge (6 AM) → Lambda Scanner → DynamoDB Findings
                            ↓
                     Lambda Enrichment (OpenAI + TrueFoundry)
                            ↓
                     DynamoDB Approvals + SNS Email
                            ↓
                     React Dashboard (CloudFront)
                            ↓
                     Lambda Teardown (Guarded)
```

**Stack**: Python 3.11, React 18, CloudFormation, GitHub Actions
**Deploy**: Single `git push` → both pipelines

---

## Guardrails (No Accidents)

| Guardrail | Implementation |
|-----------|----------------|
| **Production protection** | Block `Environment=prod\|production` tags |
| **Dual approval** | Required for resources >$100/mo |
| **Cost ceiling** | Block teardown >$1,000/mo automatically |
| **Dry-run default** | Every teardown simulates first |
| **EBS safety** | Snapshot before delete |
| **Rate limit** | Max 10 resources per invocation |
| **Audit trail** | Full history in DynamoDB + CloudTrail |

---

## TrueFoundry Integration

**Prompt Registry for Enrichment Models**

```
Model: cost-janitor-enrichment
├── v1 (active) — Detailed reasoning, risk factors
├── v2 — Concise, structured JSON
└── v3 (experiment) — Cost optimization alternatives
```

- Versioned prompts in DynamoDB
- A/B test prompt versions
- Rollback instantly
- Experiment tracking ready

---

## Business Impact

| Metric | Before | After |
|--------|--------|-------|
| Time to discover waste | Weeks (manual) | **Daily (automated)** |
| Time to approve deletion | Days (email threads) | **Minutes (dashboard)** |
| Accidental prod deletion | Real risk | **Impossible (guardrails)** |
| Monthly savings identified | Ad-hoc | **Continuous** |
| Engineer confidence | Low | **High (AI + human)** |

---

## Hackathon Achievements (6 Hours)

✅ **Full infrastructure** — CloudFormation (24 resources)
✅ **4 Lambda functions** — Scanner, Enrichment, API, Teardown
✅ **4 DynamoDB tables** — Findings, Approvals, Config, Prompts
✅ **React dashboard** — 3 pages, real-time updates
✅ **CI/CD pipelines** — Backend + Frontend
✅ **Bootstrap script** — One-command config
✅ **Documentation** — 7 guides (arch, api, deploy, ops, dev, sec, troubleshoot)
✅ **Guardrails** — Production-safe by default

---

## What's Next

| Phase | Timeline | Scope |
|-------|----------|-------|
| **MVP Hardening** | Week 1-2 | Tests, monitoring, Cognito auth |
| **Multi-Account** | Month 1 | StackSets, org-wide scanning |
| **Slack/Teams Bot** | Month 1 | Approve in chat, `/janitor scan` |
| **ML Cost Prediction** | Month 2 | Forecast waste, recommend rightsizing |
| **Dependency Graph** | Month 2 | "Don't delete LB — 5 EC2s behind it" |
| **Enterprise Features** | Quarter | SSO, RBAC, compliance reports |

---

## Ask

**We're looking for:**

- 🎯 **Design partners** — 3-5 AWS teams to pilot
- 💡 **Feedback** — Guardrail thresholds, approval flows, UI
- 🤝 **Integration** — TrueFoundry prompt registry, Slack, Jira
- 📈 **Scale test** — 100+ accounts, 50K+ resources

---

## Contact

**Team Cloud Cost Janitor**
- GitHub: `github.com/your-org/cloud-cost-janitor`
- Demo: `https://cost-janitor-demo.cloudfront.net`
- Email: `cost-janitor@yourcompany.com`

---

*Built in 6 hours for [Hackathon Name] — "Move fast, delete safely"*