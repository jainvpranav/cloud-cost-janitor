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
export function useFindings({ limit = 200, status } = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState(null);
  const [lastKey, setLastKey] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const requestId = useRef(0);

  const fetchPage = useCallback(
    async (append, cursor) => {
      const id = ++requestId.current;
      append ? setLoadingMore(true) : setLoading(true);
      setError(null);
      try {
        const params = { limit };
        if (status) params.status = status;
        if (append && cursor) params.last_key = cursor;
        const { findingsApi } = await import('../api/client');
        const res = await findingsApi.list(params);
        const next = res.data?.items || [];
        if (id !== requestId.current) return;
        setItems((prev) => (append ? [...prev, ...next] : next));
        setLastKey(res.data?.last_key || null);
        setFetchedAt(new Date());
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
export function useApprovals({ status = 'PENDING', limit = 50 } = {}) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [fetchedAt, setFetchedAt] = useState(null);
  const requestId = useRef(0);

  const scoped = !status || String(status).toLowerCase() === 'all' ? undefined : status;

  const load = useCallback(async () => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { approvalsApi } = await import('../api/client');
      const res = await approvalsApi.list({ status: scoped, limit });
      if (id !== requestId.current) return;
      setItems(res.data?.items || []);
      setFetchedAt(new Date());
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

  return useMemo(
    () => ({ approvals: items, loading, error, refetch: load, fetchedAt }),
    [items, loading, error, load, fetchedAt]
  );
}

/** The acting user. Wired to a constant because auth is not implemented yet. */
export const CURRENT_USER = 'current-user';
