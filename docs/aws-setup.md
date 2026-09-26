# AWS Setup

Everything to do in AWS, in order. Steps 1–5 are one-time and come **before** you create the GitHub secrets. Step 6 is GitHub. Steps 7–10 come after the first deploy.

Region is `us-east-1` throughout. Budget: $20/month total.

## Before you start

- A **sandbox AWS account** with no real workloads. The janitor can delete resources.
- AWS CLI v2 signed in to that account with **admin** permissions (only needed for step 3).
- Run the commands from the repository root.

---

## 1. Confirm the account

```bash
aws sts get-caller-identity
```

Check that the `Account` shown is the sandbox account. Keep the account id out of git.

## 2. Check for an existing GitHub OIDC provider

An AWS account can have only one provider for GitHub Actions.

```bash
aws iam list-open-id-connect-providers
```

- No `token.actions.githubusercontent.com` in the list: go to step 3 as written.
- One is listed: copy its ARN and add `ExistingOidcProviderArn=<that-arn>` to the parameters in step 3.

## 3. Deploy the one-time CI stack

Creates:

- `cost-janitor-github-deploy`: the role GitHub Actions uses, trusted only for this repo's `master` branch and `prod` environment
- the Lambda artifacts bucket (old builds expire after 30 days)
- a $20/month AWS Budget that emails you at 25%, 50%, 80% of actual spend and 100% of forecast

```bash
aws cloudformation deploy \
  --stack-name cost-janitor-github-oidc \
  --template-file infrastructure/github-oidc.yaml \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1 \
  --parameter-overrides BudgetEmail=<your-email>
```

Takes about a minute. It should end with `Successfully created/updated stack`.

If the repository is not `jainvpranav/cloud-cost-janitor` or the branch is not `master`, add `GitHubRepo=<owner/name>` and `DeployBranch=<branch>` to the parameters.

## 4. Read the outputs

```bash
aws cloudformation describe-stacks \
  --stack-name cost-janitor-github-oidc \
  --region us-east-1 \
  --query 'Stacks[0].Outputs' --output table
```

Copy the two values:

| Output | Goes into GitHub as |
|---|---|
| `DeployRoleArn` | Secret `AWS_DEPLOY_ROLE_ARN` |
| `ArtifactsBucketName` | Variable `ARTIFACTS_BUCKET` |

## 5. Check the default VPC

The demo stack is created in the default VPC.

```bash
aws ec2 describe-vpcs --filters Name=is-default,Values=true \
  --region us-east-1 --query 'Vpcs[0].VpcId' --output text
```

If it prints `None`, create one:

```bash
aws ec2 create-default-vpc --region us-east-1
```

---

## 6. GitHub secrets and variables

GitHub → Settings → Environments → **New environment** → `prod`. Add these to the `prod` environment:

| Name | Kind | Required | Value |
|---|---|---|---|
| `AWS_DEPLOY_ROLE_ARN` | Secret | Yes | `DeployRoleArn` from step 4 |
| `NOTIFICATION_EMAIL` | Secret | Yes | Team email for approval notices |
| `ARTIFACTS_BUCKET` | Variable | Yes | `ArtifactsBucketName` from step 4 |
| `FRONTEND_BUCKET_NAME` | Variable | Yes | Globally unique, **must start with `cost-janitor-`**, e.g. `cost-janitor-frontend-<team>-<random>` |
| `OPENAI_API_KEY` | Secret | No | Only if you turn enrichment on |
| `DEMO_TTL_HOURS` | Variable | No | Default `8`, maximum `24` |

Old secrets that are no longer used and can be deleted: `API_GATEWAY_ID`, `CLOUDFRONT_DISTRIBUTION_ID`, `FRONTEND_BUCKET`.

The MCP API key does **not** go into GitHub (see step 8).

---

## 7. First deploy

Merge the PR into `master`. The **Deploy** workflow runs test → backend → frontend.

- The first run takes 10–15 minutes because CloudFront is created.
- The job summary lists `FrontendUrl`, `ApiEndpoint`, `McpEndpoint` and `McpApiKeyId`.
- If the first run fails, the stack is left in `ROLLBACK_COMPLETE`. Fix the cause and re-run the workflow; it deletes the failed stack and starts over.

Check it from the CLI:

```bash
aws cloudformation describe-stacks --stack-name cost-janitor-prod --region us-east-1 \
  --query 'Stacks[0].[StackStatus, Outputs[?OutputKey==`FrontendUrl`].OutputValue | [0]]' --output text
```

Then open the `FrontendUrl` in a browser. The dashboard should load with no errors and no findings.

## 8. Get the MCP API key for TrueForge

```bash
aws apigateway get-api-key --api-key <McpApiKeyId> --include-value \
  --region us-east-1 --query value --output text
```

Store it only in TrueForge's secret store. The agent sends it as the `x-api-key` header to `McpEndpoint`. Setup and prompt are in `agent/janitor-agent.md`.

## 9. Confirm the notification email

AWS SNS sends a "Subscription Confirmation" email to `NOTIFICATION_EMAIL`. Click the link in it.

## 10. Demo day

| When | What |
|---|---|
| T−90 min | GitHub → Actions → **Demo resources** → Run workflow → `create`. Costs about $0.06/hour and deletes itself after `DEMO_TTL_HOURS`. |
| T−30 min | `python scripts/demo_profile.py apply --api <ApiEndpoint>`, then rehearse |
| T−10 min | `python scripts/demo_reset.py --yes` (needs AWS credentials) |
| After | **Demo resources** → `delete`; `python scripts/demo_cleanup.py --delete`; `python scripts/demo_profile.py restore --api <ApiEndpoint>` |

A scan with the demo profile should find 4 items worth $35.62/month. Full runbook: `docs/operations.md`.

---

## Costs at a glance

| What | Cost |
|---|---|
| Platform stack (Lambda, DynamoDB, API Gateway, S3, CloudFront) | Under $1/month at demo usage |
| Demo stack, while it exists | About $0.062/hour (≈ $0.50 for a demo day) |
| Pre-delete EBS snapshots | Cents; remove with `demo_cleanup.py` |

Optional: Billing console → Cost allocation tags → activate `CostJanitor` and `Project` (available after the demo stack has been created once) to see demo spend separately in Cost Explorer.

## Removing everything

```bash
aws cloudformation delete-stack --stack-name janitor-demo --region us-east-1
aws cloudformation delete-stack --stack-name cost-janitor-prod --region us-east-1
```

Empty the frontend bucket first (`aws s3 rm s3://<bucket> --recursive`), or the stack delete fails on a non-empty bucket. The artifacts bucket is versioned, so empty it with the **Empty** button in the S3 console (that removes old versions too), then delete `cost-janitor-github-oidc` last.
