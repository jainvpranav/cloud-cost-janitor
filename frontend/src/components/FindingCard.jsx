import React, { useState } from 'react';

import { Icon, ResourceIcon } from './Icons';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfidenceMeter,
  Money,
  RecommendationBadge,
  RiskBadge,
  StatusBadge,
  VoteMeter,
} from './UI';
import { bytes, hoursSince, num, relativeTime, shortDate } from '../lib/format';

/* ==========================================================================
   Evidence grid
   ========================================================================== */

function Evidence({ items }) {
  const cells = items.filter((i) => i && i.v !== undefined && i.v !== null && i.v !== '');
  if (!cells.length) return null;
  return (
    <div className="evidence-grid">
      {cells.map((c) => (
        <div className="evidence-item" key={c.k}>
          <div className="k">{c.k}</div>
          <div className="v" title={String(c.v)}>
            {c.v}
          </div>
        </div>
      ))}
    </div>
  );
}

/** Turns the polymorphic `evidence` blob from the scanner into display cells. */
export function evidenceItems(finding) {
  const e = finding.evidence || {};
  const out = [];
  const push = (k, v) => out.push({ k, v });

  if (e.instance_type) push('Instance', e.instance_type);
  if (e.volume_type) push('Volume type', `${e.volume_type}${e.size_gb ? ` · ${e.size_gb} GB` : ''}`);
  if (e.load_balancer_type) push('Type', e.load_balancer_type);
  if (e.state) push('State', e.state);
  if (e.scheme) push('Scheme', e.scheme);
  if (e.cpu_avg_24h !== undefined) push('Avg CPU 24h', `${Number(e.cpu_avg_24h).toFixed(1)}%`);
  if (e.cpu_max_24h !== undefined) push('Peak CPU 24h', `${Number(e.cpu_max_24h).toFixed(1)}%`);
  if (e.network_in_bytes_24h !== undefined) push('Network in 24h', bytes(e.network_in_bytes_24h));
  if (e.request_count_7d !== undefined) push('Requests 7d', num(e.request_count_7d));
  if (e.age_days !== undefined) push('Age', `${num(e.age_days)} days`);
  if (e.snapshot_count !== undefined) {
    push('Snapshots', e.has_recent_snapshot ? `${e.snapshot_count} (recent)` : `${e.snapshot_count || 'none'}`);
  }
  if (e.healthy_targets !== undefined) push('Healthy targets', num(e.healthy_targets));
  if (e.target_groups !== undefined) push('Target groups', num(e.target_groups));
  if (e.cpu_hours) push('Window', `${num(e.cpu_hours)}h`);
  return out;
}

/* ==========================================================================
   AI analysis panel
   ========================================================================== */

function AiPanel({ enrichment }) {
  if (!enrichment) return null;
  const { reasoning, suggested_action: action, confidence, business_impact: impact, model_version: model } = enrichment;
  if (!reasoning && !action && !impact) return null;

  return (
    <div className="ai-panel">
      <div className="ai-panel-head">
        <Icon name="sparkles" size={13} />
        AI assessment
        {model ? <span className="t-muted" style={{ textTransform: 'none', letterSpacing: 0 }}>· {model}</span> : null}
      </div>
      {reasoning ? <p className="ai-reasoning">{reasoning}</p> : null}
      {impact ? (
        <p className="t-sm t-dim" style={{ marginTop: 8 }}>
          <strong className="t-medium">Business impact:</strong> {impact}
        </p>
      ) : null}
      {action ? (
        <div
          className="panel"
          style={{ marginTop: 'var(--s-6)', background: 'var(--surface)', borderColor: 'var(--ai-border)' }}
        >
          <div className="t-upper t-muted" style={{ marginBottom: 4 }}>
            Suggested action
          </div>
          <div className="t-md">{action}</div>
        </div>
      ) : null}
      {confidence !== undefined && confidence !== null ? (
        <div style={{ marginTop: 'var(--s-6)' }}>
          <div className="row row-between" style={{ marginBottom: 5 }}>
            <span className="t-xs t-muted">Model confidence</span>
            <span className="t-xs t-medium">above 80% is auto-recommendable</span>
          </div>
          <ConfidenceMeter value={confidence} />
        </div>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   Lifecycle rail
   ========================================================================== */

const RAIL = [
  { key: 'PENDING_ENRICHMENT', label: 'Found' },
  { key: 'PENDING_APPROVAL', label: 'Reviewed' },
  { key: 'APPROVED', label: 'Approved' },
  { key: 'TEARDOWN_COMPLETE', label: 'Reclaimed' },
];

export function LifecycleRail({ status }) {
  const failed = status === 'REJECTED' || status === 'EXPIRED';
  const idx = failed ? RAIL.length - 1 : RAIL.findIndex((r) => r.key === status);
  return (
    <div className="status-rail">
      {RAIL.map((r, i) => (
        <React.Fragment key={r.key}>
          {i > 0 ? <span className="arrow">›</span> : null}
          <span className={`step ${i < idx ? 'done' : i === idx ? 'current' : ''}`}>
            {i < idx ? <Icon name="check" size={11} strokeWidth={3} /> : null}
            {failed && i === RAIL.length - 1 ? status.toLowerCase() : r.label}
          </span>
        </React.Fragment>
      ))}
    </div>
  );
}

/* ==========================================================================
   Tags
   ========================================================================== */

function TagList({ tags = {}, max = 6 }) {
  const entries = Object.entries(tags);
  if (!entries.length) return null;
  const shown = entries.slice(0, max);
  return (
    <div className="row row-4 row-wrap">
      {shown.map(([k, v]) => (
        <span className="chip" key={k} title={`${k}: ${v}`}>
          <span className="k">{k}</span>
          <span className="v">{v}</span>
        </span>
      ))}
      {entries.length > max ? <span className="chip">+{entries.length - max} more</span> : null}
    </div>
  );
}

/* ==========================================================================
   Detail drawer content — shared by the card and the table row
   ========================================================================== */

function FindingDetail({ finding }) {
  const ev = evidenceItems(finding);
  const queued = hoursSince(finding.detected_at);
  return (
    <div className="stack stack-7">
      <div className="row row-7 row-wrap">
        <StatusBadge status={finding.status} size="lg" />
        <RecommendationBadge recommendation={finding.enrichment?.recommendation} confidence={finding.enrichment?.confidence} />
        <RiskBadge risk={finding.enrichment?.risk_assessment} />
      </div>

      <LifecycleRail status={finding.status} />

      <Evidence items={ev} />

      <div className="grid grid-3" style={{ gap: 'var(--s-6)' }}>
        <div className="metric">
          <span className="metric-label">Monthly cost</span>
          <Money amount={finding.monthly_cost_usd} size="lg" />
        </div>
        <div className="metric">
          <span className="metric-label">Annualised</span>
          <Money amount={(Number(finding.monthly_cost_usd) || 0) * 12} size="lg" tone="success" />
        </div>
        <div className="metric">
          <span className="metric-label">In queue</span>
          <span className="metric-value">{queued ? `${num(queued / 24, { decimals: 1 })}d` : '—'}</span>
          <span className="metric-hint">Detected {shortDate(finding.detected_at)}</span>
        </div>
      </div>

      <AiPanel enrichment={finding.enrichment} />

      {Object.keys(finding.tags || {}).length ? (
        <div className="stack stack-4">
          <div className="t-upper t-muted">Tags</div>
          <TagList tags={finding.tags} max={12} />
        </div>
      ) : null}
    </div>
  );
}

/* ==========================================================================
   FindingCard
   ========================================================================== */

export function FindingCard({ finding, onApprove, onReject, onOpen }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const cost = Number(finding.monthly_cost_usd) || 0;
  const actionable = finding.status === 'PENDING_APPROVAL';

  const run = async (fn, key) => {
    setBusy(key);
    setError(null);
    try {
      await fn(finding.finding_id);
    } catch (e) {
      setError(e.message || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card hoverable>
      <CardHeader
        icon={undefined}
        title={
          <span className="row row-5">
            <span className="resource-icon">
              <ResourceIcon type={finding.resource_type} size={15} />
            </span>
            <span className="mono t-medium">{finding.resource_id}</span>
          </span>
        }
        subtitle={`${finding.resource_type} · ${finding.region} · detected ${relativeTime(finding.detected_at)}`}
        action={
          <>
            <Badge tone="neutral" mono>
              {finding.account_id || 'self'}
            </Badge>
            <Money amount={cost} />
          </>
        }
      />
      <CardBody className="stack stack-7">
        <div className="row row-5 row-wrap">
          <StatusBadge status={finding.status} />
          <RecommendationBadge recommendation={finding.enrichment?.recommendation} confidence={finding.enrichment?.confidence} />
          <RiskBadge risk={finding.enrichment?.risk_assessment} />
        </div>

        <Evidence items={evidenceItems(finding)} />

        <AiPanel enrichment={finding.enrichment} />

        {error ? <Alert variant="error">{error}</Alert> : null}
      </CardBody>
      <div className="action-strip">
        {actionable && onApprove ? (
          <Button
            variant="success-soft"
            size="sm"
            icon="check"
            loading={busy === 'approve'}
            onClick={() => run(onApprove, 'approve')}
          >
            Approve
          </Button>
        ) : null}
        {actionable && onReject ? (
          <Button
            variant="danger-soft"
            size="sm"
            icon="close"
            loading={busy === 'reject'}
            onClick={() => run(onReject, 'reject')}
          >
            Reject
          </Button>
        ) : null}
        <div className="spacer" />
        {onOpen ? (
          <Button variant="ghost" size="sm" iconRight="chevronRight" onClick={() => onOpen(finding)}>
            Details
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

/* ==========================================================================
   FindingRow — dense table representation
   ========================================================================== */

export function FindingRow({ finding, onOpen }) {
  const cost = Number(finding.monthly_cost_usd) || 0;
  return (
    <tr className="clickable" onClick={() => onOpen && onOpen(finding)}>
      <td className="strong">
        <div className="resource-cell">
          <span className="resource-icon">
            <ResourceIcon type={finding.resource_type} size={14} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="resource-name">{finding.resource_id}</div>
            <div className="resource-sub">{finding.resource_type}</div>
          </div>
        </div>
      </td>
      <td>
        <StatusBadge status={finding.status} />
      </td>
      <td>
        <RecommendationBadge recommendation={finding.enrichment?.recommendation} />
      </td>
      <td>
        <RiskBadge risk={finding.enrichment?.risk_assessment} />
      </td>
      <td className="num">{finding.region}</td>
      <td className="num">{finding.account_id || '—'}</td>
      <td>
        <ConfidenceMeter value={finding.enrichment?.confidence} />
      </td>
      <td align="right">
        <Money amount={cost} />
      </td>
      <td align="right">
        <Money amount={cost * 12} tone="success" />
      </td>
      <td className="num t-muted">{relativeTime(finding.detected_at)}</td>
    </tr>
  );
}

/* ==========================================================================
   ApprovalCard
   ========================================================================== */

export function ApprovalCard({ approval, finding, onVote, onTeardown, currentUser }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const [showDetail, setShowDetail] = useState(false);
  const votes = approval.votes || [];
  const approved = votes.filter((v) => v.decision === 'approve').length;
  const rejected = votes.filter((v) => v.decision === 'reject').length;
  const required = Number(approval.required_approvals) || 1;
  const canVote = approval.status === 'PENDING';
  const hasVoted = votes.some((v) => v.user === currentUser);
  const f = finding || approval.finding;
  const cost = Number(f?.monthly_cost_usd) || 0;
  const expiresIn = hoursSince(approval.expires_at) * -1;

  const run = async (fn, key) => {
    setBusy(key);
    setError(null);
    try {
      await fn(approval.approval_id);
    } catch (e) {
      setError(e.message || 'Action failed');
    } finally {
      setBusy(null);
    }
  };

  if (!f) {
    return (
      <Card>
        <CardBody>
          <Alert variant="warning" title="Finding not attached">
            The approval record <span className="mono">{approval.approval_id}</span> could not be matched to a
            finding. The underlying finding may have aged out of its 90-day TTL.
          </Alert>
        </CardBody>
      </Card>
    );
  }

  return (
    <Card hoverable>
      <CardHeader
        title={
          <span className="row row-5">
            <span className="resource-icon">
              <ResourceIcon type={f.resource_type} size={15} />
            </span>
            <span className="mono t-medium">{f.resource_id}</span>
          </span>
        }
        subtitle={`${f.resource_type} · ${f.region} · ${f.account_id || 'self'}`}
        action={
          <>
            {required > 1 ? (
              <Badge tone="warn" dot>
                {required} approvals required
              </Badge>
            ) : null}
            <Money amount={cost} />
          </>
        }
      />
      <CardBody className="stack stack-7">
        <div className="row row-5 row-wrap">
          <StatusBadge status={approval.status} />
          <RecommendationBadge recommendation={f.enrichment?.recommendation} confidence={f.enrichment?.confidence} />
          <RiskBadge risk={f.enrichment?.risk_assessment} />
        </div>

        <div className="grid grid-2" style={{ gap: 'var(--s-8)' }}>
          <div className="stack stack-4">
            <div className="t-upper t-muted">Sign-off progress</div>
            <VoteMeter approved={approved} rejected={rejected} required={required} />
            <div className="t-xs t-muted">
              {approved >= required
                ? 'Quorum reached — ready to execute teardown.'
                : `${required - approved} more approval${required - approved === 1 ? '' : 's'} needed.`}
              {expiresIn > 0 ? ` Expires ${relativeTime(approval.expires_at)}.` : ''}
            </div>
          </div>
          <div className="grid grid-2" style={{ gap: 'var(--s-6)' }}>
            <div className="metric">
              <span className="metric-label">Monthly</span>
              <Money amount={cost} size="lg" />
            </div>
            <div className="metric">
              <span className="metric-label">Annual</span>
              <Money amount={cost * 12} size="lg" tone="success" />
            </div>
          </div>
        </div>

        {votes.length > 0 ? (
          <div>
            <div className="t-upper t-muted" style={{ marginBottom: 6 }}>
              Votes
            </div>
            {votes.map((v, i) => (
              <div className="vote-row" key={`${v.user}-${i}`}>
                <Badge tone={v.decision === 'approve' ? 'success' : 'danger'} dot>
                  {v.decision}
                </Badge>
                <span className="t-medium">{v.user}</span>
                <span className="t-xs t-muted">{relativeTime(v.at)}</span>
              </div>
            ))}
          </div>
        ) : null}

        {showDetail ? (
          <>
            <div className="divider" />
            <FindingDetail finding={f} />
          </>
        ) : (
          <AiPanel enrichment={f.enrichment} />
        )}

        {error ? <Alert variant="error">{error}</Alert> : null}

        {!canVote && approval.status === 'APPROVED' && onTeardown ? (
          <Alert variant="success" title="Approved — teardown available">
            {approved >= required
              ? 'All required sign-offs are in. Run a dry run first to preview exactly what will be deleted.'
              : 'Waiting on the remaining sign-off before teardown can run.'}
          </Alert>
        ) : null}
      </CardBody>

      <div className="action-strip">
        {canVote && !hasVoted ? (
          <>
            <Button
              variant="success-soft"
              size="sm"
              icon="check"
              loading={busy === 'approve'}
              onClick={() => run((id) => onVote(id, 'approve'), 'approve')}
            >
              Approve
            </Button>
            <Button
              variant="danger-soft"
              size="sm"
              icon="close"
              loading={busy === 'reject'}
              onClick={() => run((id) => onVote(id, 'reject'), 'reject')}
            >
              Reject
            </Button>
          </>
        ) : canVote && hasVoted ? (
          <Badge tone="neutral" dot>
            You have already voted on this request
          </Badge>
        ) : null}

        <div className="spacer" />

        {approval.status === 'APPROVED' && onTeardown ? (
          <>
            <Button
              variant="secondary"
              size="sm"
              icon="play"
              loading={busy === 'dryrun'}
              onClick={() => run((id) => onTeardown(id, true), 'dryrun')}
            >
              Dry run
            </Button>
            <Button
              variant="danger"
              size="sm"
              icon="trash"
              loading={busy === 'execute'}
              onClick={() => run((id) => onTeardown(id, false), 'execute')}
            >
              Execute teardown
            </Button>
          </>
        ) : null}

        <Button variant="ghost" size="sm" iconRight={showDetail ? 'chevronUp' : 'chevronDown'} onClick={() => setShowDetail((s) => !s)}>
          {showDetail ? 'Less' : 'Evidence'}
        </Button>
      </div>
    </Card>
  );
}
