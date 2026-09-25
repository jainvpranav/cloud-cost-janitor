import axios from 'axios';

const CONFIGURED_API_URL = process.env.REACT_APP_API_URL || '';

/**
 * In development the dev server proxies these paths to the real API
 * (see src/setupProxy.js), so requests stay same-origin and need no CORS
 * preflight. Production builds have no dev server, so they call the API
 * directly.
 */
const API_BASE = process.env.NODE_ENV === 'development' ? '' : CONFIGURED_API_URL;

const MISSING_API_MESSAGE =
  'The API returned an HTML page instead of JSON, which means the request never reached the backend. ' +
  'This happens when REACT_APP_API_URL is not set, so calls fall through to the dev server. ' +
  'Copy frontend/.env.example to frontend/.env and set REACT_APP_API_URL to your API base URL ' +
  '(or add a "proxy" field to package.json).';

if (!CONFIGURED_API_URL && typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  // eslint-disable-next-line no-console
  console.warn(
    '[cost-janitor] REACT_APP_API_URL is not set. Development API calls go through ' +
      'src/setupProxy.js, which has no target, so they will fail. Copy .env.example to .env.'
  );
}

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  timeout: 20000,
});

/**
 * A misconfigured base URL produces a 200 with an HTML body, which axios leaves
 * as a string. Without this check every list endpoint resolves to "no items" and
 * the UI shows a plausible-looking but completely empty dashboard.
 */
api.interceptors.response.use((res) => {
  if (typeof res.data === 'string' && /^\s*(<!doctype html|<html)/i.test(res.data)) {
    const err = new Error(MISSING_API_MESSAGE);
    err.isApiConfigError = true;
    throw err;
  }
  return res;
});

/** Turn any axios/fetch failure into a message a human can act on. */
export function toMessage(err, fallback = 'Something went wrong') {
  if (!err) return fallback;
  if (err.isApiConfigError) return err.message;
  if (err.response) {
    const data = err.response.data;
    // Never surface a raw HTML page in the UI — gateways and dev servers return
    // these for unknown routes and they are unreadable and enormous.
    if (typeof data === 'string' && data.trim()) {
      if (/^\s*(<!doctype html|<html)/i.test(data)) {
        return MISSING_API_MESSAGE;
      }
      if (data.length > 300) return `${data.slice(0, 300)}…`;
      try {
        const parsed = JSON.parse(data);
        return parsed.error || parsed.message || fallback;
      } catch {
        return data;
      }
    }
    if (data && (data.error || data.message)) return data.error || data.message;
    return `Request failed (${err.response.status})`;
  }
  if (err.code === 'ECONNABORTED') return 'The request timed out. The API may be cold-starting — try again.';
  if (err.request) return 'Cannot reach the API. Check that REACT_APP_API_URL is set and CORS allows this origin.';
  return err.message || fallback;
}

export const findingsApi = {
  list: (params = {}) => api.get('/findings', { params }),
  get: (id) => api.get(`/findings/${id}`),
};

export const approvalsApi = {
  list: (params = {}) => api.get('/approvals', { params }),
  vote: (approvalId, decision, user) => api.post(`/approvals/${approvalId}/vote`, { decision, user }),
};

export const teardownApi = {
  trigger: (approvalId, dryRun = true) =>
    api.post('/teardown', { approval_id: approvalId, dry_run: dryRun }),
};

export const configApi = {
  get: () => api.get('/config'),
  update: (config) => api.put('/config', config),
};

export default api;
