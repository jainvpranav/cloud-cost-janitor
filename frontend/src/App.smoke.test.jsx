/**
 * Smoke tests: every route must render real content, and the KPI layer must
 * produce sane numbers for both empty and populated data.
 *
 * The error-boundary assertion matters — the app shell wraps each route in an
 * ErrorBoundary, so without it a crash renders a "something broke" page and a
 * naive render test still passes.
 */
import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import App from './App';
import { ThemeProvider } from './theme/ThemeProvider';
import { computeMetrics } from './lib/metrics';
import { buildInsights } from './lib/insights';

global.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('./api/client', () => {
  const noop = async () => ({ data: { items: [], last_key: null } });
  return {
    toMessage: (e) => (e && e.message) || 'error',
    findingsApi: { list: noop, get: noop },
    approvalsApi: { list: noop, vote: noop, teardown: noop },
    teardownApi: { trigger: noop },
    configApi: { get: noop, put: noop },
    scanApi: { start: noop },
    jobsApi: { get: noop },
    activityApi: { list: noop },
  };
});

const ROUTES = ['/', '/insights', '/approvals', '/findings', '/docs', '/settings', '/nope'];

describe('app renders every route without crashing', () => {
  let container;
  let root;
  const errors = [];

  beforeAll(() => {
    // Surface anything React logged so a swallowed error still fails the run.
    jest.spyOn(console, 'error').mockImplementation((...args) => {
      errors.push(String(args[0]));
    });
  });

  afterAll(() => {
    console.error.mockRestore();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  ROUTES.forEach((path) => {
    it(`renders ${path}`, () => {
      act(() => {
        root.render(
          <ThemeProvider>
            <MemoryRouter initialEntries={[path]}>
              <App />
            </MemoryRouter>
          </ThemeProvider>
        );
      });
      const text = container.textContent;
      expect(text.length).toBeGreaterThan(0);
      // The shell's ErrorBoundary would otherwise turn a crash into a
      // "passing" test, so assert the real page rendered instead.
      expect(text).not.toMatch(/Something broke while rendering this page/);
      expect(errors.filter((e) => /Unhandled UI error/.test(e))).toHaveLength(0);
    });
  });
});

describe('metrics and insights tolerate empty and populated input', () => {
  it('handles no data at all', () => {
    const m = computeMetrics([], []);
    expect(m.approvalRate).toBeNull();
    expect(m.medianDecisionHours).toBeNull();
    expect(m.realizedMonthly).toBe(0);
    expect(() => buildInsights(m)).not.toThrow();
  });

  it('produces real throughput numbers from approvals', () => {
    const now = new Date().toISOString();
    const findings = [
      {
        finding_id: 'f1',
        status: 'TEARDOWN_COMPLETE',
        monthly_cost_usd: 120,
        detected_at: now,
        region: 'us-east-1',
        resource_type: 'EC2',
        enrichment: { recommendation: 'delete', confidence: 0.92, risk_assessment: 'low' },
      },
      {
        finding_id: 'f2',
        status: 'PENDING_APPROVAL',
        monthly_cost_usd: 40,
        detected_at: now,
        region: 'eu-west-1',
        resource_type: 'EBS',
        enrichment: { recommendation: 'keep', confidence: 0.31, risk_assessment: 'high' },
      },
    ];
    const approvals = [
      {
        approval_id: 'appr-f1',
        status: 'APPROVED',
        required_approvals: 2,
        created_at: now,
        votes: [{ user: 'a', decision: 'approve', at: now }],
      },
      {
        approval_id: 'appr-f2',
        status: 'PENDING',
        required_approvals: 2,
        created_at: now,
        votes: [],
      },
    ];
    const m = computeMetrics(findings, approvals);
    expect(m.realizedMonthly).toBe(120);
    expect(m.pendingApprovalCount).toBe(1);
    expect(m.dualApprovalCount).toBe(1);
    expect(m.approvalRate).toBe(1);
    expect(m.decidedCount).toBe(1);
    expect(m.aiCoverage).toBe(1);
    expect(m.deletePrecision).toBe(1);
    expect(buildInsights(m).length).toBeGreaterThan(0);
  });
});
