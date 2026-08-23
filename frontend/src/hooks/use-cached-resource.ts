// Cache-first read hook — the unit of adoption for offline support. A
// screen swaps its `useState` + `useEffect(() => { load() }, [load])` +
// `api(...)` block for one call per resource to this hook; filtering,
// sorting, and rendering underneath stay exactly as they are today.
//
// Read timing matches today's screens (fetch on mount / on dependency
// change), just with an instant cache-backed first paint: the SQLite cache
// table is read synchronously into initial state (no loading flash), then a
// background network fetch runs and, on success, replaces the cache + state.
// On failure — network or HTTP — the last-good cached data is kept and
// `stale`/`error` are set so a screen can opt into showing that (most don't
// today, which is fine: the previous data staying on screen is still
// correct behavior, just not labeled as stale).
import { useCallback, useEffect, useRef, useState } from "react";
import { ApiNetworkError } from "@/src/api/client";
import { getAllCached, replaceAllCached } from "@/src/db/cacheTables";
import type { CacheResource } from "@/src/db/sqlite";
import { drainQueue } from "@/src/sync/syncEngine";

type WithId = { id: string };

export type CachedResourceResult<T> = {
  data: T[];
  refreshing: boolean;
  onRefresh: () => void;
  stale: boolean;
  lastSyncedAt: number | null;
  error: Error | null;
};

export function useCachedResource<T extends WithId>(
  resource: CacheResource,
  fetcher: () => Promise<T[]>,
  options: { enabled?: boolean } = {},
): CachedResourceResult<T> {
  const { enabled = true } = options;
  const [data, setData] = useState<T[]>(() => (enabled ? getAllCached<T>(resource) : []));
  const [refreshing, setRefreshing] = useState(false);
  const [stale, setStale] = useState(false);
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [error, setError] = useState<Error | null>(null);
  // Guards against a slow response landing after a newer one already did.
  const requestSeq = useRef(0);

  const revalidate = useCallback(async () => {
    if (!enabled) return;
    const seq = ++requestSeq.current;
    setRefreshing(true);
    try {
      const fresh = await fetcher();
      if (seq !== requestSeq.current) return; // superseded by a newer call
      replaceAllCached(resource, fresh);
      setData(fresh);
      setStale(false);
      setError(null);
      setLastSyncedAt(Date.now());
    } catch (e) {
      if (seq !== requestSeq.current) return;
      setStale(true);
      setError(e instanceof Error ? e : new Error(String(e)));
      // Network failure vs HTTP error both keep last-good `data` as-is —
      // nothing to do here; we simply don't overwrite `data`.
      void (e instanceof ApiNetworkError); // documents the distinction is available to callers via `error`
    } finally {
      if (seq === requestSeq.current) setRefreshing(false);
    }
  }, [resource, fetcher, enabled]);

  useEffect(() => {
    if (enabled) setData(getAllCached<T>(resource));
    revalidate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resource, enabled]);

  const onRefresh = useCallback(() => {
    // A manual pull-to-refresh is also "try to sync anything queued" — if
    // the device just regained signal, this is often the first moment we'd
    // otherwise notice.
    drainQueue().finally(() => {
      revalidate();
    });
  }, [revalidate]);

  return { data, refreshing, onRefresh, stale, lastSyncedAt, error };
}
