import axios from 'axios';

const API_BASE = process.env.REACT_APP_API_URL || '';

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
});

export const findingsApi = {
  list: (params = {}) => api.get('/findings', { params }),
  get: (id) => api.get(`/findings/${id}`),
};

export const approvalsApi = {
  list: (params = {}) => api.get('/approvals', { params }),
  vote: (approvalId, decision, user) => api.post(`/approvals/${approvalId}/vote`, { decision, user }),
};

export const teardownApi = {
  trigger: (approvalId, dryRun = true) => api.post('/teardown', { approval_id: approvalId, dry_run: dryRun }),
};

export const configApi = {
  get: () => api.get('/config'),
  update: (config) => api.put('/config', config),
};

export default api;