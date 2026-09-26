/**
 * KPI / insight computation.
 *
 * Everything here is derived client-side from the findings and approvals the
 * API already returns, so the numbers on screen always match the rows below
 * them (no second, disagreeing aggregate endpoint).
 */

import { ageInDays, hoursSince, sum } from './format';

export const STATUS = {
  PENDING_ENRICHMENT: 'PENDING_ENRICHMENT',
  PENDING_APPROVAL: 'PENDING_APPROVAL',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  TEARDOWN_IN_PROGRESS: 'TEARDOWN_IN_PROGRESS',
  TEARDOWN_COMPLETE: 'TEARDOWN_COMPLETE',
  SKIPPED_NOW_ACTIVE: 'SKIPPED_NOW_ACTIVE',
  RESOURCE_GONE: 'RESOURCE_GONE',
  EXPIRED: 'EXPIRED',
};

export const STATUS_META = {
  PENDING_ENRICHMENT: { label: 'Detected', tone: 'ai', step: 1 },
  PENDING_APPROVAL: { label: 'Awaiting review', tone: 'warn', step: 2 },
  APPROVED: { label: 'Approved', tone: 'brand', step: 3 },
  REJECTED: { label: 'Rejected', tone: 'danger', step: 4 },
  TEARDOWN_IN_PROGRESS: { label: 'Deleting', tone: 'info', step: 4 },
  TEARDOWN_COMPLETE: { label: 'Reclaimed', tone: 'success', step: 5 },
  SKIPPED_NOW_ACTIVE: { label: 'Back in use', tone: 'neutral', step: 4 },
  RESOURCE_GONE: { label: 'Already gone', tone: 'neutral', step: 4 },
  EXPIRED: { label: 'Expired', tone: 'neutral', step: 4 },
};

/**
 * Approvals use their own status vocabulary, distinct from findings: the
 * backend writes PENDING/APPROVED/REJECTED on the approvals table
 * (see backend/approval/api.py) while findings use the lifecycle above.
 * Conflating the two silently mis-counts every throughput KPI.
 */
export const APPROVAL_STATUS = {
  PENDING: 'PENDING',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  EXPIRED: 'EXPIRED',
};

export const LIFECYCLE = [
  'PENDING_ENRICHMENT',
  'PENDING_APPROVAL',
  'APPROVED',
  'TEARDOWN_COMPLETE',
];

const REALIZED = [STATUS.APPROVED, STATUS.TEARDOWN_IN_PROGRESS, STATUS.TEARDOWN_COMPLETE];
const IN_FLIGHT = [STATUS.PENDING_ENRICHMENT, STATUS.PENDING_APPROVAL];
const CLOSED = [...REALIZED, STATUS.REJECTED, STATUS.SKIPPED_NOW_ACTIVE, STATUS.RESOURCE_GONE];

const cost = (f) => Number(f?.monthly_cost_usd) || 0;
const ann = (m) => (Number(m) || 0) * 12;

function byStatus(findings) {
  const out = {};
  for (const f of findings) out[f.status] = (out[f.status] || 0) + 1;
  return out;
}

function groupSumBy(findings, keyFn) {
  const map = new Map();
  for (const f of findings) {
    const k = keyFn(f) || 'unknown';
    const cur = map.get(k) || { key: k, count: 0, monthly: 0 };
    cur.count += 1;
    cur.monthly += cost(f);
    map.set(k, cur);
  }
  return [...map.values()].sort((a, b) => b.monthly - a.monthly || b.count - a.count);
}

/** Monthly spend waiting on a human decision. */
function inFlightMonthly(findings) {
  return sum(findings.filter((f) => IN_FLIGHT.includes(f.status)), cost);
}

/** Cost already committed to removal (approved, not yet executed). */
function approvedMonthly(findings) {
  return sum(findings.filter((f) => f.status === STATUS.APPROVED), cost);
}

/** Cost of resources actually torn down. */
function reclaimedMonthly(findings) {
  return sum(findings.filter((f) => f.status === STATUS.TEARDOWN_COMPLETE), cost);
}

function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * How long each decided approval took, in hours.
 * Uses the newest vote timestamp minus creation when no explicit field exists.
 */
function decisionLatencies(approvals) {
  return approvals
    .filter(
      (a) =>
        a.status !== APPROVAL_STATUS.PENDING && (a.votes || []).length > 0 && a.created_at
    )
    .map((a) => {
      const last = [...(a.votes || [])].sort((x, y) => new Date(y.at) - new Date(x.at))[0];
      const h = (new Date(last.at) - new Date(a.created_at)) / 3600000;
      return h >= 0 ? h : null;
    })
    .filter((h) => h !== null);
}

/**
 * Agreement rate between an AI recommendation and the human verdict.
 * This is the honest measure of whether the model can be trusted.
 */
function recommendationPrecision(findings) {
  const decided = findings.filter(
    (f) => CLOSED.includes(f.status) && f.enrichment && f.enrichment.recommendation
  );
  const buckets = new Map();
  for (const f of decided) {
    const rec = f.enrichment.recommendation;
    const cur = buckets.get(rec) || {
      recommendation: rec,
      total: 0,
      upheld: 0,
      monthly: 0,
    };
    cur.total += 1;
    cur.monthly += cost(f);
    // A "delete" call is upheld when the human approved the teardown.
    // Any other call is upheld when the human rejected it (i.e. kept it).
    const upheld =
      rec === 'delete' ? REALIZED.includes(f.status) : f.status === STATUS.REJECTED;
    if (upheld) cur.upheld += 1;
    buckets.set(rec, cur);
  }
  return [...buckets.values()]
    .map((b) => ({ ...b, rate: b.total ? b.upheld / b.total : 0 }))
    .sort((a, b) => b.rate * b.total - a.rate * a.total);
}

function confidenceBuckets(findings) {
  const edges = [0, 0.4, 0.6, 0.8, 0.9, 1.01];
  const labels = ['< 40%', '40–60%', '60–80%', '80–90%', '90%+'];
  const out = labels.map((label, i) => ({
    label,
    key: label,
    count: 0,
    monthly: 0,
    lo: edges[i],
    hi: edges[i + 1],
  }));
  let unclassified = 0;
  for (const f of findings) {
    const c = Number(f.enrichment?.confidence);
    if (!isFinite(c)) {
      unclassified += 1;
      continue;
    }
    const v = c > 1 ? c / 100 : c;
    const bucket = out.find((b) => v >= b.lo && v < b.hi) || out[out.length - 1];
    bucket.count += 1;
    bucket.monthly += cost(f);
  }
  return { buckets: out, unclassified };
}

function agingBuckets(findings) {
  const defs = [
    { key: '0-2d', label: '0–2 days', min: 0, max: 3 },
    { key: '3-7d', label: '3–7 days', min: 3, max: 7 },
    { key: '8-14d', label: '8–14 days', min: 7, max: 14 },
    { key: '15d+', label: '15+ days', min: 14, max: Infinity },
  ];
  return defs.map((d) => {
    const items = findings.filter((f) => {
      const age = ageInDays(f.detected_at) ?? 0;
      return age >= d.min && age < d.max;
    });
    return {
      ...d,
      count: items.length,
      monthly: sum(items, cost),
      ids: items.map((f) => f.finding_id),
    };
  });
}

function riskMix(findings) {
  const map = new Map();
  for (const f of findings) {
    const r = (f.enrichment && f.enrichment.risk_assessment) || 'unknown';
    const cur = map.get(r) || { key: r, count: 0, monthly: 0 };
    cur.count += 1;
    cur.monthly += cost(f);
    map.set(r, cur);
  }
  const order = ['low', 'medium', 'high', 'unknown'];
  return [...map.values()].sort(
    (a, b) => order.indexOf(a.key) - order.indexOf(b.key) || b.count - a.count
  );
}

function recMix(findings) {
  const map = new Map();
  for (const f of findings) {
    const r = (f.enrichment && f.enrichment.recommendation) || 'unclassified';
    const cur = map.get(r) || { key: r, count: 0, monthly: 0 };
    cur.count += 1;
    cur.monthly += cost(f);
    map.set(r, cur);
  }
  return [...map.values()].sort((a, b) => b.monthly - a.monthly);
}

/** Findings detected per day over the trailing window, oldest first. */
function detectionTrend(findings, days = 30) {
  const buckets = new Map();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i -= 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    buckets.set(d.toISOString().slice(0, 10), { date: d, count: 0, monthly: 0 });
  }
  for (const f of findings) {
    const d = new Date(f.detected_at);
    if (isNaN(d.getTime())) continue;
    d.setHours(0, 0, 0, 0);
    const key = d.toISOString().slice(0, 10);
    const b = buckets.get(key);
    if (!b) continue;
    b.count += 1;
    b.monthly += cost(f);
  }
  return [...buckets.values()].map((b) => ({ ...b, label: b.date.toISOString().slice(5, 10) }));
}

/**
 * The single source of truth for every number rendered in the UI.
 *
 * @param {Array} findings  normalized finding records
 * @param {Array} approvals normalized approval records
 */
export function computeMetrics(findings = [], approvals = []) {
  const list = Array.isArray(findings) ? findings : [];
  const aps = Array.isArray(approvals) ? approvals : [];

  const counts = byStatus(list);
  const realizedMonthly = reclaimedMonthly(list);
  const approvedMonthlyTotal = approvedMonthly(list);
  const pendingMonthly = inFlightMonthly(list);
  const rejectedMonthly = sum(list.filter((f) => f.status === STATUS.REJECTED), cost);
  const addressedMonthly = realizedMonthly + pendingMonthly + rejectedMonthly;

  const decided = aps.filter((a) => a.status !== APPROVAL_STATUS.PENDING);
  const approvedCount = aps.filter((a) => a.status === APPROVAL_STATUS.APPROVED).length;
  const rejectedCount = aps.filter((a) => a.status === APPROVAL_STATUS.REJECTED).length;
  const expiredCount = aps.filter((a) => a.status === APPROVAL_STATUS.EXPIRED).length;
  const decidedCount = approvedCount + rejectedCount;
  const latencies = decisionLatencies(aps);
  const pendingAps = aps.filter((a) => a.status === APPROVAL_STATUS.PENDING);

  const enriched = list.filter((f) => f.enrichment && f.enrichment.recommendation);
  const confidences = enriched
    .map((f) => Number(f.enrichment.confidence))
    .filter((c) => isFinite(c))
    .map((c) => (c > 1 ? c / 100 : c));

  const byType = groupSumBy(list, (f) => f.resource_type);
  const byRegion = groupSumBy(list, (f) => f.region);
  const byAccount = groupSumBy(list, (f) => f.account_id);

  const precision = recommendationPrecision(list);
  const deleteCalls = precision.find((p) => p.recommendation === 'delete');
  const conf = confidenceBuckets(list);
  const aging = agingBuckets(list);
  const risks = riskMix(list);
  const recs = recMix(list);
  const trend = detectionTrend(list);

  // Monthly burn for everything still on the table, i.e. the theoretical ceiling.
  const addressableMonthly = pendingMonthly + approvedMonthlyTotal;
  const highValuePending = list
    .filter((f) => IN_FLIGHT.includes(f.status))
    .sort((a, b) => cost(b) - cost(a))
    .slice(0, 8);
  const highRiskInFlight = list
    .filter((f) => IN_FLIGHT.includes(f.status) && f.enrichment?.risk_assessment === 'high')
    .sort((a, b) => cost(b) - cost(a));
  const staleInFlight = list
    .filter((f) => IN_FLIGHT.includes(f.status))
    .map((f) => ({ finding: f, hours: hoursSince(f.detected_at) ?? 0 }))
    .filter((x) => x.hours > 72)
    .sort((a, b) => b.hours - a.hours);

  return {
    // ---- headline money ----
    realizedMonthly,
    realizedAnnual: ann(realizedMonthly),
    approvedMonthly: approvedMonthlyTotal,
    approvedAnnual: ann(approvedMonthly),
    pendingMonthly,
    pendingAnnual: ann(pendingMonthly),
    addressableMonthly,
    addressableAnnual: ann(addressableMonthly),
    rejectedMonthly,
    annualized: ann(addressedMonthly),
    wastedOnRejected: ann(rejectedMonthly),

    // ---- volume ----
    total: list.length,
    counts,
    openCount: list.filter((f) => IN_FLIGHT.includes(f.status)).length,
    realizedCount: list.filter((f) => REALIZED.includes(f.status)).length,
    staleCount: staleInFlight.length,

    // ---- throughput ----
    pendingApprovalCount: pendingAps.length,
    decidedCount,
    approvedCount,
    rejectedCount,
    expiredCount,
    approvalRate: decidedCount ? approvedCount / decidedCount : null,
    medianDecisionHours: median(latencies),
    dualApprovalCount: pendingAps.filter((a) => Number(a.required_approvals) > 1).length,

    // ---- AI quality ----
    enrichedCount: enriched.length,
    aiCoverage: list.length ? enriched.length / list.length : 0,
    avgConfidence: confidences.length
      ? confidences.reduce((a, b) => a + b, 0) / confidences.length
      : null,
    deletePrecision: deleteCalls ? deleteCalls.rate : null,
    deleteCallsTotal: deleteCalls ? deleteCalls.total : 0,
    precision,
    confidence: conf,
    risks,
    recs,

    // ---- breakdowns ----
    byType,
    byRegion,
    byAccount,
    aging,
    trend,

    // ---- ranked lists ----
    topOpportunities: highValuePending,
    highRiskInFlight,
    staleInFlight,
    highConfidenceDeletes: list
      .filter(
        (f) =>
          IN_FLIGHT.includes(f.status) &&
          f.enrichment?.recommendation === 'delete' &&
          Number(f.enrichment?.confidence) >= 0.8
      )
      .sort((a, b) => cost(b) - cost(a)),

    truncated: Boolean(list.__truncated),
  };
}

/** Tone thresholds shared by cost colouring across the app. */
export function costTone(amount) {
  const v = Number(amount) || 0;
  if (v > 100) return 'danger';
  if (v > 30) return 'warn';
  if (v > 0) return 'success';
  return 'muted';
}
