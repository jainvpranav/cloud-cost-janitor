import React from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { PageHeader } from '../components/Layout';
import {
  Callout,
  CodeBlock,
  DocSection,
  DocsToc,
  FactStrip,
  FlowDiagram,
  LayerStack,
  RuleTable,
  Stepper,
} from '../components/Docs';
import { Badge, Button, Card, CardBody, CardHeader } from '../components/UI';
import { inlineCode } from '../components/Docs';

/* ==========================================================================
   Content data
   ========================================================================== */

const SECTIONS = [
  { id: 'overview', title: 'What this does', keywords: 'intro summary purpose value cost savings' },
  { id: 'pipeline', title: 'The pipeline', keywords: 'flow stages scan detect enrich approve teardown events' },
  { id: 'detection', title: 'How a resource gets flagged', keywords: 'rules ec2 ebs elb cpu network idle snapshot asg thresholds' },
  { id: 'enrichment', title: 'What the AI contributes', keywords: 'openai gpt confidence recommendation risk reasoning prompt' },
  { id: 'approval', title: 'Review and approval', keywords: 'quorum votes dual approval expiry sla reject' },
  { id: 'teardown', title: 'Teardown and guardrails', keywords: 'delete safety dry run guardrail ttl snapshot exclusion' },
  { id: 'lifecycle', title: 'Status lifecycle', keywords: 'states machine status transitions pending' },
  { id: 'architecture', title: 'Architecture', keywords: 'lambda dynamodb sns eventbridge api gateway cloudfront s3 iam' },
  { id: 'data-model', title: 'Data model', keywords: 'tables findings approvals config prompt registry keys gsi ttl' },
  { id: 'cost-model', title: 'How monthly cost is estimated', keywords: 'pricing estimate ec2 ebs elb rates accuracy' },
  { id: 'api', title: 'API reference', keywords: 'endpoints rest findings approvals vote teardown config' },
  { id: 'configuration', title: 'Configuration reference', keywords: 'settings thresholds tags notifications env' },
  { id: 'troubleshooting', title: 'Troubleshooting', keywords: 'errors debug common issues faq help' },
];

const PIPELINE = [
  {
    icon: 'clock',
    title: 'Schedule',
    body: 'EventBridge fires the scanner once a day. Nothing runs continuously, so there is no surprise API spend.',
    meta: ['rate(1 day)', 'EventBridge'],
  },
  {
    icon: 'search',
    title: 'Scan',
    body: 'The scanner assumes the cross-account role, pages through EC2, EBS and ELBv2, and pulls CloudWatch metrics for each candidate.',
    meta: ['Lambda', '512 MB', '5 min'],
  },
  {
    icon: 'filter',
    title: 'Detect',
    body: 'Pure rule evaluation decides what is genuinely idle. Anything matching an exclusion tag is dropped here and never surfaces.',
    meta: ['rules.py', 'no AI yet'],
  },
  {
    icon: 'sparkles',
    title: 'Enrich',
    body: 'An enrichment Lambda sends the evidence to the model, which returns a recommendation, a risk level and a confidence score.',
    meta: ['gpt-4o-mini', 'JSON out'],
  },
  {
    icon: 'bell',
    title: 'Notify',
    body: 'An approval record is created and SNS emails the reviewers. Requests above $100/mo need two sign-offs.',
    meta: ['7 day expiry', 'SNS'],
  },
  {
    icon: 'trash',
    title: 'Teardown',
    body: 'Once quorum is met, the teardown Lambda re-checks every guardrail before deleting. A dry run is always available first.',
    meta: ['guardrails', 'audited'],
  },
];

const LAYERS = [
  {
    name: 'Presentation',
    tier: 'React SPA',
    body: 'Static bundle served from S3 behind CloudFront. Reads exclusively through the REST API and never touches AWS directly, so it can be swapped for any other client.',
    items: ['CloudFront + OAI', 'SPA error rewrites', 'light/dark themes', 'no secrets in the bundle'],
  },
  {
    name: 'Interface',
    tier: 'REST on Lambda',
    body: 'A single function fronts all reads and writes. It is the only component that both serves the browser and invokes the teardown path, which keeps the authorisation surface small.',
    items: ['findings', 'approvals + vote', 'teardown trigger', 'config'],
  },
  {
    name: 'Detection',
    tier: 'Scanner Lambda',
    body: 'Stateless evaluation against a config record fetched from DynamoDB. Detection logic lives in pure functions so it is testable without AWS.',
    items: ['sts:AssumeRole', 'CloudWatch metrics', 'pure rule functions'],
  },
  {
    name: 'Intelligence',
    tier: 'Enrichment Lambda',
    body: 'Invoked asynchronously by the scanner. Reads the active prompt version from the registry table so prompts can be rolled forward without a deploy.',
    items: ['prompt registry', 'versioned templates', 'graceful fallback'],
  },
  {
    name: 'Execution',
    tier: 'Teardown Lambda',
    body: 'The only component with delete permissions. It re-validates the approval, re-checks guardrails, and supports a dry-run mode that reports the plan without touching anything.',
    items: ['dry run', 'guardrail re-check', 'delete EC2 / snapshots / ELB'],
  },
  {
    name: 'State',
    tier: 'DynamoDB + SNS',
    body: 'Four tables with 90-day TTLs, plus a topic for approval mail. GSIs on status and account make the queue queries cheap.',
    items: ['findings', 'approvals', 'config', 'prompt registry', 'SNS topic'],
  },
];

const DETECTION_ROWS = [
  ['EC2', 'Avg CPU below `cpu_threshold_percent` across `cpu_hours` <em>and</em> network in below `network_idle_bytes`', '`monthly_cost_usd` from the instance-type price table', 'Anything inside an Auto Scaling Group is always skipped.'],
  ['EBS', 'State is `available`, age greater than `ebs_unattached_days`, <em>and</em> no snapshot newer than `ebs_no_snapshot_days`', 'Volume size multiplied by the per-GB rate for the volume type', 'The recent-snapshot test is the real safety net — a volume with a fresh snapshot is never touched.'],
  ['ELB', 'No healthy targets in any target group <em>and</em> zero requests in the window <em>and</em> age greater than `lb_idle_days`', 'Flat rate per load balancer type', 'A load balancer with a healthy target is never flagged, even with zero traffic.'],
];

const APPROVAL_ROWS = [
  ['Single approval', 'Monthly cost at or below `$100`', 'One `approve` vote from any reviewer', 'Under a minute once someone looks at it'],
  ['Dual approval', 'Monthly cost above `$100`', 'Two distinct `approve` votes', 'Needs two people — the usual cause of a stalled queue'],
  ['Any reject', 'Always', 'A single `reject` vote', 'Immediate. A reject can never be overturned by further approvals'],
  ['Expiry', 'After `7 days`', 'No action', 'The request lapses and the finding is never revisited'],
];

const GUARDRAIL_ROWS = [
  ['Approval must be `APPROVED`', 'Teardown refuses to run against a pending, rejected or expired request'],
  ['Exclusion tags re-checked', 'If the resource gained a protective tag between scan and teardown, the run aborts'],
  ['Config thresholds re-checked', 'If the resource is no longer idle under the current rules, the run aborts'],
  ['Monthly cost above `$500`', 'Requires an explicit override flag in the invocation payload'],
  ['SSM managed instances', 'Instances managed by Systems Manager are skipped — they are usually intentional'],
  ['Volume has snapshots', 'Snapshots are preserved. Only the volume itself is removed'],
  ['90-day TTL on all records', 'Findings and approvals age out on their own, so the table cannot grow without bound'],
];

const DATA_MODEL_ROWS = [
  ['`findings`', '`finding_id`', '`status`, `account_id`', '`resource_type`, `resource_id`, `region`, `monthly_cost_usd`, `status`, `detected_at`, `evidence`, `tags`, `enrichment`'],
  ['`approvals`', '`approval_id`', '`finding_id`, `status`', '`finding_id`, `status`, `required_approvals`, `votes[]`, `expires_at`'],
  ['`config`', '`config_key`', '—', 'Thresholds, exclusion tags, notification recipients'],
  ['`prompt_registry`', '`model_name` + `version`', '—', 'Versioned prompt templates with an active flag'],
];

const API_ROWS = [
  ['`GET`', '`/findings`', 'List findings. Supports `status`, `account_id`, `limit`, `last_key`', '`{ items, last_key }`'],
  ['`GET`', '`/approvals`', 'List approvals. Supports `status`, `limit`, `last_key`. Each item embeds its finding', '`{ items, last_key }`'],
  ['`POST`', '`/approvals/{id}/vote`', 'Record a vote. Body: `{ decision, user }`', 'The updated approval'],
  ['`POST`', '`/teardown`', 'Trigger teardown. Body: `{ approval_id, dry_run }`', '`202` with a trigger receipt'],
  ['`GET`', '`/config`', 'Read the active scan configuration', 'The config object'],
  ['`PUT`', '`/config`', 'Replace the scan configuration', '`{ message }`'],
];

const TROUBLE_ROWS = [
  ['Every finding shows “enriching”', 'The enrichment Lambda is failing, so findings never leave `PENDING_ENRICHMENT`. Check its logs and confirm the OpenAI key is present in the environment.'],
  ['EC2 findings show `$0.00`', 'The instance type was not in the price table, or the cost field was not populated. Unknown types fall back to a conservative estimate — check the scanner logs.'],
  ['Dual approvals never complete', 'The UI acts as a single hard-coded user, so it can only ever cast one vote. Two different people must vote.'],
  ['Approval buttons do nothing', 'There is no pending approval for that finding yet. It only exists once enrichment has run.'],
  ['Nothing is ever flagged', 'Exclusion tags are usually the cause. Resources tagged `Environment=prod` or `CostJanitor=ignore` are dropped before a finding is created.'],
  ['“Cannot reach the API”', '`REACT_APP_API_URL` is baked in at build time, and the API Gateway CORS allow-list must include the exact origin serving this bundle.'],
];

const FAQ = [
  {
    q: 'What happens if the model is wrong?',
    a: 'The finding lands in a human queue, and nothing is deleted until the required number of reviewers approve it. A reviewer who knows the resource is in use simply rejects it, which is recorded as a false positive you can analyse later on the Insights page.',
  },
  {
    q: 'Is the scan reversible?',
    a: 'No. Teardown permanently deletes the resource, so the flow is built to be slow by default: one approval under $100 a month, two above that, a seven-day expiry, and a mandatory dry run you can inspect first.',
  },
  {
    q: 'Why does the model only see metadata?',
    a: 'The prompt is built from the scanner evidence — resource type, utilisation, age, tags — never from instance contents or credentials. Tags are included because they carry ownership and environment information that is usually decisive.',
  },
  {
    q: 'Can I trust the cost figures?',
    a: 'They are estimates from a static price table, accurate enough to rank opportunities but not to reconcile against a real bill. Treat them as a prioritisation signal, not as a financial report.',
  },
  {
    q: 'What happens when the API is down?',
    a: 'Reads fail visibly with an actionable message and the page offers a retry. Nothing is written during a failure, so a partial outage cannot leave a finding half-approved.',
  },
];

/* ==========================================================================
   Page
   ========================================================================== */

export const Docs = () => {
  const navigate = useNavigate();

  return (
    <div className="app-body">
      <PageHeader
        eyebrow={
          <>
            <Icon name="book" size={12} />
            Operator documentation
          </>
        }
        title="How Cloud Cost Janitor works"
        subtitle="From a scheduled API call to a permanently deleted resource — every step, every guardrail, and every number on the dashboard."
        actions={
          <>
            <Button variant="secondary" icon="gauge" onClick={() => navigate('/insights')}>
              See it on your data
            </Button>
            <Button variant="primary" icon="inbox" onClick={() => navigate('/approvals')}>
              Open the queue
            </Button>
          </>
        }
      />

      <div className="docs-layout">
        <DocsToc sections={SECTIONS} />

        <div>
          {/* ---------------- Overview ---------------- */}
          <DocSection id="overview" title="What this does" icon="target">
            <p>
              Cloud Cost Janitor finds AWS resources that are demonstrably idle, asks a language model to
              sanity-check the call, routes the result through a human approval queue, and only then deletes
              anything. The deletion step is the whole point — a dashboard that merely <em>tells</em> you about
              waste does not reduce the bill.
            </p>
            <p>
              The design assumption is that <strong>detection must be conservative and deletion must be
              accountable</strong>. A false positive costs a reviewer's attention; a false negative costs you
              another month of paying for nothing. So the scanner only flags resources with measurable evidence
              of idleness, and everything downstream is gated on a person saying yes.
            </p>

            <FactStrip
              facts={[
                { label: 'Resource types covered', value: '3', unit: 'classes', icon: 'layers', hint: 'EC2 instances, EBS volumes, load balancers', color: 'var(--brand)' },
                { label: 'Approvals to delete', value: '1–2', icon: 'users', hint: 'One under $100/mo, two above', color: 'var(--warn)' },
                { label: 'Request expiry', value: '7', unit: 'days', icon: 'hourglass', hint: 'Then it lapses and is never revisited', color: 'var(--info)' },
                { label: 'Retention', value: '90', unit: 'days', icon: 'layers', hint: 'DynamoDB TTL on findings and approvals', color: 'var(--ai)' },
              ]}
            />

            <Callout tone="info" title="Start here if you are reviewing a finding">
              The <a href="#enrichment">AI assessment</a> is advisory. The{' '}
              <a href="#teardown">guardrails</a> are enforced in the Lambda that performs the deletion, not in
              the interface — so nothing you do in this UI can bypass them.
            </Callout>
          </DocSection>

          {/* ---------------- Pipeline ---------------- */}
          <DocSection id="pipeline" title="The pipeline" icon="activity">
            <p>
              Six stages, two of which involve a person. Everything before the first approval is automated;
              everything after the last approval is irreversible, which is why the middle is deliberately slow.
            </p>
            <FlowDiagram nodes={PIPELINE} />
            <p>
              Each stage is a separate Lambda with its own IAM role and its own timeout. That isolation is the
              point: a model call that hangs cannot block the scan, and a teardown cannot be triggered by
              anything other than an explicit, approved invocation.
            </p>
            <Callout tone="warn" title="Enrichment failure is not fatal">
              If the model call fails or returns unparseable JSON, the finding is still created. It lands with
              a <code>medium</code> risk assessment, a <code>0.3</code> confidence and a{' '}
              <code>investigate</code> recommendation, and a human picks it up. Detection never depends on the
              model being available.
            </Callout>
          </DocSection>

          {/* ---------------- Detection ---------------- */}
          <DocSection id="detection" title="How a resource gets flagged" icon="filter">
            <p>
              Detection is a set of pure functions over AWS API responses. It runs before any model call and
              decides only whether a resource is a <em>candidate</em>. Three classes are covered:
            </p>
            <RuleTable head={['Class', 'Condition (all must hold)', 'Monthly cost from', 'Important exclusions']} rows={DETECTION_ROWS} />
            <p>
              Every threshold is configurable from the <a href="#configuration">Settings page</a> and is read
              from the config table at the start of each run, so a change takes effect on the next scan without
              a deploy.
            </p>
            <Stepper
              steps={[
                {
                  title: 'Exclude first',
                  body: 'Tag matching happens before anything else. An excluded resource is never evaluated, never enriched, and never creates an approval record. This is the cheapest and most reliable guardrail in the system.',
                },
                {
                  title: 'Narrow to candidates',
                  body: 'Cheap structural checks run before expensive metric reads: is the instance stopped, is the volume attached, does the load balancer have healthy targets. Only survivors get CloudWatch calls.',
                  bullets: [
                    'Instances inside an Auto Scaling Group are dropped — ASGs scale themselves down and back up on their own.',
                    'Only <code>running</code> instances are considered; a stopped one is not waste.',
                    'Load balancers with any healthy target are dropped regardless of traffic.',
                  ],
                },
                {
                  title: 'Confirm with metrics',
                  body: 'CloudWatch statistics over the configured window establish that the resource is genuinely idle, rather than merely quiet at the moment the API responded.',
                },
                {
                  title: 'Price it',
                  body: 'A monthly cost is attached to every finding. This single number drives every ranking, KPI and chart in the interface.',
                },
              ]}
            />
          </DocSection>

          {/* ---------------- Enrichment ---------------- */}
          <DocSection id="enrichment" title="What the AI contributes" icon="sparkles">
            <p>
              The scanner is good at answering <em>"is this resource idle?"</em> and bad at answering{' '}
              <em>"should this resource exist?"</em>. The enrichment step exists to close that gap. It receives
              the finding's evidence and returns a structured judgement.
            </p>

            <RuleTable
              head={['Field', 'Meaning', 'How it is used in the UI']}
              rows={[
                ['`recommendation`', 'One of <code>delete</code>, <code>keep</code> or <code>investigate</code>', 'Rendered as the primary coloured badge; drives the sort order on the Insights page'],
                ['`risk_assessment`', '`low`, `medium` or `high` risk of being needed', 'Feeds the risk profile donut and the high-risk insight'],
                ['`confidence`', 'Self-reported probability, 0 to 1', 'Above 80% marks a finding as high-confidence and auto-recommendable'],
                ['`reasoning`', 'A short prose explanation', 'Shown verbatim so a reviewer can audit the call'],
                ['`business_impact`', 'Consequences of removing it', 'Surfaced alongside the reasoning'],
                ['`suggested_action`', 'The concrete next step', 'Displayed in the suggested-action panel'],
                ['`model_version`', 'Which prompt version produced this', 'Lets you tell a good rollout from a bad one'],
              ]}
            />

            <h3>Prompt versioning</h3>
            <p>
              Prompts are data, not code. The enrichment Lambda reads the active template from the prompt
              registry table at invocation time, so a new prompt version can be rolled out — and rolled back —
              without redeploying anything. The version that produced a given finding is stored on the finding
              itself.
            </p>
            <CodeBlock
              lang="json"
              title="enrichment object stored on each finding"
              code={`{
  "recommendation": "delete",
  "risk_assessment": "low",
  "confidence": 0.91,
  "reasoning": "No CPU above 1.2% across 48h and under 40KB of network in. No non-prod tags. Instance has been running 214 days.",
  "business_impact": "None identified. No ASG membership, no elastic IP, no attached EBS volumes.",
  "suggested_action": "Terminate i-0a1b2c3d4e5f60718 and archive the security group.",
  "model_version": "v1",
  "enriched_at": "2026-09-25T04:12:07.481Z"
}`}
            />

            <Callout tone="info" title="Calibration is measured, not assumed">
              The Insights page compares every <code>delete</code> call against what reviewers actually did.
              If reviewers uphold fewer than 40% of them, the model is flagged as untrustworthy and the
              recommendation is to fix the detection rules or the prompt — not to raise the automation
              threshold.
            </Callout>
          </DocSection>

          {/* ---------------- Approval ---------------- */}
          <DocSection id="approval" title="Review and approval" icon="users">
            <p>
              Approval is the only part of the system a person has to touch, so it is deliberately explicit.
              Every vote is recorded with the voter and a timestamp, and the tally is visible to everyone.
            </p>
            <RuleTable head={['Rule', 'Applies when', 'Requirement', 'Effect']} rows={APPROVAL_ROWS} />

            <h3>Why a single reject is final</h3>
            <p>
              One <code>reject</code> immediately marks the request rejected, no matter how many approvals it
              already has. This is intentional: if anyone with access to the queue believes a resource is
              still needed, the safe outcome is to keep it. Making rejection require a counter-approval would
              let a majority delete something a minority recognised as live.
            </p>

            <h3>Expiry is a feature, not a bug</h3>
            <p>
              A request that nobody acts on within seven days lapses. The resource keeps running and keeps
              costing money, but nothing is destroyed on stale information. If expiry is producing a large
              backlog of untouched requests, the fix is a review cadence, not a longer window.
            </p>

            <CodeBlock
              lang="bash"
              title="Vote on a request"
              code={`curl -X POST "$API/approvals/appr-f-EC2-i-0a1b2c3d-20260925/vote" \\
  -H 'Content-Type: application/json' \\
  -d '{"decision":"approve","user":"pranav@example.com"}'`}
            />
          </DocSection>

          {/* ---------------- Teardown ---------------- */}
          <DocSection id="teardown" title="Teardown and guardrails" icon="shield">
            <p>
              The teardown Lambda is the only component holding delete permissions, and it refuses to act
              unless every guardrail below passes. The guardrails run <em>again at execution time</em>, not
              just at scan time, so a resource that changed in the interim is left alone.
            </p>
            <RuleTable head={['Guardrail', 'What it enforces']} rows={GUARDRAIL_ROWS} />

            <h3>Dry run first</h3>
            <p>
              Every approved request offers a dry run. It executes the full guardrail evaluation and returns the
              plan — which resources would be deleted, what the guardrail verdict is — without calling a single
              delete API. Run it, read the Lambda log, then commit.
            </p>
            <CodeBlock
              lang="json"
              title="Teardown invocation payloads"
              code={`// Preview only — nothing is deleted
{ "approval_id": "appr-f-EC2-i-0a1b2c3d-20260925", "dry_run": true }

// Real deletion — guardrails re-evaluated first
{ "approval_id": "appr-f-EC2-i-0a1b2c3d-20260925", "dry_run": false }`}
            />
            <Callout tone="danger" title="There is no undo">
              Terminating an instance, deleting a volume or removing a load balancer is immediate and
              permanent. The control is the approval gate, not a recovery path. This is why the interface
              requires an explicit confirmation, and why expiry exists.
            </Callout>
          </DocSection>

          {/* ---------------- Lifecycle ---------------- */}
          <DocSection id="lifecycle" title="Status lifecycle" icon="refresh">
            <p>
              Every finding occupies exactly one status. The transitions are driven by the pipeline rather than
              by the interface, which is why the dashboard reflects the real state of the system rather than
              an optimistic guess.
            </p>
            <RuleTable
              head={['Status', 'Meaning', 'Next', 'Driven by']}
              rows={[
                ['`PENDING_ENRICHMENT`', 'Detected, waiting for the model', '`PENDING_APPROVAL`', 'Enrichment Lambda'],
                ['`PENDING_APPROVAL`', 'Enriched, waiting for reviewers', '`APPROVED` or `REJECTED`', 'Vote API'],
                ['`APPROVED`', 'Quorum reached, teardown unlocked', '`TEARDOWN_COMPLETE`', 'Teardown Lambda'],
                ['`TEARDOWN_COMPLETE`', 'Resource removed; savings realised', '—', 'Teardown Lambda'],
                ['`REJECTED`', 'A reviewer kept the resource', '—', 'Vote API'],
                ['`EXPIRED`', 'Lapsed after seven days', '—', 'Approval record TTL'],
              ]}
            />
            <p>
              The Dashboard groups these into a funnel so you can see immediately whether the bottleneck is{' '}
              <em>detection</em> (a big bar at the first stage) or <em>approval</em> (a big bar at the second).
              Those two diagnoses call for completely different interventions.
            </p>
          </DocSection>

          {/* ---------------- Architecture ---------------- */}
          <DocSection id="architecture" title="Architecture" icon="layers">
            <p>
              Everything runs inside one CloudFormation stack. There is no container service, no orchestrator
              and no always-on compute — five event-driven Lambdas, four DynamoDB tables and a static bundle.
            </p>
            <LayerStack layers={LAYERS} />
            <CodeBlock
              lang="bash"
              title="Invoke the pipeline end to end"
              code={`# Trigger a scan without waiting for the daily schedule
aws lambda invoke --function-name cost-janitor-scanner \\
  --payload '{"account_id":"123456789012"}' /dev/stdout

# Preview what a teardown would do
aws lambda invoke --function-name cost-janitor-teardown \\
  --payload '{"approval_id":"appr-f-EC2-i-0a1b2c3d-20260925","dry_run":true}' /dev/stdout`}
            />
          </DocSection>

          {/* ---------------- Data model ---------------- */}
          <DocSection id="data-model" title="Data model" icon="database">
            <p>
              Findings and approvals are separated deliberately. A finding is a fact about a resource and can
              be regenerated; an approval is a record of a human decision and must never be. Keeping them
              apart means a re-scan can never quietly discard a sign-off.
            </p>
            <RuleTable head={['Table', 'Partition key', 'GSIs', 'Notable attributes']} rows={DATA_MODEL_ROWS} />
            <p>
              Every record carries a 90-day TTL. Nothing in the system needs to be retained indefinitely, and
              the TTL guarantees the tables cannot grow without bound.
            </p>
            <CodeBlock
              lang="json"
              title="A complete finding record"
              code={`{
  "finding_id": "f-EC2-i-0a1b2c3d4e5f60718-20260925",
  "account_id": "123456789012",
  "resource_type": "EC2",
  "resource_id": "i-0a1b2c3d4e5f60718",
  "region": "us-east-1",
  "monthly_cost_usd": 60.74,
  "status": "PENDING_APPROVAL",
  "detected_at": "2026-09-25T04:11:58.220Z",
  "evidence": {
    "instance_type": "t3.large",
    "state": "running",
    "cpu_avg_24h": 0.84,
    "cpu_max_24h": 3.10,
    "network_in_bytes_24h": 39821,
    "age_days": 214
  },
  "tags": { "Name": "staging-worker-07", "Environment": "staging" },
  "enrichment": { "recommendation": "delete", "risk_assessment": "low", "confidence": 0.91 },
  "ttl": 1793452800
}`}
            />
          </DocSection>

          {/* ---------------- Cost model ---------------- */}
          <DocSection id="cost-model" title="How monthly cost is estimated" icon="dollar">
            <p>
              Every ranking, KPI and chart in this product is driven by one number per finding:{' '}
              <code>monthly_cost_usd</code>. It is worth being precise about how good that number is.
            </p>
            <RuleTable
              head={['Class', 'Method', 'Accuracy']}
              rows={[
                ['EC2', 'Lookup of the instance type in a static on-demand price table, with a conservative fallback for unknown types', 'Exact for standard us-east-1 on-demand pricing. Ignores Savings Plans, Reserved Instances, Spot and regional variation.'],
                ['EBS', 'Volume size multiplied by the per-GB monthly rate for the volume type', 'Close for standard volumes. Ignores IOPS and throughput-tier pricing on <code>io1</code>/<code>io2</code>.'],
                ['ELB', 'Flat monthly rate per load balancer type', 'Close. Ignores data-transfer and LCU charges, which usually dominate for a genuinely idle balancer — so this tends to understate the saving.'],
              ]}
            />
            <Callout tone="warn" title="These are prioritisation numbers, not invoices">
              Costs are computed locally from a static table. They are accurate enough to rank opportunities
              and to decide what to clean up first, but they will not reconcile against a real AWS bill. Never
              use them for chargeback or showback.
            </Callout>
          </DocSection>

          {/* ---------------- API ---------------- */}
          <DocSection id="api" title="API reference" icon="code">
            <p>
              Seven endpoints, all JSON, all on the interface Lambda. The interface never reaches into
              DynamoDB directly from the browser — every read and every write goes through this API.
            </p>
            <RuleTable head={['Method', 'Path', 'Purpose', 'Returns']} rows={API_ROWS} />
            <CodeBlock
              lang="bash"
              title="Read the queue"
              code={`# Everything waiting on a decision, each item carrying its finding
curl "$API/approvals?status=PENDING&limit=50"

# Findings in a given state, newest first
curl "$API/findings?status=PENDING_APPROVAL&limit=50"`}
            />
            <p>
              List endpoints are cursor-paginated. Pass the returned <code>last_key</code> back as{' '}
              <code>?last_key=</code> to fetch the next page. The dashboard loads a wide first page on
              purpose, so the KPI tiles and the table below them always describe the same set of records.
            </p>
          </DocSection>

          {/* ---------------- Configuration ---------------- */}
          <DocSection id="configuration" title="Configuration reference" icon="sliders">
            <p>
              Scan thresholds, exclusion tags and notification recipients are editable from the{' '}
              <a href="/settings">Settings page</a> and stored in the config table. The scanner reads them at
              the start of every run.
            </p>
            <RuleTable
              head={['Key', 'Default', 'Controls', 'Setting it too low']}
              rows={[
                ['`cpu_threshold_percent`', '`5`', 'The CPU level below which an instance counts as idle', 'Flags instances that are busy in bursts'],
                ['`cpu_hours`', '`24`', 'Length of the CloudWatch lookback window', 'Misses seasonal or batch workloads entirely'],
                ['`network_idle_bytes`', '`1048576`', 'Total bytes received over the window', 'Flags instances that pull data intermittently'],
                ['`ebs_unattached_days`', '`7`', 'How long a volume must be detached', 'Flags volumes mid-detachment during a re-provision'],
                ['`ebs_no_snapshot_days`', '`30`', 'How old the newest snapshot must be', 'The most important safety setting — do not lower it'],
                ['`lb_idle_days`', '`7`', 'How long a load balancer must be trafficless', 'Flags a balancer waiting for a deployment'],
                ['`excluded_tags`', 'see below', 'Tag keys and values that exempt a resource', 'Narrow exclusions mean more false positives'],
              ]}
            />
            <CodeBlock
              lang="json"
              title="Exclusion tag format"
              code={`{
  "Environment": ["prod", "production"],
  "CostJanitor": ["ignore", "do-not-delete"],
  "Owner": ["platform-team", "security-team"]
}`}
            />
            <Callout tone="info" title="Exclusions are checked at scan time and again at teardown time">
              Adding an exclusion does not retroactively remove existing findings — those still need to be
              rejected. But a resource that gains a protective tag <em>after</em> being flagged will be
              protected from deletion by the teardown guardrail.
            </Callout>
          </DocSection>

          {/* ---------------- Troubleshooting ---------------- */}
          <DocSection id="troubleshooting" title="Troubleshooting" icon="alertTriangle">
            <RuleTable head={['Symptom', 'Cause and fix']} rows={TROUBLE_ROWS} />

            <h3>Common questions</h3>
            <div className="stack stack-5" style={{ marginTop: 'var(--s-6)' }}>
              {FAQ.map((f) => (
                <Card key={f.q}>
                  <CardBody className="stack stack-3">
                    <div className="row row-5 row-top">
                      <span className="stat-icon" style={{ background: 'var(--brand-subtle)', color: 'var(--brand-fg)' }}>
                        <Icon name="info" size={14} />
                      </span>
                      <h3 style={{ fontSize: 'var(--fs-md)' }}>{f.q}</h3>
                    </div>
                    <p
                      className="t-md t-dim"
                      style={{ lineHeight: 'var(--lh-loose)', paddingLeft: 'calc(30px + var(--s-5))' }}
                      dangerouslySetInnerHTML={{ __html: inlineCode(f.a) }}
                    />
                  </CardBody>
                </Card>
              ))}
            </div>
          </DocSection>

          <div className="row row-between row-wrap" style={{ gap: 'var(--s-6)', paddingTop: 'var(--s-8)' }}>
            <Badge tone="neutral" dot>
              Documentation for v1.0.0
            </Badge>
            <div className="row row-5 row-wrap">
              <Button variant="secondary" icon="gauge" onClick={() => navigate('/insights')}>
                Insights
              </Button>
              <Button variant="primary" icon="inbox" onClick={() => navigate('/approvals')}>
                Approval queue
              </Button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
