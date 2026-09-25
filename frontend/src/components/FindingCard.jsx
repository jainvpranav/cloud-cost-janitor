import React from 'react';
import { formatDistanceToNow } from 'date-fns';
import { Badge, Cost, Card, CardBody, Button, Alert } from './UI';
import { approvalsApi } from '../api/client';

export const FindingCard = ({ finding, onApprove, onReject }) => {
  const enrichment = finding.enrichment || {};
  const evidence = finding.evidence || {};
  const tags = finding.tags || {};

  const getRiskVariant = (risk) => {
    if (risk === 'low') return 'low';
    if (risk === 'high') return 'high';
    return 'medium';
  };

  return (
    <Card className="finding-card">
      <CardBody>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
              <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)' }}>
                {finding.resource_type} {finding.resource_id}
              </span>
              <Badge variant={finding.status.toLowerCase().replace('_', '-')}>{finding.status}</Badge>
              {enrichment.recommendation && (
                <Badge variant={enrichment.recommendation === 'delete' ? 'danger' : enrichment.recommendation === 'keep' ? 'success' : 'warning'}>
                  {enrichment.recommendation}
                </Badge>
              )}
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              {finding.region} • Detected {formatDistanceToNow(new Date(finding.detected_at), { addSuffix: true })}
            </div>
          </div>
          <Cost amount={finding.monthly_cost_usd || 0} />
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '16px', marginBottom: '16px' }}>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Instance Type</div>
            <div style={{ fontWeight: 500 }}>{evidence.instance_type || evidence.volume_type || evidence.load_balancer_type || 'N/A'}</div>
          </div>
          <div>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>State</div>
            <div style={{ fontWeight: 500 }}>{evidence.state || 'N/A'}</div>
          </div>
          {evidence.cpu_avg_24h !== undefined && (
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Avg CPU (24h)</div>
              <div style={{ fontWeight: 500 }}>{evidence.cpu_avg_24h.toFixed(1)}%</div>
            </div>
          )}
          {evidence.age_days !== undefined && (
            <div>
              <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '4px' }}>Age</div>
              <div style={{ fontWeight: 500 }}>{evidence.age_days} days</div>
            </div>
          )}
        </div>

        {enrichment.reasoning && (
          <Alert variant="info" style={{ marginBottom: '16px', fontSize: '13px' }}>
            <strong>AI Analysis:</strong> {enrichment.reasoning}
          </Alert>
        )}

        {enrichment.suggested_action && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg)', borderRadius: 'var(--radius)', fontSize: '13px' }}>
            <strong>Suggested Action:</strong> {enrichment.suggested_action}
          </div>
        )}

        {Object.keys(tags).length > 0 && (
          <div style={{ marginBottom: '16px' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px' }}>Tags</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px' }}>
              {Object.entries(tags).map(([k, v]) => (
                <span key={k} style={{ fontSize: '11px', padding: '2px 8px', background: 'var(--bg)', borderRadius: '4px' }}>
                  {k}: {v}
                </span>
              ))}
            </div>
          </div>
        )}

        <div style={{ display: 'flex', gap: '8px', paddingTop: '16px', borderTop: '1px solid var(--border)' }}>
          <Button variant="success" size="sm" onClick={() => onApprove(finding.finding_id)}>
            Approve Teardown
          </Button>
          <Button variant="danger" size="sm" onClick={() => onReject(finding.finding_id)}>
            Reject
          </Button>
          <Button variant="secondary" size="sm" onClick={() => window.open(`/approvals/${finding.finding_id}`, '_blank')}>
            View Details
          </Button>
        </div>
      </CardBody>
    </Card>
  );
};

export const ApprovalCard = ({ approval, finding, onVote }) => {
  const enrichment = finding?.enrichment || {};
  const evidence = finding?.evidence || {};
  const votes = approval.votes || [];
  const approveVotes = votes.filter(v => v.decision === 'approve').length;
  const rejectVotes = votes.filter(v => v.decision === 'reject').length;
  const canVote = approval.status === 'PENDING';
  const currentUser = 'current-user'; // In real app, get from auth

  const hasUserVoted = votes.some(v => v.user === currentUser);

  return (
    <Card className="approval-card">
      <CardBody>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '16px' }}>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px', flexWrap: 'wrap' }}>
              <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--primary)' }}>
                {finding?.resource_type} {finding?.resource_id}
              </span>
              <Badge variant={approval.status.toLowerCase()}>{approval.status}</Badge>
              {enrichment.recommendation && (
                <Badge variant={enrichment.recommendation === 'delete' ? 'danger' : enrichment.recommendation === 'keep' ? 'success' : 'warning'}>
                  {enrichment.recommendation}
                </Badge>
              )}
              <Badge variant={getRiskVariant(enrichment.risk_assessment)}>{enrichment.risk_assessment || 'unknown'} risk</Badge>
            </div>
            <div style={{ color: 'var(--text-muted)', fontSize: '13px' }}>
              {finding?.region} • ${finding?.monthly_cost_usd?.toFixed(2)}/mo • {approval.required_approvals} approval(s) required
            </div>
          </div>
          <Cost amount={finding?.monthly_cost_usd || 0} />
        </div>

        <div className="vote-count">
          Votes: {approveVotes} approve / {rejectVotes} reject ({approval.required_approvals} needed)
        </div>

        {votes.length > 0 && (
          <div style={{ marginBottom: '16px', fontSize: '13px' }}>
            {votes.map((vote, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '8px', padding: '4px 0' }}>
                <Badge variant={vote.decision === 'approve' ? 'success' : 'danger'} style={{ fontSize: '10px' }}>
                  {vote.decision}
                </Badge>
                <span>{vote.user}</span>
                <span style={{ color: 'var(--text-muted)' }}>{formatDistanceToNow(new Date(vote.at), { addSuffix: true })}</span>
              </div>
            ))}
          </div>
        )}

        {enrichment.reasoning && (
          <Alert variant="info" style={{ marginBottom: '16px', fontSize: '13px' }}>
            <strong>AI Recommendation:</strong> {enrichment.reasoning}
          </Alert>
        )}

        {enrichment.suggested_action && (
          <div style={{ marginBottom: '16px', padding: '12px', background: 'var(--bg)', borderRadius: 'var(--radius)', fontSize: '13px' }}>
            <strong>Action:</strong> {enrichment.suggested_action}
          </div>
        )}

        {canVote && !hasUserVoted && (
          <div className="vote-buttons">
            <Button variant="success" onClick={() => onVote(approval.approval_id, 'approve')}>
              ✓ Approve
            </Button>
            <Button variant="danger" onClick={() => onVote(approval.approval_id, 'reject')}>
              ✗ Reject
            </Button>
          </div>
        )}

        {!canVote && (
          <Alert variant={approval.status === 'APPROVED' ? 'success' : 'warning'}>
            {approval.status === 'APPROVED' ? 'Ready for teardown' : approval.status === 'REJECTED' ? 'Rejected by team' : 'Expired'}
          </Alert>
        )}
      </CardBody>
    </Card>
  );
};

function getRiskVariant(risk) {
  if (risk === 'low') return 'low';
  if (risk === 'high') return 'high';
  return 'medium';
}