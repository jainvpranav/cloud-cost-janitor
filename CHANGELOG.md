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

### Planned
- Multi-account support via StackSets
- Slack/Teams notifications
- Cost anomaly detection (ML)
- Resource dependency graph
- Automated remediation (resize vs delete)
- Cognito authentication for dashboard
- Terraform provider
- Kubernetes operator