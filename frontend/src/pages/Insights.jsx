import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon, ResourceIcon } from '../components/Icons';
import { PageHeader, SectionHeader } from '../components/Layout';
import { BarChart, ColumnChart, DonutChart, Funnel, StackedBar } from '../components/Charts';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  EmptyState,
  Money,
  SkeletonRows,
  SkeletonStats,
  StatTile,
  Tabs,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
} from '../components/UI';
import { useApprovals, useFindings } from '../hooks/useApi';
import { computeMetrics, STATUS } from '../lib/metrics';
import { buildInsights, SEVERITY_META } from '../lib/insights';
import { money, num, pct, relativeTime } from '../lib/format';

const TYPE_TONE = { EC2: 'var(--viz-1)', EBS: 'var(--viz-3)', ELB: 'var(--viz-2)', ASG: 'var(--viz-5)' };
const TONE_BY_TYPE = { EC2: 'info', EBS: 'success', ELB: 'brand', ASG: 'ai' };

const STAGES = [
  { key: STATUS.PENDING_ENRICHMENT, label: 'Detected', color: 'var(--viz-5)' },
  { key: STATUS.PENDING_APPROVAL, label: 'Awaiting review', color: 'var(--warn)' },
  { key: STATUS.APPROVED, label: 'Approved', color: 'var(--brand)' },
  { key: STATUS.TEARDOWN_COMPLETE, label: 'Reclaimed', color: 'var(--success)' },
  { key: STATUS.REJECTED, label: 'Rejected', color: 'var(--danger)' },
];

export const Insights = () => {
  const navigate = useNavigate();
  const { findings, loading, error, refetch, fetchedAt } = useFindings({ limit: 500 });
  const { approvals } = useApprovals({ status: 'all', limit: 200 });
  const m = useMemo(() => computeMetrics(findings, approvals), [findings, approvals]);
  const insights = useMemo(() => buildInsights(m), [m]);
  const [filter, setFilter] = useState('all');

  const shownInsights = useMemo(
    () => (filter === 'all' ? insights : insights.filter((i) => i.severity === filter)),
    [insights, filter]
  );

  const funnel = useMemo(
    () =>
      STAGES.map((s) => ({
        ...s,
        value: m.counts[s.key] || 0,
        money: findings
          .filter((f) => f.status === s.key)
          .reduce((a, f) => a + (Number(f.monthly_cost_usd) || 0), 0),
      })),
    [m.counts, findings]
  );

  if (loading && !findings.length) {
    return (
      <div className="app-body">
        <PageHeader title="Insights" subtitle="Computing…" />
        <div className="stack stack-9">
          <SkeletonStats count={4} />
          <Card>
            <CardBody>
              <SkeletonRows rows={6} cols={4} />
            </CardBody>
          </Card>
        </div>
      </div>
    );
  }

  return (
    <div className="app-body">
      <PageHeader
        eyebrow={
          <>
            <Icon name="gauge" size={12} />
            Portfolio analysis{fetchedAt ? ` · ${relativeTime(fetchedAt)}` : ''}
          </>
        }
        title="Insights"
        subtitle="Where the money is, what is blocking it, and how much you can trust the model."
        actions={
          <>
            <Button variant="secondary" icon="refresh" onClick={refetch} loading={loading}>
              Recompute
            </Button>
            <Button variant="primary" icon="inbox" onClick={() => navigate('/approvals')}>
              Review queue
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="error" title="Partial data">
          {error} — the figures below may be incomplete.
        </Alert>
      ) : null}

      {/* ---------- Top-line ---------- */}
      <section className="section">
        <div className="stat-grid stagger">
          <StatTile
            label="Annualised savings available"
            value={money(m.addressableAnnual, { compact: true })}
            unit="/yr"
            icon="wallet"
            tone="brand"
            hint={`${money(m.addressableMonthly, { compact: true })}/mo still recoverable`}
          />
          <StatTile
            label="Realisation rate"
            value={m.addressableMonthly > 0 ? pct(m.realizedMonthly / (m.realizedMonthly + m.addressableMonthly), 0) : '—'}
            icon="percent"
            tone={m.realizedMonthly > 0 ? 'success' : 'neutral'}
            hint="Share of identified spend actually removed"
            footer={
              <span className="t-xs t-muted">
                {money(m.realizedMonthly, { compact: true })}/mo of {money(m.realizedMonthly + m.addressableMonthly, { compact: true })}/mo
              </span>
            }
          />
          <StatTile
            label="AI delete precision"
            value={m.deletePrecision === null ? '—' : pct(m.deletePrecision, 0)}
            icon="brain"
            tone={
              m.deletePrecision === null
                ? 'neutral'
                : m.deletePrecision >= 0.7
                  ? 'success'
                  : m.deletePrecision >= 0.4
                    ? 'warn'
                    : 'danger'
            }
            hint={`${num(m.deleteCallsTotal)} decided “delete” call${m.deleteCallsTotal === 1 ? '' : 's'}`}
            footer={
              m.deletePrecision !== null ? (
                <Badge tone={m.deletePrecision >= 0.7 ? 'success' : 'warn'} dot>
                  {m.deletePrecision >= 0.7 ? 'Safe to widen automation' : 'Keep mandatory review'}
                </Badge>
              ) : null
            }
          />
          <StatTile
            label="Median turnaround"
            value={m.medianDecisionHours === null ? '—' : num(m.medianDecisionHours)}
            unit={m.medianDecisionHours === null ? undefined : 'h'}
            icon="clock"
            tone={
              m.medianDecisionHours === null
                ? 'neutral'
                : m.medianDecisionHours > 72
                  ? 'danger'
                  : m.medianDecisionHours > 24
                    ? 'warn'
                    : 'success'
            }
            hint={`across ${num(m.decidedCount)} decisions`}
            footer={
              m.expiredCount > 0 ? (
                <Badge tone="danger" dot>
                  {num(m.expiredCount)} expired
                </Badge>
              ) : null
            }
          />
        </div>
      </section>

      {/* ---------- Insight feed ---------- */}
      <section className="section">
        <SectionHeader
          title="Findings from your data"
          icon="sparkles"
          description={`${insights.length} observation${insights.length === 1 ? '' : 's'} generated`}
        />
        <Card>
          <div className="card-header">
            <Tabs
              tabs={[
                { id: 'all', label: 'All', count: insights.length },
                { id: 'critical', label: 'Critical', count: insights.filter((i) => i.severity === 'critical').length },
                { id: 'high', label: 'Attention', count: insights.filter((i) => i.severity === 'high').length },
                { id: 'medium', label: 'Watch', count: insights.filter((i) => i.severity === 'medium').length },
                { id: 'positive', label: 'Good', count: insights.filter((i) => i.severity === 'positive').length },
              ]}
              activeTab={filter}
              onChange={setFilter}
            />
          </div>
          <CardBody className="stack stack-5">
            {shownInsights.length === 0 ? (
              <EmptyState
                icon="checkCircle"
                title={insights.length ? 'Nothing at this severity' : 'No findings to analyse'}
                description={
                  insights.length
                    ? 'That bucket is clear. Try another severity level.'
                    : 'Run a scan to generate cost observations.'
                }
              />
            ) : (
              shownInsights.map((i) => {
                const meta = SEVERITY_META[i.severity] || SEVERITY_META.low;
                return (
                  <div className="insight" key={i.id}>
                    <span className={`insight-icon sev-${meta.tone}`}>
                      <Icon name={i.icon || meta.icon} size={16} />
                    </span>
                    <div className="insight-body">
                      <div className="row row-5 row-wrap" style={{ marginBottom: 3 }}>
                        <span className="insight-title">{i.title}</span>
                        <Badge tone={meta.tone}>{meta.label}</Badge>
                      </div>
                      <p className="insight-text">{i.text}</p>
                    </div>
                    {i.value ? (
                      <div className="stack stack-2" style={{ alignItems: 'flex-end' }}>
                        <span className="insight-metric t-lg">{i.value}</span>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </CardBody>
        </Card>
      </section>

      {/* ---------- Pipeline + mix ---------- */}
      <section className="section">
        <div className="grid grid-2">
          <Card>
            <CardHeader title="Pipeline conversion" icon="filter" subtitle="How many findings sit at each stage" />
            <CardBody>
              {m.total ? (
                <>
                  <Funnel stages={funnel} onSelect={(s) => navigate(`/?status=${s.key}`)} />
                  <div className="divider" style={{ margin: 'var(--s-7) 0' }} />
                  <div className="grid grid-2" style={{ gap: 'var(--s-6)' }}>
                    <div className="metric">
                      <span className="metric-label">Enrichment → review</span>
                      <span className="metric-value">
                        {pct(
                          (m.counts[STATUS.PENDING_APPROVAL] || 0) /
                            Math.max(
                              1,
                              (m.counts[STATUS.PENDING_APPROVAL] || 0) +
                                (m.counts[STATUS.REJECTED] || 0) +
                                (m.counts[STATUS.APPROVED] || 0) +
                                (m.counts[STATUS.TEARDOWN_COMPLETE] || 0)
                            ),
                          0
                        )}
                      </span>
                      <span className="metric-hint">reach a human</span>
                    </div>
                    <div className="metric">
                      <span className="metric-label">Approved → reclaimed</span>
                      <span className="metric-value">
                        {pct(
                          (m.counts[STATUS.TEARDOWN_COMPLETE] || 0) /
                            Math.max(1, (m.counts[STATUS.APPROVED] || 0) || (m.counts[STATUS.TEARDOWN_COMPLETE] || 0)),
                          0
                        )}
                      </span>
                      <span className="metric-hint">executed</span>
                    </div>
                  </div>
                </>
              ) : (
                <EmptyState icon="filter" compact title="No pipeline data" />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Where the waste is" icon="pieChart" subtitle="Monthly cost split by resource type" />
            <CardBody>
              {m.byType.length ? (
                <DonutChart
                  data={m.byType.map((t) => ({
                    key: t.key,
                    label: t.key,
                    value: t.monthly,
                    color: TYPE_TONE[t.key] || 'var(--viz-1)',
                  }))}
                  centerValue={money(m.byType.reduce((a, b) => a + b.monthly, 0), { compact: true })}
                  centerLabel="per month"
                  valueFormat={(v) => money(v, { compact: true })}
                />
              ) : (
                <EmptyState icon="pieChart" compact title="No cost data" />
              )}
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ---------- AI quality ---------- */}
      <section className="section">
        <SectionHeader
          title="Model quality"
          icon="brain"
          description="How the AI's calls line up with what reviewers actually did"
        />
        <div className="grid grid-2">
          <Card>
            <CardHeader title="Recommendation vs. verdict" icon="target" />
            <CardBody>
              {m.precision.length ? (
                <>
                  <StackedBar
                    height={14}
                    valueFormat={(v) => `${num(v)} finding${v === 1 ? '' : 's'}`}
                    segments={m.precision.map((p) => ({
                      key: p.recommendation,
                      label: p.recommendation,
                      value: p.total,
                    }))}
                  />
                  <div className="stack stack-6" style={{ marginTop: 'var(--s-7)' }}>
                    {m.precision.map((p) => (
                      <div className="meter-row" key={p.recommendation}>
                        <div className="meter-row-head">
                          <span className="k">
                            “{p.recommendation}”
                            <span className="t-xs t-muted">
                              upheld {p.upheld}/{p.total}
                            </span>
                          </span>
                          <span className={`v ${p.rate >= 0.7 ? 't-success' : p.rate < 0.4 ? 't-danger' : ''}`}>
                            {pct(p.rate, 0)}
                          </span>
                        </div>
                        <div className="meter">
                          <div
                            className="meter-bar"
                            style={{
                              width: `${p.rate * 100}%`,
                              background: p.rate >= 0.7 ? 'var(--success)' : p.rate < 0.4 ? 'var(--danger)' : 'var(--warn)',
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>
                </>
              ) : (
                <EmptyState icon="target" compact title="Not enough decided data" description="Upheld rate appears once findings have been approved or rejected." />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Confidence distribution" icon="gauge" subtitle="How sure the model was, by spend" />
            <CardBody>
              {m.enrichedCount ? (
                <>
                  <BarChart
                    data={m.confidence.buckets.map((b) => ({
                      key: b.key,
                      label: b.label,
                      value: b.count,
                      sub: money(b.monthly, { compact: true }),
                      color:
                        b.hi <= 0.6 ? 'var(--danger)' : b.hi <= 0.8 ? 'var(--warn)' : 'var(--success)',
                    }))}
                    valueFormat={(v) => `${num(v)} findings`}
                    barHeight={16}
                  />
                  {m.confidence.unclassified ? (
                    <div style={{ marginTop: 'var(--s-6)' }}>
                      <Badge tone="warn" dot>
                        {num(m.confidence.unclassified)} finding
                        {m.confidence.unclassified === 1 ? '' : 's'} never scored
                      </Badge>
                    </div>
                  ) : null}
                </>
              ) : (
                <EmptyState icon="gauge" compact title="No AI assessments yet" />
              )}
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ---------- Risk, aging, trend ---------- */}
      <section className="section">
        <div className="grid grid-3">
          <Card>
            <CardHeader title="Risk profile" icon="shield" />
            <CardBody>
              {m.risks.length ? (
                <DonutChart
                  size={148}
                  thickness={20}
                  data={m.risks.map((r) => ({
                    key: r.key,
                    label: r.key === 'unknown' ? 'unscored' : `${r.key} risk`,
                    value: r.count,
                    color:
                      r.key === 'high'
                        ? 'var(--viz-6)'
                        : r.key === 'medium'
                          ? 'var(--viz-4)'
                          : r.key === 'low'
                            ? 'var(--viz-3)'
                            : 'var(--viz-8)',
                  }))}
                  centerValue={num(m.total)}
                  centerLabel="findings"
                  valueFormat={(v) => num(v)}
                />
              ) : (
                <EmptyState icon="shield" compact title="No risk data" />
              )}
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Queue age" icon="hourglass" subtitle="Time since detection" />
            <CardBody>
              <div className="stack stack-6">
                {m.aging.map((b) => (
                  <div className="meter-row" key={b.key}>
                    <div className="meter-row-head">
                      <span className="k">{b.label}</span>
                      <span className="v">
                        {num(b.count)}
                        <span className="t-xs t-muted" style={{ marginLeft: 6, fontWeight: 400 }}>
                          {money(b.monthly, { compact: true })}
                        </span>
                      </span>
                    </div>
                    <div className="meter">
                      <div
                        className="meter-bar"
                        style={{
                          width: `${m.total ? (b.count / m.total) * 100 : 0}%`,
                          background: b.key === '15d+' ? 'var(--danger)' : b.key === '8-14d' ? 'var(--warn)' : 'var(--info)',
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </CardBody>
          </Card>

          <Card>
            <CardHeader title="Detection rate" icon="activity" subtitle="Findings per day, last 30 days" />
            <CardBody>
              {m.trend.some((t) => t.count) ? (
                <ColumnChart data={m.trend.map((t) => ({ label: t.label, value: t.count }))} />
              ) : (
                <EmptyState icon="activity" compact title="No recent detections" description="Nothing was flagged in the last 30 days." />
              )}
            </CardBody>
          </Card>
        </div>
      </section>

      {/* ---------- Leaderboard ---------- */}
      <section className="section">
        <SectionHeader
          title="Top opportunities"
          icon="zap"
          description="Highest-value resources still waiting on a decision"
        />
        <Card>
          {m.topOpportunities.length ? (
            <Table>
              <TableHead>
                <TableRow>
                  <TableHeaderCell>Resource</TableHeaderCell>
                  <TableHeaderCell>Type</TableHeaderCell>
                  <TableHeaderCell>Status</TableHeaderCell>
                  <TableHeaderCell>AI call</TableHeaderCell>
                  <TableHeaderCell>Region</TableHeaderCell>
                  <TableHeaderCell align="right">Monthly</TableHeaderCell>
                  <TableHeaderCell align="right">Annual</TableHeaderCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {m.topOpportunities.map((f) => (
                  <TableRow key={f.finding_id}>
                    <TableCell strong>
                      <div className="resource-cell">
                        <span className="resource-icon">
                          <ResourceIcon type={f.resource_type} size={14} />
                        </span>
                        <span className="resource-name">{f.resource_id}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge tone={TONE_BY_TYPE[f.resource_type] || 'neutral'} mono>
                        {f.resource_type}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <Badge tone={f.status === STATUS.PENDING_APPROVAL ? 'warn' : 'ai'} dot>
                        {f.status === STATUS.PENDING_APPROVAL ? 'awaiting review' : 'enriching'}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      {f.enrichment?.recommendation ? (
                        <Badge tone={f.enrichment.recommendation === 'delete' ? 'danger' : f.enrichment.recommendation === 'keep' ? 'success' : 'warn'}>
                          {f.enrichment.recommendation} · {pct(f.enrichment.confidence, 0)}
                        </Badge>
                      ) : (
                        <span className="t-xs t-muted">—</span>
                      )}
                    </TableCell>
                    <TableCell className="num">{f.region}</TableCell>
                    <TableCell align="right">
                      <Money amount={f.monthly_cost_usd} />
                    </TableCell>
                    <TableCell align="right">
                      <Money amount={(Number(f.monthly_cost_usd) || 0) * 12} tone="success" />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          ) : (
            <EmptyState
              icon="checkCircle"
              title="Nothing waiting on you"
              description="Every identified resource has been decided. New findings will appear here after the next daily scan."
            />
          )}
        </Card>
      </section>
    </div>
  );
};
