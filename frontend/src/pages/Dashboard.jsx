import React, { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { Icon } from '../components/Icons';
import { PageHeader, SectionHeader } from '../components/Layout';
import { BarChart, Sparkline } from '../components/Charts';
import { FindingCard, FindingRow } from '../components/FindingCard';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Modal,
  Money,
  SearchInput,
  Segmented,
  SkeletonRows,
  SkeletonStats,
  StatTile,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
} from '../components/UI';
import { useApprovals, useApprover, useFindings } from '../hooks/useApi';
import { ActivityFeed, RunScanButton } from '../components/Live';
import { approvalsApi, toMessage } from '../api/client';
import { computeMetrics, costTone, STATUS } from '../lib/metrics';
import { buildInsights, SEVERITY_META } from '../lib/insights';
import { money, num, pct, relativeTime } from '../lib/format';

const TYPE_TONE = { EC2: 'var(--viz-1)', EBS: 'var(--viz-3)', ELB: 'var(--viz-2)', ASG: 'var(--viz-5)' };

const TABS = [
  { id: 'all', label: 'All' },
  { id: STATUS.PENDING_ENRICHMENT, label: 'Detected' },
  { id: STATUS.PENDING_APPROVAL, label: 'Awaiting review' },
  { id: STATUS.APPROVED, label: 'Approved' },
  { id: STATUS.TEARDOWN_COMPLETE, label: 'Reclaimed' },
  { id: STATUS.REJECTED, label: 'Rejected' },
];

export const Dashboard = () => {
  const navigate = useNavigate();
  const { findings, loading, loadingMore, error, hasMore, refetch, loadMore, fetchedAt } = useFindings({ limit: 200, pollMs: 3000 });
  // Every status, so the throughput KPIs (approval rate, turnaround, expiry)
  // are real rather than always blank.
  const { approvals } = useApprovals({ status: 'all', limit: 200, pollMs: 3000 });
  const [approver] = useApprover();

  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [view, setView] = useState('cards');
  const [detail, setDetail] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [pendingId, setPendingId] = useState(null);

  const m = useMemo(() => computeMetrics(findings, approvals), [findings, approvals]);
  const insights = useMemo(() => buildInsights(m), [m]);

  const tabs = useMemo(
    () => TABS.map((t) => ({ ...t, count: t.id === 'all' ? findings.length : m.counts[t.id] || 0 })),
    [findings.length, m.counts]
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return findings.filter((f) => {
      if (tab !== 'all' && f.status !== tab) return false;
      if (!q) return true;
      return (
        String(f.resource_id).toLowerCase().includes(q) ||
        String(f.resource_type).toLowerCase().includes(q) ||
        String(f.region).toLowerCase().includes(q) ||
        String(f.account_id).toLowerCase().includes(q)
      );
    });
  }, [findings, tab, query]);

  const vote = async (findingId, decision) => {
    if (!approver) {
      setActionError('Enter your name in "Approving as" at the top of the page before voting.');
      return;
    }
    setPendingId(findingId);
    setActionError(null);
    try {
      // One approval per finding, keyed appr-<finding_id> (created by the agent's teardown plan).
      const res = await approvalsApi.list({ status: 'PENDING', limit: 200 });
      const match = (res.data?.items || []).find(
        (a) => a.finding_id === findingId || a.approval_id === `appr-${findingId}`
      );
      if (!match) throw new Error('No pending approval exists for this finding. It may already be decided.');
      await approvalsApi.vote(match.approval_id, decision, approver);
      await refetch();
    } catch (e) {
      setActionError(toMessage(e, 'Could not record your vote'));
    } finally {
      setPendingId(null);
    }
  };

  if (loading && !findings.length) {
    return (
      <div className="app-body">
        <PageHeader title="Dashboard" subtitle="Loading your cost posture…" />
        <div className="stack stack-9 stagger">
          <SkeletonStats count={4} />
          <Card>
            <CardBody>
              <SkeletonRows rows={6} cols={6} />
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  if (error && !findings.length) {
    return (
      <div className="app-body">
        <PageHeader title="Dashboard" subtitle="Cloud spend visibility and teardown workflow" />
        <Alert variant="error" title="Could not load findings">
          {error}
        </Alert>
        <div className="row row-5" style={{ marginTop: 'var(--s-6)' }}>
          <Button variant="primary" icon="refresh" onClick={refetch}>
            Retry
          </Button>
          <Button variant="secondary" icon="book" onClick={() => navigate('/docs')}>
            Read how it works
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-body">
      <PageHeader
        eyebrow={
          <>
            <Icon name="activity" size={12} />
            {fetchedAt ? `Live · updated ${relativeTime(fetchedAt)}` : 'Live'}
          </>
        }
        title="Cloud Cost Janitor"
        subtitle="Every idle resource AWS is still billing you for, ranked by what it costs to keep ignoring."
        actions={
          <>
            <RunScanButton onFinished={() => refetch()} />
            <Button variant="secondary" icon="refresh" onClick={() => refetch()} loading={loading}>
              Refresh
            </Button>
            <Button variant="secondary" icon="gauge" onClick={() => navigate('/insights')}>
              Deep-dive
            </Button>
          </>
        }
      />

      {actionError ? (
        <Alert variant="error" title="Action failed" onDismiss={() => setActionError(null)}>
          {actionError}
        </Alert>
      ) : null}

      {/* ---------------- KPI strip ---------------- */}
      <section className="section">
        <div className="stat-grid stagger">
          <StatTile
            label="Reclaimed savings"
            value={money(m.realizedMonthly, { compact: true })}
            unit="/mo"
            icon="trendingUp"
            tone="success"
            hint={`${money(m.realizedAnnual, { compact: true })} annualised`}
            footer={
              m.total > 0 ? (
                <span className="stat-spark full">
                  <Sparkline data={m.trend.map((t) => t.count)} stroke="var(--success)" />
                </span>
              ) : null
            }
          />
          <StatTile
            label="Awaiting a decision"
            value={money(m.pendingMonthly, { compact: true })}
            unit="/mo"
            icon="hourglass"
            tone={m.staleCount > 0 ? 'warn' : 'brand'}
            hint={`${num(m.openCount)} resource${m.openCount === 1 ? '' : 's'} in the queue`}
            footer={
              m.staleCount > 0 ? (
                <Badge tone="warn" dot>
                  {num(m.staleCount)} older than 72h
                </Badge>
              ) : (
                <span className="t-xs t-muted">Queue is fresh</span>
              )
            }
          />
          <StatTile
            label="Total addressable"
            value={money(m.addressableAnnual, { compact: true })}
            unit="/yr"
            icon="target"
            tone="brand"
            hint={`${money(m.addressableMonthly, { compact: true })}/mo across pending + approved`}
            footer={
              m.total > 0 ? (
                <span className="t-xs t-muted">
                  {pct(m.pendingMonthly / Math.max(1, m.addressableMonthly), 0)} still needs a reviewer
                </span>
              ) : null
            }
          />
          <StatTile
            label="Approval rate"
            value={m.approvalRate === null ? '—' : pct(m.approvalRate, 0)}
            icon="checkCircle"
            tone={m.approvalRate === null ? 'neutral' : m.approvalRate >= 0.7 ? 'success' : 'warn'}
            hint={
              m.decidedCount
                ? `${num(m.decidedCount)} decided · median ${num(m.medianDecisionHours || 0)}h`
                : 'No decisions recorded yet'
            }
            footer={
              m.decidedCount ? (
                <span className="t-xs t-muted">
                  {num(m.approvedCount)} approved · {num(m.rejectedCount)} rejected
                </span>
              ) : null
            }
          />
        </div>
      </section>

      {/* ---------------- Live agent activity ---------------- */}
      <section className="section">
        <ActivityFeed />
      </section>

      {/* ---------------- Insights ---------------- */}
      {insights.length > 0 ? (
        <section className="section">
          <SectionHeader
            title="What needs your attention"
            icon="sparkles"
            description={`${insights.filter((i) => ['critical', 'high'].includes(i.severity)).length} of ${insights.length} flagged`}
          />
          <div className="grid grid-2">
            {insights.slice(0, 4).map((i) => {
              const meta = SEVERITY_META[i.severity] || SEVERITY_META.low;
              return (
                <div className="insight" key={i.id}>
                  <span className={`insight-icon sev-${meta.tone}`}>
                    <Icon name={i.icon || meta.icon} size={16} />
                  </span>
                  <div className="insight-body">
                    <div className="insight-title">{i.title}</div>
                    <p className="insight-text">{i.text}</p>
                  </div>
                  {i.value ? <span className="insight-metric">{i.value}</span> : null}
                </div>
              );
            })}
          </div>
          {insights.length > 4 ? (
            <div style={{ marginTop: 'var(--s-6)' }}>
              <Link to="/insights" className="btn btn-ghost btn-sm">
                See all {insights.length} insights <Icon name="arrowRight" size={13} />
              </Link>
            </div>
          ) : null}
        </section>
      ) : null}

      {/* ---------------- Breakdown + pipeline ---------------- */}
      <section className="section">
        <div className="grid grid-sidebar">
          <Card>
            <CardHeader
              title="Spend by resource type"
              icon="barChart"
              subtitle="Monthly cost of everything currently identified as idle"
            />
            <CardBody>
              {m.byType.length ? (
                <BarChart
                  data={m.byType.map((t) => ({
                    key: t.key,
                    label: t.key,
                    value: t.monthly,
                    color: TYPE_TONE[t.key] || 'var(--viz-1)',
                    sub: `${num(t.count)} resource${t.count === 1 ? '' : 's'} identified`,
                  }))}
                  valueFormat={(v) => money(v, { compact: true })}
                />
              ) : (
                <EmptyState icon="pieChart" compact title="Nothing to break down yet" description="No findings have been recorded." />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Queue health" icon="activity" subtitle="Findings by lifecycle stage" />
            <CardBody className="stack stack-7">
              {m.total > 0 ? (
                <>
                  <div className="stack stack-5">
                    {TABS.slice(1).map((t) => {
                      const count = m.counts[t.id] || 0;
                      const monthly =
                        findings
                          .filter((f) => f.status === t.id)
                          .reduce((a, f) => a + (Number(f.monthly_cost_usd) || 0), 0);
                      const tone = {
                        PENDING_ENRICHMENT: 'var(--viz-5)',
                        PENDING_APPROVAL: 'var(--warn)',
                        APPROVED: 'var(--brand)',
                        TEARDOWN_COMPLETE: 'var(--success)',
                        REJECTED: 'var(--danger)',
                      }[t.id];
                      return (
                        <button
                          key={t.id}
                          className="meter-row"
                          onClick={() => setTab(tab === t.id ? 'all' : t.id)}
                          style={{ background: 'none', textAlign: 'left', cursor: 'pointer', opacity: tab === t.id ? 1 : 0.85 }}
                        >
                          <div className="meter-row-head">
                            <span className="k t-truncate">{t.label}</span>
                            <span className="v">
                              {num(count)}
                              <span className="t-xs t-muted" style={{ marginLeft: 6, fontWeight: 400 }}>
                                {money(monthly, { compact: true })}
                              </span>
                            </span>
                          </div>
                          <div className="meter">
                            <div
                              className="meter-bar"
                              style={{
                                width: `${m.total ? (count / m.total) * 100 : 0}%`,
                                background: tone,
                              }}
                            />
                          </div>
                        </button>
                      );
                    })}
                  </div>
                  <div className="divider" />
                  <div className="grid grid-2" style={{ gap: 'var(--s-6)' }}>
                    <div className="metric">
                      <span className="metric-label">AI coverage</span>
                      <span className="metric-value">{pct(m.aiCoverage, 0)}</span>
                      <span className="metric-hint">
                        {num(m.enrichedCount)}/{num(m.total)} assessed
                      </span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Avg confidence</span>
                      <span className="metric-value">
                        {m.avgConfidence === null ? '—' : pct(m.avgConfidence, 0)}
                      </span>
                      <span className="metric-hint">
                        {m.deletePrecision === null
                          ? 'no decided calls'
                          : `${pct(m.deletePrecision, 0)} of deletes upheld`}
                      </span>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState icon="activity" compact title="No pipeline data" />
              )}
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ---------------- Findings list ---------------- */}
      <section className="section">
        <SectionHeader title="Findings" icon="list" />
        <Card>
          <div className="card-header" style={{ flexWrap: 'wrap', rowGap: 'var(--s-6)' }}>
            <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />
            <div className="row row-5">
              <div style={{ width: 210 }}>
                <SearchInput value={query} onChange={setQuery} placeholder="Filter resources…" />
              </div>
              <Segmented
                value={view}
                onChange={setView}
                options={[
                  { value: 'cards', label: 'Cards', icon: 'grid' },
                  { value: 'table', label: 'Table', icon: 'list' },
                ]}
              />
            </div>
          </div>

          <CardBody flush>
            {visible.length === 0 ? (
              <EmptyState
                icon={query ? 'search' : 'inbox'}
                title={query ? 'Nothing matches that filter' : `No ${tab === 'all' ? '' : TABS.find((t) => t.id === tab)?.label.toLowerCase()} findings`}
                description={
                  query
                    ? 'Try a different resource ID, type, region or account.'
                    : tab === 'all'
                      ? 'Run a scan from the AWS console to populate this view.'
                      : 'Switch tabs to see findings at other stages.'
                }
              >
                {query ? (
                  <Button variant="secondary" size="sm" icon="close" onClick={() => setQuery('')}>
                    Clear filter
                  </Button>
                ) : null}
              </EmptyState>
            ) : view === 'table' ? (
              <Table>
                <TableHead>
                  <TableRow>
                    <TableHeaderCell>Resource</TableHeaderCell>
                    <TableHeaderCell>Status</TableHeaderCell>
                    <TableHeaderCell>AI call</TableHeaderCell>
                    <TableHeaderCell>Risk</TableHeaderCell>
                    <TableHeaderCell>Region</TableHeaderCell>
                    <TableHeaderCell>Account</TableHeaderCell>
                    <TableHeaderCell>Confidence</TableHeaderCell>
                    <TableHeaderCell align="right">Monthly</TableHeaderCell>
                    <TableHeaderCell align="right">Annual</TableHeaderCell>
                    <TableHeaderCell align="right">Detected</TableHeaderCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {visible.map((f) => (
                    <FindingRow key={f.finding_id} finding={f} onOpen={setDetail} />
                  ))}
                </TableBody>
              </Table>
            ) : (
              <div className="stack stack-6" style={{ padding: 'var(--s-7)' }}>
                {visible.map((f) => (
                  <FindingCard
                    key={f.finding_id}
                    finding={f}
                    onApprove={(id) => vote(id, 'approve')}
                    onReject={(id) => vote(id, 'reject')}
                    onOpen={setDetail}
                  />
                ))}
              </div>
            )}
          </CardBody>

          {hasMore || loadingMore ? (
            <div className="row row-end" style={{ padding: 'var(--s-6) var(--s-8)', borderTop: '1px solid var(--border-soft)' }}>
              {hasMore ? (
                <Button variant="secondary" size="sm" icon="refresh" onClick={loadMore} loading={loadingMore}>
                  Load {nextPageLabel(m, visible.length, findings.length)}
                </Button>
              ) : (
                <span className="t-xs t-muted">All {num(findings.length)} findings loaded</span>
              )}
            </div>
          ) : null}
        </Card>
      </section>

      <Modal
        isOpen={Boolean(detail)}
        onClose={() => setDetail(null)}
        size="lg"
        title={detail ? `${detail.resource_type} ${detail.resource_id}` : ''}
        subtitle={detail ? `${detail.region} · ${detail.account_id || 'self'} · detected ${relativeTime(detail.detected_at)}` : ''}
        footer={
          <>
            {detail && detail.status === STATUS.PENDING_APPROVAL ? (
              <>
                <Button
                  variant="success-soft"
                  icon="check"
                  loading={pendingId === detail.finding_id}
                  onClick={() => vote(detail.finding_id, 'approve')}
                >
                  Approve
                </Button>
                <Button
                  variant="danger-soft"
                  icon="close"
                  loading={pendingId === detail.finding_id}
                  onClick={() => vote(detail.finding_id, 'reject')}
                >
                  Reject
                </Button>
              </>
            ) : null}
            <div className="spacer" />
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Close
            </Button>
          </>
        }
      >
        {detail ? <DetailBody finding={detail} /> : null}
      </Modal>
    </div>
  );
};

function DetailBody({ finding }) {
  const e = finding.evidence || {};
  const cost = Number(finding.monthly_cost_usd) || 0;
  return (
    <div className="stack stack-7">
      <div className="row row-5 row-wrap">
        <Badge tone="neutral" mono>
          {finding.finding_id}
        </Badge>
        <Badge tone="neutral" dot>
          {finding.resource_type}
        </Badge>
        <Badge tone="neutral" dot>
          {finding.region}
        </Badge>
      </div>
      <div className="grid grid-3" style={{ gap: 'var(--s-6)' }}>
        <div className="metric">
          <span className="metric-label">Monthly cost</span>
          <Money amount={cost} size="lg" />
        </div>
        <div className="metric">
          <span className="metric-label">Annualised</span>
          <Money amount={cost * 12} size="lg" tone="success" />
        </div>
        <div className="metric">
          <span className="metric-label">Severity</span>
          <span className={`metric-value t-${costTone(cost)}`}>{costTone(cost)}</span>
          <span className="metric-hint">{cost > 100 ? 'needs 2 approvals' : 'single approval'}</span>
        </div>
      </div>
      <div className="evidence-grid">
        {Object.entries(e).map(([k, v]) => (
          <div className="evidence-item" key={k}>
            <div className="k">{k.replace(/_/g, ' ')}</div>
            <div className="v">{typeof v === 'object' ? JSON.stringify(v) : String(v)}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function nextPageLabel(m, shown, loaded) {
  const remaining = Math.max(0, shown === 0 ? loaded : loaded - shown);
  return remaining ? `next ${Math.min(50, remaining)}` : 'next 50';
}
