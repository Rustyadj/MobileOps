// Drains the mutation_queue: decides *when* to attempt sending queued
// mutations, sends them through the same `api()` every screen already uses
// (with the queue row's id as the Idempotency-Key — see backend/server.py's
// `idempotent()` helper), and reconciles the local cache with each outcome.
//
// Call `startSyncEngine()` once, after login, from wherever the app already
// does other post-auth setup (AuthContext). It's safe to call more than
// once — internally idempotent.
import { AppState, type AppStateStatus } from "react-native";
import { api, ApiHttpError, ApiNetworkError } from "@/src/api/client";
import { isSqliteAvailable } from "@/src/db/sqlite";
import { removeCached, upsertCached } from "@/src/db/cacheTables";
import type { CacheResource } from "@/src/db/sqlite";
import {
  dependentsOf,
  discard,
  failedRows as queueFailedRows,
  markInFlight,
  markRetry,
  markSucceeded,
  markTerminal,
  nextDrainable,
  pendingCount as queuePendingCount,
  resetStuckInFlight,
  resolveDependency,
  retryNow,
  type QueueRow,
} from "@/src/sync/queue";

const FOREGROUND_POLL_MS = 2 * 60 * 1000;

let draining = false;
let started = false;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function notifyListeners() {
  listeners.forEach((l) => l());
}

// useQueueStatus subscribes here so the badge updates immediately after a
// drain step, not just on the next poll.
export function subscribeQueueChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function entityCacheResource(entityType: string): CacheResource {
  return entityType as CacheResource;
}

// A create's server response replaces the temp-id row in the cache and
// resolves any not-yet-drained queue rows that referenced that temp id.
function reconcileCreateSuccess(row: QueueRow, serverResult: unknown) {
  if (row.kind !== "create" || !row.local_temp_id) return;
  const resource = entityCacheResource(row.entity_type);
  removeCached(resource, row.local_temp_id);
  const doc = serverResult as { id?: string } | undefined;
  if (doc && typeof doc.id === "string") {
    upsertCached(resource, [doc as { id: string }]);
    for (const dep of dependentsOf(row.id)) {
      resolveDependency(dep.id, row.local_temp_id, doc.id);
    }
  }
}

// A command/update's server response is the authoritative new state for
// that entity — replace whatever the optimistic patch guessed.
function reconcileWriteSuccess(row: QueueRow, serverResult: unknown) {
  if (row.kind === "create") return reconcileCreateSuccess(row, serverResult);
  const doc = serverResult as { id?: string } | undefined;
  if (doc && typeof doc.id === "string") {
    upsertCached(entityCacheResource(row.entity_type), [doc as { id: string }]);
  }
}

// A create that ultimately fails leaves a temp-id "ghost" row in the cache
// and strands any dependents — fail the dependents too (they can't resolve
// a real id that will never exist) rather than let them retry forever.
function failDependents(row: QueueRow, message: string) {
  for (const dep of dependentsOf(row.id)) {
    markTerminal(dep.id, "failed", `Blocked: ${message}`);
  }
}

async function drainOnce(): Promise<"drained" | "offline" | "empty"> {
  const row = nextDrainable();
  if (!row) return "empty";
  markInFlight(row.id);
  notifyListeners();
  try {
    const result = await api(row.path, {
      method: row.method,
      body: row.method === "DELETE" ? undefined : row.body,
      idempotencyKey: row.id,
    });
    markSucceeded(row.id);
    reconcileWriteSuccess(row, result);
    notifyListeners();
    return "drained";
  } catch (e) {
    if (e instanceof ApiNetworkError) {
      markRetry(row.id, e.message);
      notifyListeners();
      return "offline";
    }
    if (e instanceof ApiHttpError) {
      markTerminal(row.id, e.status === 409 ? "conflict" : "failed", e.message);
    } else {
      markTerminal(row.id, "failed", e instanceof Error ? e.message : String(e));
    }
    failDependents(row, row.last_error || "sync failed");
    notifyListeners();
    return "drained"; // this row is done (failed), keep draining the rest
  }
}

// Single-flight, reentrant-safe: overlapping triggers (a NetInfo event and
// a manual pull-to-refresh landing at the same moment) share one drain pass
// instead of racing.
let inFlightDrain: Promise<void> | null = null;

export function drainQueue(): Promise<void> {
  if (!isSqliteAvailable()) return Promise.resolve(); // web: no queue to drain
  if (inFlightDrain) return inFlightDrain;
  inFlightDrain = (async () => {
    if (draining) return;
    draining = true;
    try {
      // Stop as soon as we hit a network failure (still offline) or the
      // queue is empty — a terminal per-row failure doesn't stop the loop,
      // since unrelated queued mutations should still get their chance.
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const outcome = await drainOnce();
        if (outcome === "empty" || outcome === "offline") break;
      }
    } finally {
      draining = false;
      inFlightDrain = null;
    }
  })();
  return inFlightDrain;
}

export function pendingCount(): number {
  return queuePendingCount();
}

export function failedRows(): QueueRow[] {
  return queueFailedRows();
}

export function retryFailed(id: string): void {
  retryNow(id);
  notifyListeners();
  drainQueue();
}

export function discardFailed(id: string): void {
  // Note: this does not attempt to roll back the optimistic cache patch a
  // discarded `command`/`update` row applied — phase 1 accepts that a
  // discarded action leaves the cache showing what the user asked for
  // until the next successful revalidation corrects it, rather than
  // building a generic patch-reversal mechanism for a rarely-hit path.
  discard(id);
  notifyListeners();
}

export function startSyncEngine(): void {
  if (started || !isSqliteAvailable()) return;
  started = true;
  resetStuckInFlight();

  // NetInfo is only imported here (not at module load) so this file loads
  // safely even before the app has requested the necessary permissions/
  // finished native module init.
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const NetInfo = require("@react-native-community/netinfo").default;
    let wasOffline = false;
    NetInfo.addEventListener((state: { isConnected: boolean | null; isInternetReachable: boolean | null }) => {
      const online = !!state.isConnected && state.isInternetReachable !== false;
      if (online && wasOffline) drainQueue();
      wasOffline = !online;
    });
  } catch {
    // NetInfo not available (e.g. not yet installed in this environment) —
    // the AppState listener and timer below still provide coverage.
  }

  AppState.addEventListener("change", (state: AppStateStatus) => {
    if (state === "active") drainQueue();
  });

  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    if (AppState.currentState === "active") drainQueue();
  }, FOREGROUND_POLL_MS);

  // Catch anything already queued from a previous session.
  drainQueue();
}
