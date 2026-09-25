/**
 * API client tests. The HTML case is the important one: when REACT_APP_API_URL
 * is unset, the dev server answers API calls with index.html, which previously
 * resolved to "zero findings" and rendered a plausible but empty dashboard.
 */
import api, { toMessage, findingsApi } from './client';

const respondWith = (data, status = 200) => {
  api.defaults.adapter = async (config) => ({
    data,
    status,
    statusText: 'OK',
    headers: {},
    config,
  });
};

afterEach(() => {
  api.defaults.adapter = undefined;
});

describe('response handling', () => {
  it('passes real JSON through untouched', async () => {
    respondWith({ items: [{ finding_id: 'f-1' }], last_key: null });
    const res = await findingsApi.list({ limit: 10 });
    expect(res.data.items).toHaveLength(1);
  });

  it('rejects an HTML response with actionable guidance instead of empty data', async () => {
    respondWith('<!DOCTYPE html><html><body>Cost Janitor</body></html>');
    await expect(findingsApi.list()).rejects.toThrow(/REACT_APP_API_URL/);
  });

  it('surfaces the guidance through toMessage', async () => {
    respondWith('<html></html>');
    let caught;
    try {
      await findingsApi.list();
    } catch (e) {
      caught = e;
    }
    expect(toMessage(caught, 'fallback')).toMatch(/returned an HTML page/);
    expect(toMessage(caught, 'fallback')).toMatch(/\.env/);
  });
});

describe('toMessage', () => {
  it('extracts a JSON error body sent as a string', () => {
    const err = { response: { status: 400, data: JSON.stringify({ error: 'Bad request' }) } };
    expect(toMessage(err)).toBe('Bad request');
  });

  it('handles a non-JSON error body', () => {
    const err = { response: { status: 502, data: 'upstream connect error' } };
    expect(toMessage(err)).toBe('upstream connect error');
  });

  it('never surfaces a raw HTML page from a gateway or dev server', () => {
    const err = { response: { status: 404, data: '<!DOCTYPE html><html><body>Cannot GET /findings</body></html>' } };
    const msg = toMessage(err);
    expect(msg).toMatch(/returned an HTML page/);
    expect(msg).not.toMatch(/DOCTYPE/);
  });

  it('truncates a very long plain-text body', () => {
    const err = { response: { status: 500, data: 'x'.repeat(1000) } };
    expect(toMessage(err).length).toBeLessThanOrEqual(301);
  });

  it('explains a timeout', () => {
    expect(toMessage({ code: 'ECONNABORTED' })).toMatch(/timed out/i);
  });

  it('explains an unreachable API', () => {
    expect(toMessage({ request: {} })).toMatch(/Cannot reach the API/);
  });

  it('falls back when there is no error at all', () => {
    expect(toMessage(null, 'fallback')).toBe('fallback');
  });
});
