import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { Icon, ResourceIcon } from '../components/Icons';
import { PageHeader } from '../components/Layout';
import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  EmptyState,
  Modal,
  Money,
  SearchInput,
  SkeletonRows,
  StatusBadge,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tabs,
  Metric,
} from '../components/UI';
import { useFindings } from '../hooks/useApi';
import { computeMetrics, STATUS } from '../lib/metrics';
import { money, num, relativeTime, shortDate } from '../lib/format';

const TONE_BY_TYPE = { EC2: 'info', EBS: 'success', ELB: 'brand', ASG: 'ai' };

const TABS = [
  { id: 'all', label: 'All' },
  { id: STATUS.PENDING_ENRICHMENT, label: 'Enriching' },
  { id: STATUS.PENDING_APPROVAL, label: 'Awaiting review' },
  { id: STATUS.APPROVED, label: 'Approved' },
  { id: STATUS.TEARDOWN_COMPLETE, label: 'Reclaimed' },
  { id: STATUS.REJECTED, label: 'Rejected' },
];

const COLUMNS = [
  { key: 'resource_id', label: 'Resource', sortable: true },
  { key: 'resource_type', label: 'Type', sortable: true },
  { key: 'status', label: 'Status', sortable: true },
  { key: 'recommendation', label: 'AI call', sortable: true },
  { key: 'risk_assessment', label: 'Risk', sortable: true },
  { key: 'region', label: 'Region', sortable: true },
  { key: 'account_id', label: 'Account', sortable: true },
  { key: 'monthly_cost_usd', label: 'Monthly', sortable: true, align: 'right' },
  { key: 'annual', label: 'Annual', sortable: true, align: 'right' },
  { key: 'detected_at', label: 'Detected', sortable: true, align: 'right' },
];

export const Findings = () => {
  const navigate = useNavigate();
  const { findings, loading, loadingMore, error, hasMore, refetch, loadMore, fetchedAt } = useFindings({ limit: 500, pollMs: 5000 });

  const [tab, setTab] = useState('all');
  const [query, setQuery] = useState('');
  const [type, setType] = useState('all');
  const [sort, setSort] = useState({ key: 'monthly_cost_usd', dir: 'desc' });
  const [detail, setDetail] = useState(null);

  const m = useMemo(() => computeMetrics(findings), [findings]);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    const out = findings.filter((f) => {
      if (tab !== 'all' && f.status !== tab) return false;
      if (type !== 'all' && f.resource_type !== type) return false;
      if (!q) return true;
      return (
        String(f.resource_id).toLowerCase().includes(q) ||
        String(f.region).toLowerCase().includes(q) ||
        String(f.account_id).toLowerCase().includes(q)
      );
    });

    const pick = (f) => {
      switch (sort.key) {
        case 'resource_id':
          return String(f.resource_id);
        case 'resource_type':
          return String(f.resource_type);
        case 'status':
          return String(f.status);
        case 'recommendation':
          return String(f.enrichment?.recommendation || 'zzz');
        case 'risk_assessment':
          return String(f.enrichment?.risk_assessment || 'zzz');
        case 'region':
          return String(f.region || '');
        case 'account_id':
          return String(f.account_id || '');
        case 'annual':
          return (Number(f.monthly_cost_usd) || 0) * 12;
        case 'detected_at':
          return new Date(f.detected_at || 0).getTime() || 0;
        default:
          return Number(f.monthly_cost_usd) || 0;
      }
    };

    return out.sort((a, b) => {
      const x = pick(a);
      const y = pick(b);
      const cmp = typeof x === 'string' ? x.localeCompare(y) : x - y;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [findings, tab, type, query, sort]);

  const visibleTotal = rows.reduce((a, f) => a + (Number(f.monthly_cost_usd) || 0), 0);

  const onSort = (key) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'desc' }));

  const tabs = TABS.map((t) => ({ ...t, count: t.id === 'all' ? findings.length : m.counts[t.id] || 0 }));

  if (loading && !findings.length) {
    return (
      <div className="app-body">
        <PageHeader title="Findings" subtitle="Loading…" />
        <Card>
          <CardBody>
            <SkeletonRows rows={10} cols={7} />
          </CardBody>
        </Card>
      </div>
    );
  }

  return (
    <div className="app-body">
      <PageHeader
        eyebrow={
          <>
            <Icon name="list" size={12} />
            {fetchedAt ? `Updated ${relativeTime(fetchedAt)}` : 'Live'}
          </>
        }
        title="Findings"
        subtitle="Every resource the scanner has identified, with the evidence and the model's call attached."
        actions={
          <>
            <Button variant="secondary" icon="download" onClick={() => exportCsv(rows)}>
              Export CSV
            </Button>
            <Button variant="primary" icon="refresh" onClick={refetch} loading={loading}>
              Refresh
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="error" title="Could not load findings">
          {error}
        </Alert>
      ) : null}

      <section className="section">
        <Card>
          <div className="card-body tight">
            <div className="grid grid-4" style={{ gap: 'var(--s-8)' }}>
              <Metric label="Matching" value={num(rows.length)} hint={`of ${num(findings.length)} loaded`} />
              <Metric
                label="Monthly value"
                value={money(visibleTotal, { compact: true })}
                tone="success"
                hint="for the current filter"
              />
              <Metric label="Annualised" value={money(visibleTotal * 12, { compact: true })} tone="success" />
              <Metric
                label="Regions"
                value={num(new Set(rows.map((f) => f.region)).size)}
                hint={num(new Set(rows.map((f) => f.account_id)).size) + ' account(s)'}
              />
            </div>
          </div>
        </Card>
      </section>

      <section className="section">
        <Card>
          <div className="card-header" style={{ flexWrap: 'wrap', rowGap: 'var(--s-6)' }}>
            <Tabs tabs={tabs} activeTab={tab} onChange={setTab} />
            <div className="row row-5 row-wrap">
              <div style={{ width: 220 }}>
                <SearchInput value={query} onChange={setQuery} placeholder="Filter resources…" />
              </div>
              <div className="segmented">
                {['all', 'EC2', 'EBS', 'ELB'].map((t) => (
                  <button
                    key={t}
                    className={type === t ? 'active' : ''}
                    onClick={() => setType(t)}
                    aria-pressed={type === t}
                  >
                    {t === 'all' ? 'All types' : t}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <CardBody flush>
            {rows.length === 0 ? (
              <EmptyState
                icon={query || type !== 'all' ? 'search' : 'inbox'}
                title="No findings match"
                description="Adjust the status, type or text filter to widen the search."
              >
                <Button
                  variant="secondary"
                  size="sm"
                  icon="close"
                  onClick={() => {
                    setQuery('');
                    setType('all');
                    setTab('all');
                  }}
                >
                  Reset filters
                </Button>
              </EmptyState>
            ) : (
              <Table>
                <TableHead>
                  <TableRow>
                    {COLUMNS.map((c) => (
                      <TableHeaderCell
                        key={c.key}
                        align={c.align}
                        sortable
                        sorted={sort.key === c.key ? sort.dir : null}
                        onSort={() => onSort(c.key)}
                      >
                        {c.label}
                      </TableHeaderCell>
                    ))}
                  </TableRow>
                </TableHead>
                <TableBody>
                  {rows.map((f) => (
                    <tr key={f.finding_id} className="clickable" onClick={() => setDetail(f)}>
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
                        <StatusBadge status={f.status} />
                      </TableCell>
                      <TableCell>
                        {f.enrichment?.recommendation ? (
                          <Badge
                            tone={
                              f.enrichment.recommendation === 'delete'
                                ? 'danger'
                                : f.enrichment.recommendation === 'keep'
                                  ? 'success'
                                  : 'warn'
                            }
                          >
                            {f.enrichment.recommendation}
                          </Badge>
                        ) : (
                          <span className="t-xs t-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell>
                        {f.enrichment?.risk_assessment ? (
                          <Badge
                            tone={
                              f.enrichment.risk_assessment === 'high'
                                ? 'danger'
                                : f.enrichment.risk_assessment === 'medium'
                                  ? 'warn'
                                  : 'success'
                            }
                          >
                            {f.enrichment.risk_assessment}
                          </Badge>
                        ) : (
                          <span className="t-xs t-muted">—</span>
                        )}
                      </TableCell>
                      <TableCell className="num">{f.region}</TableCell>
                      <TableCell className="num">{f.account_id || '—'}</TableCell>
                      <TableCell align="right">
                        <Money amount={f.monthly_cost_usd} />
                      </TableCell>
                      <TableCell align="right">
                        <Money amount={(Number(f.monthly_cost_usd) || 0) * 12} tone="success" />
                      </TableCell>
                      <TableCell align="right" className="num t-muted">
                        {shortDate(f.detected_at)}
                      </TableCell>
                    </tr>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardBody>

          {hasMore ? (
            <div className="row row-end" style={{ padding: 'var(--s-6) var(--s-8)', borderTop: '1px solid var(--border-soft)' }}>
              <Button variant="secondary" size="sm" icon="refresh" onClick={loadMore} loading={loadingMore}>
                Load 50 more
              </Button>
            </div>
          ) : null}
        </Card>
      </section>

      <Modal
        isOpen={Boolean(detail)}
        onClose={() => setDetail(null)}
        size="lg"
        title={detail ? `${detail.resource_type} ${detail.resource_id}` : ''}
        subtitle={detail ? `Detected ${shortDate(detail.detected_at)} · ${relativeTime(detail.detected_at)}` : ''}
        footer={
          <>
            {detail?.status === STATUS.PENDING_APPROVAL ? (
              <Button variant="primary" icon="inbox" onClick={() => navigate('/approvals')}>
                Go to approval queue
              </Button>
            ) : null}
            <div className="spacer" />
            <Button variant="ghost" onClick={() => setDetail(null)}>
              Close
            </Button>
          </>
        }
      >
        {detail ? <FindingDetail finding={detail} /> : null}
      </Modal>
    </div>
  );
}

function FindingDetail({ finding }) {
  const e = finding.evidence || {};
  const cost = Number(finding.monthly_cost_usd) || 0;
  return (
    <div className="stack stack-7">
      <div className="row row-5 row-wrap">
        <StatusBadge status={finding.status} size="lg" />
        {finding.enrichment?.recommendation ? (
          <Badge tone="neutral" size="lg">
            {finding.enrichment.recommendation}
          </Badge>
        ) : null}
        <Badge tone="neutral" mono>
          {finding.finding_id}
        </Badge>
      </div>

      <div className="grid grid-3" style={{ gap: 'var(--s-6)' }}>
        <Metric label="Monthly" value={money(cost)} />
        <Metric label="Annualised" value={money(cost * 12)} tone="success" />
        <Metric label="Region" value={finding.region} hint={finding.account_id || 'current account'} />
      </div>

      {finding.enrichment?.reasoning ? (
        <div className="ai-panel">
          <div className="ai-panel-head">
            <Icon name="sparkles" size={13} />
            AI assessment
          </div>
          <p className="ai-reasoning">{finding.enrichment.reasoning}</p>
          {finding.enrichment.suggested_action ? (
            <p className="t-sm t-dim" style={{ marginTop: 8 }}>
              <strong className="t-medium">Suggested action:</strong> {finding.enrichment.suggested_action}
            </p>
          ) : null}
        </div>
      ) : null}

      <div>
        <div className="t-upper t-muted" style={{ marginBottom: 6 }}>
          Evidence
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

      {Object.keys(finding.tags || {}).length ? (
        <div>
          <div className="t-upper t-muted" style={{ marginBottom: 6 }}>
            Tags
          </div>
          <div className="row row-4 row-wrap">
            {Object.entries(finding.tags).map(([k, v]) => (
              <span className="chip" key={k}>
                <span className="k">{k}</span>
                <span className="v">{v}</span>
              </span>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function exportCsv(rows) {
  const header = [
    'finding_id',
    'resource_type',
    'resource_id',
    'region',
    'account_id',
    'status',
    'monthly_cost_usd',
    'annual_cost_usd',
    'recommendation',
    'risk_assessment',
    'confidence',
    'detected_at',
  ];
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((f) =>
    [
      f.finding_id,
      f.resource_type,
      f.resource_id,
      f.region,
      f.account_id,
      f.status,
      f.monthly_cost_usd ?? 0,
      (Number(f.monthly_cost_usd) || 0) * 12,
      f.enrichment?.recommendation ?? '',
      f.enrichment?.risk_assessment ?? '',
      f.enrichment?.confidence ?? '',
      f.detected_at,
    ]
      .map(esc)
      .join(',')
  );
  const blob = new Blob([[header.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cost-janitor-findings-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
