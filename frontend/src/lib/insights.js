/**
 * Turns the metrics object into a ranked list of human-readable observations.
 *
 * Rules of thumb:
 *  - only surface an insight when the numbers actually justify it
 *  - always attach the number, so the claim is checkable
 *  - severity drives colour: critical > high > medium > low, plus `positive`
 */

import { money, num, pct, hoursSince } from './format';

const pctOf = (part, whole) => (whole > 0 ? part / whole : 0);

export function buildInsights(m) {
  const out = [];
  const push = (i) => out.push(i);

  // 1. Nothing to do at all.
  if (m.total === 0) {
    push({
      id: 'empty',
      severity: 'low',
      icon: 'search',
      title: 'No findings yet',
      text: 'The scanner has not produced any findings. Confirm the EventBridge schedule is enabled and that the scanner Lambda is completing without errors.',
    });
    return out;
  }

  // 2. Money already banked.
  if (m.realizedMonthly > 0) {
    push({
      id: 'realized',
      severity: 'positive',
      icon: 'trendingUp',
      title: `${money(m.realizedAnnual)} annualised savings captured`,
      text: `${num(m.realizedCount)} resource${m.realizedCount === 1 ? '' : 's'} reclaimed so far, averaging ${money(m.realizedMonthly / Math.max(1, m.realizedCount))} per month each.`,
      value: `${money(m.realizedMonthly)}/mo`,
    });
  }

  // 3. Approval is the bottleneck, not detection.
  if (m.pendingApprovalCount > 0 && m.realizedCount === 0) {
    push({
      id: 'no-realization',
      severity: 'high',
      icon: 'hourglass',
      title: `${money(m.pendingAnnual)} of savings is stuck at the approval step`,
      text: `All ${num(m.decidedCount)} decided requests have been rejected and none have reached teardown. Treat this as a process problem: reviewers are not aligned with the AI recommendations.`,
      value: `${money(m.pendingAnnual)}/yr`,
    });
  }

  // 4. Queue is ageing past SLA.
  if (m.staleCount > 0) {
    const oldest = m.staleInFlight[0];
    const value = m.staleInFlight.reduce((a, x) => a + (x.finding.monthly_cost_usd || 0), 0);
    push({
      id: 'stale-queue',
      severity: m.staleCount > 5 ? 'critical' : 'high',
      icon: 'clock',
      title: `${num(m.staleCount)} finding${m.staleCount === 1 ? ' has' : 's have'} waited over 72 hours`,
      text: `The oldest has been queued for ${num(hoursSince(oldest.finding.detected_at) / 24, { decimals: 1 })} days. Idle resources keep billing for as long as they sit in the queue — ${money(value)}/mo is being spent on ${money(value)} of confirmed waste.`,
      value: money(value),
    });
  }

  // 5. Concentration: a small number of resources is most of the bill.
  if (m.byType.length >= 2) {
    const [top, second] = m.byType;
    const share = pctOf(top.monthly, m.byType.reduce((a, b) => a + b.monthly, 0));
    if (share >= 0.5) {
      const typeName = top.key === 'ELB' ? 'load balancers' : top.key === 'EBS' ? 'volumes' : 'instances';
      push({
        id: 'concentration-type',
        severity: share >= 0.8 ? 'high' : 'medium',
        icon: 'pieChart',
        title: `${pct(share, 0)} of identified spend sits in ${num(top.count)} ${top.key} ${typeName}`,
        text: `${top.key} alone accounts for ${money(top.monthly)}/mo, compared with ${money(second.monthly)}/mo for ${second.key}. Fixing this one resource class clears the majority of the backlog.`,
        value: money(top.monthly),
      });
    }
  }

  // 6. Region concentration.
  if (m.byRegion.length >= 2) {
    const total = m.byRegion.reduce((a, b) => a + b.monthly, 0);
    const share = pctOf(m.byRegion[0].monthly, total);
    if (share >= 0.7 && m.byRegion[0].key) {
      push({
        id: 'concentration-region',
        severity: 'medium',
        icon: 'globe',
        title: `${m.byRegion[0].key} carries ${pct(share, 0)} of the recoverable spend`,
        text: `${money(m.byRegion[0].monthly)}/mo across ${num(m.byRegion[0].count)} resources. A region-scoped cleanup would be the shortest path to savings.`,
        value: money(m.byRegion[0].monthly),
      });
    }
  }

  // 7. AI trust calibration — the most actionable insight in the product.
  if (m.deleteCallsTotal >= 2 && m.deletePrecision !== null) {
    const p = m.deletePrecision;
    push({
      id: 'ai-precision',
      severity: p >= 0.7 ? 'positive' : p >= 0.4 ? 'medium' : 'high',
      icon: 'sparkles',
      title: `Reviewers uphold ${pct(p, 0)} of AI “delete” recommendations`,
      text:
        p >= 0.7
          ? 'The model is well calibrated against human judgement. Low-confidence findings can be auto-approved and the review queue shrunk accordingly.'
          : p >= 0.4
            ? 'Agreement is mixed. Keep mandatory review above 80% confidence and send the remainder straight to manual triage.'
            : 'Reviewers are overriding most teardown calls. Do not raise the auto-approve threshold — fix the detection rules or the prompt first.',
      value: pct(p, 0),
    });
  }

  // 8. Compare delete precision against the other recommendation classes.
  const others = m.precision.filter((x) => x.recommendation !== 'delete' && x.total >= 2);
  if (m.deleteCallsTotal >= 3 && others.length) {
    const bestOther = others.reduce((a, b) => (a.rate > b.rate ? a : b));
    if (m.deletePrecision !== null && bestOther.rate - m.deletePrecision > 0.25) {
      push({
        id: 'ai-delta',
        severity: 'medium',
        icon: 'brain',
        title: `“${bestOther.recommendation}” calls are trusted more than “delete”`,
        text: `Reviewers uphold ${pct(bestOther.rate, 0)} of “${bestOther.recommendation}” recommendations versus ${pct(m.deletePrecision, 0)} of “delete”. The prompt is likely over-confident about removals.`,
        value: `+${pct(bestOther.rate - m.deletePrecision, 0)}`,
      });
    }
  }

  // 9. Automation coverage.
  if (m.aiCoverage < 0.6 && m.total >= 5) {
    push({
      id: 'low-coverage',
      severity: 'medium',
      icon: 'cpu',
      title: `Only ${pct(m.aiCoverage, 0)} of findings carry an AI assessment`,
      text: `${num(m.total - m.enrichedCount)} of ${num(m.total)} findings have no recommendation, risk or confidence score. These are the ones most likely to need a human to do the analysis from scratch.`,
      value: pct(m.aiCoverage, 0),
    });
  }

  // 10. Low-confidence cluster.
  const lowConf = m.confidence.buckets.filter((b) => b.hi <= 0.6);
  const lowConfCount = lowConf.reduce((a, b) => a + b.count, 0);
  if (m.total >= 5 && lowConfCount / m.total >= 0.4) {
    const value = lowConf.reduce((a, b) => a + b.monthly, 0);
    push({
      id: 'low-confidence',
      severity: 'medium',
      icon: 'alertTriangle',
      title: `${pct(lowConfCount / m.total, 0)} of findings were scored below 60% confidence`,
      text: `${money(value)}/mo of the opportunity rests on shaky evidence. Inspect the detection thresholds for this resource class before approving bulk teardown.`,
      value: money(value),
    });
  }

  // 11. High-risk items still waiting.
  if (m.highRiskInFlight.length > 0) {
    const value = m.highRiskInFlight.reduce((a, f) => a + (f.monthly_cost_usd || 0), 0);
    push({
      id: 'high-risk',
      severity: m.highRiskInFlight.length >= 3 ? 'high' : 'medium',
      icon: 'shield',
      title: `${num(m.highRiskInFlight.length)} high-risk finding${m.highRiskInFlight.length === 1 ? '' : 's'} in the queue`,
      text: `The model flagged ${money(value)}/mo as risky to remove. ${m.dualApprovalCount > 0 ? `${num(m.dualApprovalCount)} request(s) need two sign-offs before anything is destroyed.` : 'These should need a second reviewer before teardown.'}`,
      value: money(value),
    });
  }

  // 12. Dual-approval tax on the biggest items.
  if (m.dualApprovalCount > 0) {
    push({
      id: 'dual-approval',
      severity: 'low',
      icon: 'users',
      title: `${num(m.dualApprovalCount)} request${m.dualApprovalCount === 1 ? '' : 's'} need two approvals`,
      text: 'Anything above $100/mo crosses the dual-approval guardrail. Make sure a second reviewer is watching the queue, otherwise these sit until they expire.',
      value: `${num(m.dualApprovalCount)}`,
    });
  }

  // 13. Rejected spend — a real number people forget.
  if (m.rejectedMonthly > 0) {
    push({
      id: 'rejected',
      severity: 'medium',
      icon: 'xCircle',
      title: `Reviewers kept ${money(m.rejectedMonthly)}/mo of resources alive`,
      text: `${money(m.wastedOnRejected)} a year of spend was correctly preserved. That is the value of the human gate — treat rejections as signal, not failure, and check whether the detection rule is too aggressive.`,
      value: money(m.rejectedMonthly),
    });
  }

  // 14. Expiring approvals.
  if (m.expiredCount > 0) {
    push({
      id: 'expired',
      severity: 'high',
      icon: 'hourglass',
      title: `${num(m.expiredCount)} approval${m.expiredCount === 1 ? '' : 's'} expired without a decision`,
      text: 'Expired requests stop the pipeline entirely — the findings are never revisited. Shorten the review window or batch the queue into a recurring review meeting.',
      value: `${num(m.expiredCount)}`,
    });
  }

  // 15. Fast lane.
  if (m.approvalRate !== null && m.decidedCount >= 4 && m.approvalRate >= 0.8) {
    push({
      id: 'approval-rate',
      severity: 'positive',
      icon: 'checkCircle',
      title: `${pct(m.approvalRate, 0)} of decided requests were approved`,
      text: `Across ${num(m.decidedCount)} decisions${m.medianDecisionHours ? `, with a median turnaround of ${num(m.medianDecisionHours)} hours` : ''}. The queue is flowing — the constraint is finding volume, not review capacity.`,
      value: pct(m.approvalRate, 0),
    });
  }

  // 16. Median turnaround, when the approval rate is unremarkable.
  if (m.medianDecisionHours && m.decidedCount >= 3 && !(m.approvalRate >= 0.8)) {
    push({
      id: 'turnaround',
      severity: m.medianDecisionHours > 72 ? 'high' : 'low',
      icon: 'clock',
      title: `Median review turnaround is ${num(m.medianDecisionHours)} hours`,
      text:
        m.medianDecisionHours > 72
          ? 'Most decisions take longer than the 72-hour staleness window, so the queue is effectively always stale. Route approvals as they arrive rather than in a weekly batch.'
          : 'Decisions land within the staleness window. Consider lowering the auto-approve confidence threshold to lift throughput further.',
      value: `${num(m.medianDecisionHours)}h`,
    });
  }

  // 17. Opportunity headline when nothing is wrong.
  if (m.addressableMonthly > 0 && out.filter((i) => i.severity === 'critical' || i.severity === 'high').length === 0) {
    push({
      id: 'opportunity',
      severity: 'low',
      icon: 'target',
      title: `${money(m.addressableAnnual)}/yr is recoverable and unblocked`,
      text: `${num(m.openCount)} resources worth ${money(m.addressableMonthly)}/mo are waiting on a decision, with no risk flags or ageing problems outstanding.`,
      value: money(m.addressableAnnual),
    });
  }

  const rank = { critical: 0, high: 1, medium: 2, low: 3, positive: 4 };
  return out.sort((a, b) => (rank[a.severity] ?? 9) - (rank[b.severity] ?? 9));
}

export const SEVERITY_META = {
  critical: { label: 'Critical', tone: 'critical', icon: 'alertCircle' },
  high: { label: 'Needs attention', tone: 'high', icon: 'alertTriangle' },
  medium: { label: 'Watch', tone: 'medium', icon: 'info' },
  low: { label: 'Informational', tone: 'low', icon: 'minus' },
  positive: { label: 'Good', tone: 'positive', icon: 'checkCircle' },
};
