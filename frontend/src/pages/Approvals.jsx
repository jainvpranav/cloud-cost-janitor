import React, { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Icon } from "../components/Icons";
import { PageHeader } from "../components/Layout";
import { ApprovalCard } from "../components/FindingCard";
import {
  Alert,
  Button,
  Card,
  CardBody,
  ConfirmDialog,
  EmptyState,
  Money,
  Segmented,
  SkeletonStats,
  StatTile,
} from "../components/UI";
import { useApprovals, useApprover, useConfig } from "../hooks/useApi";
import { ApproverField, JobStatus } from "../components/Live";
import { approvalsApi, teardownApi, toMessage } from "../api/client";
import { money, num, relativeTime } from "../lib/format";

const SCOPES = [
  { value: "PENDING", label: "Pending" },
  { value: "APPROVED", label: "Approved" },
  { value: "REJECTED", label: "Rejected" },
  { value: "ALL", label: "All" },
];

export const Approvals = () => {
  const navigate = useNavigate();
  const [scope, setScope] = useState("PENDING");
  const [approver] = useApprover();
  const { approvals, loading, error, refetch, fetchedAt } = useApprovals({
    status: scope === "ALL" ? "all" : scope,
    limit: 100,
    pollMs: 3000,
  });
  const [job, setJob] = useState(null);
  const { data: config } = useConfig();
  const dualThreshold = Number(config?.guardrails?.dual_approval_threshold_usd ?? 100);

  const [localError, setLocalError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [confirm, setConfirm] = useState(null);

  const stats = useMemo(() => {
    const list = approvals || [];
    const pending = list.filter((a) => a.status === "PENDING");
    const totalValue = list.reduce(
      (a, x) => a + (Number(x.finding?.monthly_cost_usd) || 0),
      0,
    );
    const dual = pending.filter((a) => Number(a.required_approvals) > 1).length;
    const me = approver.toLowerCase();
    const voted = pending.filter((a) =>
      (a.votes || []).some((v) => me && (v.user || "").toLowerCase() === me),
    ).length;
    const expiringSoon = pending.filter((a) => {
      const h = (new Date(a.expires_at) - Date.now()) / 3600000;
      return isFinite(h) && h > 0 && h < 48;
    }).length;
    return { totalValue, dual, voted, pending: pending.length, expiringSoon };
  }, [approvals, approver]);

  const vote = async (approvalId, decision) => {
    if (!approver) {
      setLocalError('Enter your name in "Approving as" first. Each approver needs their own name.');
      document.getElementById("approvals-approver-name")?.focus();
      return;
    }
    setBusyId(approvalId);
    setLocalError(null);
    try {
      await approvalsApi.vote(approvalId, decision, approver);
      setNotice(
        decision === "approve"
          ? "Approval recorded. If quorum is met the request moves to Approved and teardown unlocks."
          : "Rejection recorded. The finding is kept and no teardown will run.",
      );
      await refetch();
    } catch (e) {
      setLocalError(toMessage(e, "Could not record your vote"));
    } finally {
      setBusyId(null);
    }
  };

  const teardown = async (approvalId, dryRun) => {
    setBusyId(approvalId);
    setLocalError(null);
    try {
      const res = await teardownApi.trigger(approvalId, dryRun);
      setJob({ id: res.data?.job_id, approvalId, dryRun });
      setNotice(null);
    } catch (e) {
      setLocalError(toMessage(e, "Could not trigger teardown"));
    } finally {
      setBusyId(null);
      setConfirm(null);
    }
  };

  if (loading && !approvals.length) {
    return (
      <div className="app-body">
        <PageHeader title="Approval queue" subtitle="Loading…" />
        <SkeletonStats count={4} />
      </div>
    );
  }

  return (
    <div className="app-body">
      <PageHeader
        eyebrow={
          <>
            <Icon name="inbox" size={12} />
            {fetchedAt ? `Updated ${relativeTime(fetchedAt)}` : "Live"}
          </>
        }
        title="Approval queue"
        subtitle="Nothing gets deleted without a human sign-off. This is where you decide."
        actions={
          <>
            <Button
              variant="secondary"
              icon="refresh"
              onClick={refetch}
              loading={loading}
            >
              Refresh
            </Button>
            <Button
              variant="primary"
              icon="book"
              onClick={() => navigate("/docs")}
            >
              Guardrails
            </Button>
          </>
        }
      />

      {error ? (
        <Alert variant="error" title="Could not load the queue">
          {error}
        </Alert>
      ) : null}
      {localError ? (
        <Alert
          variant="error"
          title="Action failed"
          onDismiss={() => setLocalError(null)}
        >
          {localError}
        </Alert>
      ) : null}
      {notice ? (
        <Alert variant="success" title="Done" onDismiss={() => setNotice(null)}>
          {notice}
        </Alert>
      ) : null}
      {job?.id ? (
        <Alert
          variant={job.dryRun ? "info" : "warning"}
          title={job.dryRun ? "Dry run" : "Teardown"}
          onDismiss={() => setJob(null)}
        >
          <JobStatus jobId={job.id} onDone={() => refetch()} />
        </Alert>
      ) : null}

      <section className="section">
        <div className="stat-grid stagger">
          <StatTile
            label="In queue"
            value={num(stats.pending)}
            unit="requests"
            icon="inbox"
            tone={stats.pending > 0 ? "warn" : "success"}
            hint={`${num(stats.voted)} already voted by you`}
          />
          <StatTile
            label="Value under review"
            value={money(stats.totalValue, { compact: true })}
            unit="/mo"
            icon="wallet"
            tone="brand"
            hint={`${money(stats.totalValue * 12, { compact: true })} annualised if all approved`}
          />
          <StatTile
            label="Needs two sign-offs"
            value={num(stats.dual)}
            icon="users"
            tone={stats.dual > 0 ? "info" : "neutral"}
            hint={
              stats.dual > 0
                ? `Anything above ${money(dualThreshold)}/mo`
                : "Nothing crosses the dual-approval threshold"
            }
          />
          <StatTile
            label="Expiring soon"
            value={num(stats.expiringSoon)}
            icon="hourglass"
            tone={stats.expiringSoon > 0 ? "danger" : "neutral"}
            hint={
              stats.expiringSoon > 0
                ? "Within 48 hours of lapsing"
                : "Nothing lapsing in the next 2 days"
            }
          />
        </div>
      </section>

      <section className="section">
        <div
          className="row row-between row-wrap"
          style={{ marginBottom: "var(--s-7)" }}
        >
          <Segmented value={scope} onChange={setScope} options={SCOPES} />
          <span className="row row-5 row-wrap t-sm t-muted">
            <span>
              {num(approvals.length)} request{approvals.length === 1 ? "" : "s"}
            </span>
            <ApproverField id="approvals-approver-name" />
          </span>
        </div>

        {approvals.length === 0 ? (
          <Card>
            <EmptyState
              icon="checkCircle"
              title={
                scope === "PENDING"
                  ? "Queue is clear"
                  : `No ${scope.toLowerCase()} requests`
              }
              description={
                scope === "PENDING"
                  ? "Every finding has been decided. New ones land here when the agent drafts a teardown plan."
                  : "Try a different status filter."
              }
            >
              <Button
                variant="secondary"
                size="sm"
                icon="refresh"
                onClick={refetch}
              >
                Refresh
              </Button>
            </EmptyState>
          </Card>
        ) : (
          <div className="stack stack-6 stagger">
            {approvals.map((a) => (
              <ApprovalCard
                key={a.approval_id}
                approval={a}
                finding={a.finding}
                currentUser={approver}
                onVote={vote}
                onTeardown={(id, dryRun) =>
                  dryRun ? teardown(id, true) : setConfirm(a)
                }
              />
            ))}
          </div>
        )}
      </section>

      <ConfirmDialog
        isOpen={Boolean(confirm)}
        onCancel={() => setConfirm(null)}
        onConfirm={() => teardown(confirm.approval_id, false)}
        tone="danger"
        loading={busyId === confirm?.approval_id}
        title="Execute teardown"
        confirmLabel="Delete the resource"
        message={
          confirm
            ? `This will permanently remove ${
                confirm.finding?.resource_type || "the resource"
              } ${confirm.finding?.resource_id || ""} and reclaim ${money(
                (Number(confirm.finding?.monthly_cost_usd) || 0) * 12,
              )} a year. Guardrails re-run inside the Lambda and will abort if the resource no longer matches the idle profile. This cannot be undone.`
            : ""
        }
      />
    </div>
  );
};
