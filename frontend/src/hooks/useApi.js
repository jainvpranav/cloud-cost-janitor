import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { toMessage } from '../api/client';

/**
 * Shared request state for the read paths.
 *
 * Keeps three things the old pages were missing: a real error message the user
 * can see, a refetch function, and a guard so a late response from an
 * out-of-date request can't overwrite fresher data.
 */
export function useAsync(fn, deps = [], { immediate = true } = {}) {
  const [state, setState] = useState({ data: null, loading: immediate, error: null });
  const requestId = useRef(0);
  const mounted = useRef(true);
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async (...args) => {
    const id = ++requestId.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fnRef.current(...args);
      if (!mounted.current || id !== requestId.current) return null;
      setState({ data, loading: false, error: null });
      return data;
    } catch (err) {
      if (!mounted.current || id !== requestId.current) return null;
      setState({ data: null, loading: false, error: toMessage(err) });
      return null;
    }
  }, []);

  useEffect(() => {
    if (immediate) run();
  }, deps);

  return { ...state, refetch: run, setData: (data) => setState((s) => ({ ...s, data })) };
}

/**
 * Findings with cursor pagination. `loadMore` appends rather than replaces so
 * the KPI figures stay consistent with what's on screen.
 */
export function useFindings({ limit = 200, status, pollMs = 0 } = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [lastKey, setLastKey] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const requestId = useRef(0);
  const appended = useRef(false);

  const fetchPage = useCallback(
    async (append, cursor, silent = false) => {
      const id = ++requestId.current;
      if (append) setLoadingMore(true);
      else if (!silent) setLoading(true);
      if (!silent) setError(null);
      try {
        const params = { limit };
        if (status) params.status = status;
        if (append && cursor) params.last_key = cursor;
        const { findingsApi } = await import('../api/client');
        const res = await findingsApi.list(params);
        const next = res.data?.items || [];
        if (id !== requestId.current) return;
        appended.current = append;
        setItems((prev) => (append ? [...prev, ...next] : next));
        setLastKey(res.data?.last_key || null);
        setFetchedAt(new Date());
        setError(null);
      } catch (err) {
        if (id !== requestId.current) return;
        setError(toMessage(err, 'Could not load findings'));
      } finally {
        if (id === requestId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [limit, status]
  );

  useEffect(() => {
    fetchPage(false);
  }, [fetchPage]);

  const refetch = useCallback(() => fetchPage(false), [fetchPage]);
  // A poll only refreshes the first page, so skip it once the user has paged further.
  usePolling(() => {
    if (!appended.current) fetchPage(false, null, true);
  }, pollMs);
  const loadMore = useCallback(() => {
    if (!lastKey || loadingMore) return;
    fetchPage(true, lastKey);
  }, [fetchPage, lastKey, loadingMore]);

  return {
    findings: items,
    loading,
    loadingMore,
    error,
    hasMore: Boolean(lastKey),
    refetch,
    loadMore,
    fetchedAt,
  };
}

/**
 * `status: 'all'` (or null) fetches every status. The default is PENDING because
 * that is what the approval queue and the sidebar badge care about.
 */
export function useApprovals({ status = 'PENDING', limit = 50, pollMs = 0 } = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const requestId = useRef(0);

  const scoped = !status || String(status).toLowerCase() === 'all' ? undefined : status;

  const load = useCallback(async (silent = false) => {
    const id = ++requestId.current;
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const { approvalsApi } = await import('../api/client');
      const res = await approvalsApi.list({ status: scoped || 'all', limit });
      if (id !== requestId.current) return;
      setItems(res.data?.items || []);
      setFetchedAt(new Date());
      setError(null);
    } catch (err) {
      if (id !== requestId.current) return;
      setError(toMessage(err, 'Could not load approvals'));
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [scoped, limit]);

  useEffect(() => {
    load();
  }, [load]);
  usePolling(() => load(true), pollMs);

  const refetch = useCallback(() => load(false), [load]);
  return useMemo(
    () => ({ approvals: items, loading, error, refetch, fetchedAt }),
    [items, loading, error, refetch, fetchedAt]
  );
}

/**
 * Re-run `fn` every `ms` while the tab is visible. Used for the live dashboard;
 * a hidden tab stops polling and catches up as soon as it is shown again.
 */
export function usePolling(fn, ms) {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (!ms) return undefined;
    const tick = () => {
      if (typeof document === 'undefined' || !document.hidden) fnRef.current();
    };
    const id = setInterval(tick, ms);
    const onVisible = () => {
      if (!document.hidden) fnRef.current();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [ms]);
}

/* --------------------------------------------------------------------------
   Approver identity
   There is no login yet, so each person types the name they vote under. It is
   remembered per browser. Two approvers need two different names, which is what
   the dual-approval rule checks.
   -------------------------------------------------------------------------- */

const APPROVER_KEY = 'cost-janitor.approver';
const APPROVER_EVENT = 'cost-janitor:approver';

export function readApprover() {
  try {
    return (window.localStorage.getItem(APPROVER_KEY) || '').trim();
  } catch {
    return '';
  }
}

export function saveApprover(name) {
  const value = (name || '').trim();
  try {
    if (value) window.localStorage.setItem(APPROVER_KEY, value);
    else window.localStorage.removeItem(APPROVER_KEY);
  } catch {
    /* storage can be unavailable (private mode); the in-memory value still works */
  }
  window.dispatchEvent(new CustomEvent(APPROVER_EVENT, { detail: value }));
}

export function useApprover() {
  const [name, setName] = useState(readApprover);
  useEffect(() => {
    const onChange = (e) => setName(e.detail ?? readApprover());
    window.addEventListener(APPROVER_EVENT, onChange);
    return () => window.removeEventListener(APPROVER_EVENT, onChange);
  }, []);
  return [name, saveApprover];
}

/* --------------------------------------------------------------------------
   Agent activity, background jobs and config
   -------------------------------------------------------------------------- */

export function useActivity({ pollMs = 3000, limit = 30 } = {}) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const { activityApi } = await import('../api/client');
      const res = await activityApi.list({ limit });
      setItems(res.data?.items || []);
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load activity'));
    } finally {
      setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    load();
  }, [load]);
  usePolling(load, pollMs);

  return { items, error, loading, refetch: load };
}

const TERMINAL_JOB_STATES = ['SUCCEEDED', 'FAILED', 'REFUSED'];

export function isJobDone(job) {
  return Boolean(job && TERMINAL_JOB_STATES.includes(job.status));
}

/** Poll one background job until it finishes. Pass null to stop. */
export function useJob(jobId, { pollMs = 2000 } = {}) {
  const [job, setJob] = useState(null);
  const [error, setError] = useState(null);
  const done = isJobDone(job);

  const load = useCallback(async () => {
    if (!jobId) return;
    try {
      const { jobsApi } = await import('../api/client');
      const res = await jobsApi.get(jobId);
      setJob(res.data);
      setError(null);
    } catch (err) {
      setError(toMessage(err, 'Could not load job status'));
    }
  }, [jobId]);

  useEffect(() => {
    setJob(null);
    setError(null);
    load();
  }, [load]);
  usePolling(load, jobId && !done ? pollMs : 0);

  return { job, error, done };
}

export function useConfig() {
  return useAsync(async () => {
    const { configApi } = await import('../api/client');
    const res = await configApi.get();
    return res.data || {};
  }, []);
}
