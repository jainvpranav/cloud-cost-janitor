import React, { useState, useEffect } from 'react';
import { approvalsApi, findingsApi, teardownApi } from '../api/client';
import { ApprovalCard } from '../components/FindingCard';
import { Button, Card, CardHeader, CardBody, Alert, EmptyState, Badge } from '../components/UI';
import { formatDistanceToNow } from 'date-fns';

export const Approvals = () => {
  const [approvals, setApprovals] = useState([]);
  const [findings, setFindings] = useState({});
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState({});

  useEffect(() => {
    loadApprovals();
  }, []);

  const loadApprovals = async () => {
    setLoading(true);
    try {
      const response = await approvalsApi.list({ status: 'PENDING', limit: 50 });
      const approvalsData = response.data.items || [];
      setApprovals(approvalsData);

      const findingIds = [...new Set(approvalsData.map(a => a.finding_id))];
      const findingPromises = findingIds.map(id => findingsApi.get(id));
      const findingResponses = await Promise.all(findingPromises);
      const findingsMap = {};
      findingResponses.forEach(res => {
        if (res.data) findingsMap[res.data.finding_id] = res.data;
      });
      setFindings(findingsMap);
    } catch (err) {
      console.error('Failed to load approvals:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleVote = async (approvalId, decision) => {
    try {
      await approvalsApi.vote(approvalId, decision, 'current-user');
      loadApprovals();
    } catch (err) {
      console.error('Vote failed:', err);
    }
  };

  const handleTeardown = async (approvalId, dryRun) => {
    setTriggering(prev => ({ ...prev, [approvalId]: true }));
    try {
      await teardownApi.trigger(approvalId, dryRun);
      loadApprovals();
    } catch (err) {
      console.error('Teardown failed:', err);
    } finally {
      setTriggering(prev => ({ ...prev, [approvalId]: false }));
    }
  };

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <h1 className="page-title">Approval Queue</h1>
          <p className="page-subtitle">Review and approve resource teardowns</p>
        </div>
        <Button variant="secondary" onClick={loadApprovals} disabled={loading}>
          Refresh
        </Button>
      </div>

      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px' }}>Loading approvals...</div>
      ) : approvals.length === 0 ? (
        <EmptyState
          icon="✅"
          title="All caught up!"
          description="No pending approvals at this time"
        />
      ) : (
        <div style={{ display: 'grid', gap: '16px' }}>
          {approvals.map((approval) => {
            const finding = findings[approval.finding_id];
            return (
              <ApprovalCard
                key={approval.approval_id}
                approval={approval}
                finding={finding}
                onVote={handleVote}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};