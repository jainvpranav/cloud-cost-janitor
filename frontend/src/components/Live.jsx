import React, { useEffect, useRef, useState } from 'react';

import { Icon } from './Icons';
import { Badge, Button, Card, CardBody, CardHeader, EmptyState } from './UI';
import { isJobDone, useActivity, useApprover, useJob } from '../hooks/useApi';
import { scanApi, toMessage } from '../api/client';
import { relativeTime } from '../lib/format';

/* ==========================================================================
   Agent activity feed
   ========================================================================== */

const TOOL_LABELS = {
  run_scan: 'Started a scan',
  get_job_status: 'Checked job status',
  list_idle_instances: 'Listed idle instances',
  list_orphaned_volumes: 'Listed orphaned volumes',
  list_idle_load_balancers: 'Listed idle load balancers',
  get_cost_summary: 'Summarized cost',
  record_assessment: 'Recorded an assessment',
  draft_teardown_plan: 'Drafted a teardown plan',
  get_approval_status: 'Checked approvals',
  execute_teardown: 'Requested a teardown',
  vote: 'Voted',
  teardown: 'Started a teardown',
  teardown_dry_run: 'Started a dry run',
};

const ACTOR_TONE = { agent: 'ai', dashboard: 'brand' };

export function ActivityItem({ item }) {
  const label = TOOL_LABELS[item.tool] || item.tool;
  const actor = item.actor || 'agent';
  return (
    <li className="row row-top row-6" style={{ padding: 'var(--s-4) 0', borderBottom: '1px solid var(--border)' }}>
      <span
        className={`stat-icon ${item.ok === false ? 'sev-critical' : 'sev-positive'}`}
        style={{ width: 26, height: 26, flex: 'none' }}
        aria-hidden="true"
      >
        <Icon name={item.ok === false ? 'xCircle' : actor === 'agent' ? 'sparkles' : 'user'} size={13} />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="row row-5 row-wrap">
          <strong className="t-sm">{label}</strong>
          <Badge tone={ACTOR_TONE[actor] || 'neutral'}>{actor}</Badge>
          {item.ok === false ? <Badge tone="danger">refused</Badge> : null}
        </div>
        {item.result_summary ? (
          <div className="t-xs t-dim t-clip-2" style={{ marginTop: 2, overflowWrap: 'anywhere' }}>
            {item.result_summary}
          </div>
        ) : null}
      </div>
      <span className="t-xs t-muted t-nowrap">{item.at ? relativeTime(item.at) : ''}</span>
    </li>
  );
}

export function ActivityFeed({ pollMs = 3000, limit = 12 }) {
  const { items, error, loading } = useActivity({ pollMs, limit });
  return (
    <Card>
      <CardHeader
        title="Agent activity"
        subtitle="Every tool call the agent makes and every dashboard action, live"
        icon="activity"
        action={<Badge tone="success" dot>Live</Badge>}
      />
      <CardBody>
        {error ? <p className="t-sm t-danger">{error}</p> : null}
        {!error && !loading && items.length === 0 ? (
          <EmptyState
            compact
            icon="sparkles"
            title="No activity yet"
            description="Ask the TrueForge agent to find idle resources, or press Run scan."
          />
        ) : (
          <ul aria-label="Agent activity" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {items.map((item) => (
              <ActivityItem key={item.ts} item={item} />
            ))}
          </ul>
        )}
      </CardBody>
    </Card>
  );
}

/* ==========================================================================
   Approver identity
   ========================================================================== */

export function ApproverField({ compact, id = 'approver-name' }) {
  const [name, save] = useApprover();
  const [draft, setDraft] = useState(name);
  useEffect(() => setDraft(name), [name]);

  const commit = () => {
    if (draft.trim() !== name) save(draft);
  };

  return (
    <label className="row row-4" title="Votes are recorded under this name" style={{ alignItems: 'center' }}>
      <Icon name="user" size={15} className="t-muted" />
      {compact ? null : <span className="t-sm t-muted t-nowrap">Approving as</span>}
      <input
        id={id}
        type="text"
        value={draft}
        placeholder="Your name"
        aria-label="Approving as"
        autoComplete="name"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
        style={{ width: 140, height: 30, background: name ? undefined : 'var(--warn-subtle)' }}
        maxLength={64}
      />
    </label>
  );
}

/* ==========================================================================
   Demo mode
   ========================================================================== */

export function DemoModeChip({ config }) {
  const scope = config?.scope_tags;
  if (!scope || !Object.keys(scope).length) return null;
  const label = Object.entries(scope)
    .map(([k, v]) => `${k}=${(Array.isArray(v) ? v : [v]).join('|')}`)
    .join(', ');
  return (
    <Badge tone="warn" dot title={`Scans only look at resources tagged ${label}`}>
      Demo mode · {label}
    </Badge>
  );
}

/* ==========================================================================
   Background jobs
   ========================================================================== */

function jobText(job) {
  if (!job) return 'Starting…';
  const r = job.result || {};
  switch (job.status) {
    case 'QUEUED':
      return 'Queued';
    case 'RUNNING':
      return job.kind === 'scan' ? 'Scanning AWS…' : 'Working…';
    case 'SUCCEEDED':
      if (job.kind === 'scan') {
        return `Found ${job.idle_resources ?? 0} idle resources (${job.findings_count ?? 0} new)`;
      }
      if (r.dry_run) return (r.simulated_actions || []).join(' · ') || 'Dry run complete';
      return r.action || 'Done';
    case 'REFUSED':
      return `Refused: ${job.error}${Array.isArray(job.details) ? ` (${job.details.join('; ')})` : ''}`;
    case 'FAILED':
      return `Failed: ${job.error || r.error || 'unknown error'}`;
    default:
      return job.status;
  }
}

const JOB_TONE = { SUCCEEDED: 'success', FAILED: 'danger', REFUSED: 'warn', RUNNING: 'info', QUEUED: 'neutral' };

export function JobStatus({ jobId, onDone }) {
  const { job, error, done } = useJob(jobId);
  const fired = useRef(null);
  useEffect(() => {
    if (done && onDone && fired.current !== jobId) {
      fired.current = jobId;
      onDone(job);
    }
  }, [done, job, jobId, onDone]);
  if (!jobId) return null;
  return (
    <span className="row row-4" role="status" aria-live="polite">
      <Badge tone={JOB_TONE[job?.status] || 'neutral'} dot>
        {job?.status || 'QUEUED'}
      </Badge>
      <span className="t-sm t-dim">{error || jobText(job)}</span>
    </span>
  );
}

export function RunScanButton({ onFinished }) {
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const { job } = useJob(jobId);
  const running = busy || (jobId && !isJobDone(job));

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await scanApi.start();
      setJobId(res.data?.job_id || null);
    } catch (e) {
      setError(toMessage(e, 'Could not start a scan'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <span className="row row-5 row-wrap">
      <Button variant="primary" icon="play" onClick={start} loading={running} disabled={running}>
        Run scan
      </Button>
      {jobId ? <JobStatus jobId={jobId} onDone={onFinished} /> : null}
      {error ? <span className="t-sm t-danger">{error}</span> : null}
    </span>
  );
}
