import React from 'react';
import { act } from 'react-dom/test-utils';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';

import { ActivityFeed, DemoModeChip } from './Live';
import { Approvals } from '../pages/Approvals';
import { saveApprover } from '../hooks/useApi';

global.IS_REACT_ACT_ENVIRONMENT = true;

const mockVote = jest.fn(async () => ({ data: {} }));

jest.mock('../api/client', () => ({
  toMessage: (e, fallback) => (e && e.message) || fallback || 'error',
  activityApi: {
    list: async () => ({
      data: {
        items: [
          { ts: '1', tool: 'draft_teardown_plan', actor: 'agent', ok: true, at: new Date().toISOString(),
            result_summary: '3 items for approval, 1 skipped, $25.62/mo' },
          { ts: '2', tool: 'execute_teardown', actor: 'agent', ok: false, at: new Date().toISOString(),
            result_summary: 'Approval appr-x is PENDING' },
        ],
      },
    }),
  },
  approvalsApi: {
    list: async () => ({
      data: {
        items: [
          {
            approval_id: 'appr-f1', finding_id: 'f1', status: 'PENDING', required_approvals: 2, votes: [],
            created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 864e5).toISOString(),
            finding: { finding_id: 'f1', resource_type: 'ELB', resource_id: 'demo-legacy-alb', region: 'us-east-1',
                       monthly_cost_usd: 16.43, status: 'PENDING_APPROVAL', evidence: {}, tags: {} },
          },
        ],
      },
    }),
    vote: (...args) => mockVote(...args),
  },
  teardownApi: { trigger: async () => ({ data: { job_id: 'j1' } }) },
  jobsApi: { get: async () => ({ data: { job_id: 'j1', status: 'QUEUED' } }) },
  scanApi: { start: async () => ({ data: { job_id: 'j2' } }) },
  findingsApi: { list: async () => ({ data: { items: [] } }) },
  configApi: { get: async () => ({ data: {} }) },
}));

let container;
let root;

beforeEach(() => {
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  mockVote.mockClear();
});

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

it('shows agent activity including refusals', async () => {
  act(() => root.render(<ActivityFeed pollMs={0} />));
  await flush();
  expect(container.textContent).toMatch(/Drafted a teardown plan/);
  expect(container.textContent).toMatch(/\$25\.62\/mo/);
  expect(container.textContent).toMatch(/refused/);
});

it('shows demo mode only when scope tags are set', () => {
  act(() => root.render(<DemoModeChip config={{ scope_tags: { CostJanitor: ['demo'] } }} />));
  expect(container.textContent).toMatch(/Demo mode · CostJanitor=demo/);
  act(() => root.render(<DemoModeChip config={{}} />));
  expect(container.textContent).toBe('');
});

function clickApprove() {
  const button = [...container.querySelectorAll('button')].find((b) => /^\s*Approve\s*$/.test(b.textContent));
  expect(button).toBeTruthy();
  return act(async () => {
    button.click();
    await new Promise((r) => setTimeout(r, 0));
  });
}

it('will not vote until the approver has a name, then votes under that name', async () => {
  act(() => root.render(<MemoryRouter><Approvals /></MemoryRouter>));
  await flush();
  expect(container.textContent).toMatch(/demo-legacy-alb/);

  await clickApprove();
  expect(mockVote).not.toHaveBeenCalled();
  expect(container.textContent).toMatch(/Enter your name/);

  act(() => saveApprover('Alice'));
  await clickApprove();
  expect(mockVote).toHaveBeenCalledWith('appr-f1', 'approve', 'Alice');
});
