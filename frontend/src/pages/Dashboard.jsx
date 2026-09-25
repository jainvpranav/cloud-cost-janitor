import React, { useState, useEffect } from 'react';
import { findingsApi, approvalsApi } from '../api/client';
import { FindingCard } from '../components/FindingCard';
import { Button, Card, CardHeader, CardBody, Badge, Cost, Alert, EmptyState, Tabs } from '../components/UI';
import { formatDistanceToNow } from 'date-fns';

export const Dashboard = () => {
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState('all');
  const [lastKey, setLastKey] = useState(null);
  const [hasMore, setHasMore] = useState(true);

  const tabs = [
    { id: 'all', label: 'All' },
    { id: 'PENDING_ENRICHMENT', label: 'Pending Enrichment' },
    { id: 'PENDING_APPROVAL', label: 'Pending Approval' },
    { id: 'APPROVED', label: 'Approved' },
    { id: 'REJECTED', label: 'Rejected' },
    { id: 'TEARDOWN_COMPLETE', label: 'Completed' },
  ];

  useEffect(() => {
    loadFindings();
  }, [activeTab]);

  const loadFindings = async (append = false) => {
    setLoading(true);
    try {
      const params = { limit: 50 };
      if (activeTab !== 'all') params.status = activeTab;
      if (append && lastKey) params.last_key = JSON.stringify(lastKey);

      const response = await findingsApi.list(params);
      const newFindings = response.data.items || [];
      setFindings(append ? [...findings, ...newFindings] : newFindings);
      setLastKey(response.data.last_key);
      setHasMore(!!response.data.last_key);
    } catch (err) {
      console.error('Failed to load findings:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleApprove = async (findingId) => {
    try {
      const approvalRes = await approvalsApi.list({ finding_id: findingId });
      const approval = approvalRes.data.items?.[0];
      if (approval) {
        await approvalsApi.vote(approval.approval_id, 'approve', 'current-user');
        loadFindings();
      }
    } catch (err) {
      console.error('Approve failed:', err);
    }
  };

  const handleReject = async (findingId) => {
    try {
      const approvalRes = await approvalsApi.list({ finding_id: findingId });
      const approval = approvalRes.data.items?.[0];
      if (approval) {
        await approvalsApi.vote(approval.approval_id, 'reject', 'current-user');
        loadFindings();
      }
    } catch (err) {
      console.error('Reject failed:', err);
    }
  };

  const totalMonthlySavings = findings
    .filter(f => ['APPROVED', 'TEARDOWN_COMPLETE'].includes(f.status))
    .reduce((sum, f) => sum + (f.monthly_cost_usd || 0), 0);

  const pendingMonthlyCost = findings
    .filter(f => ['PENDING_APPROVAL', 'PENDING_ENRICHMENT'].includes(f.status))
    .reduce((sum, f) => sum + (f.monthly_cost_usd || 0), 0);

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Cloud Cost Janitor</h1>
          <p className="page-subtitle">Find and eliminate idle AWS resources</p>
        </div>
        <div style={{ display: 'flex', gap: '16px', alignItems: 'center' }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Potential Monthly Savings</div>
            <Cost amount={pendingMonthlyCost} />
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: '12px', color: 'var(--text-muted)' }}>Realized Monthly Savings</div>
            <Cost amount={totalMonthlySavings} />
          </div>
        </div>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>Loading...</div>
      ) : findings.length === 0 ? (
        <EmptyState
          icon="🔍"
          title="No findings"
          description={activeTab === 'all' ? 'Run a scan to discover idle resources' : `No findings with status ${activeTab}`}
        />
      ) : (
        <>
          <div style={{ display: 'grid', gap: '16px' }}>
            {findings.map((finding) => (
              <FindingCard
                key={finding.finding_id}
                finding={finding}
                onApprove={handleApprove}
                onReject={handleReject}
              />
            ))}
          </div>

          {hasMore && (
            <div style={{ textAlign: 'center', marginTop: '24px' }}>
              <Button variant="secondary" onClick={() => loadFindings(true)} disabled={loading}>
                Load More
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  );
};