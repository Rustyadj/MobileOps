// CRUD over the `mutation_queue` SQLite table. This module owns the queue's
// storage shape; syncEngine.ts owns *when* to drain it and what to do with
// each outcome, mutate.ts owns *what* gets enqueued from a screen's write
// action. Keeping these separate means the drain loop and the optimistic
// write path can each be reasoned about (and tested) independently.
import { getDb } from "@/src/db/sqlite";
import { uuidv4 } from "@/src/utils/uuid";

export type QueueKind = "create" | "update" | "command";
export type QueueStatus = "pending" | "in_flight" | "failed" | "conflict";
export type QueueMethod = "POST" | "PUT" | "PATCH" | "DELETE";

export type QueueRow = {
  id: string;
  method: QueueMethod;
  path: string;
  body: string;
  entity_type: string;
  entity_id: string;
  kind: QueueKind;
  local_temp_id: string | null;
  depends_on_queue_id: string | null;
  status: QueueStatus;
  attempt_count: number;
  next_attempt_at: number;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type EnqueueInput = {
  method: QueueMethod;
  path: string;
  body: unknown;
  entityType: string;
  entityId: string;
  kind: QueueKind;
  localTempId?: string;
  dependsOnQueueId?: string;
};

// Placeholder syntax for a create's local id inside a later queued
// mutation's path/body, e.g. path `/equipment/{tmp_abc123}/checkout` or a
// body field `"equipment_id": "{tmp_abc123}"`. Resolved at drain time once
// the create it depends on has synced and produced a real server id.
export function tempIdPlaceholder(localTempId: string): string {
  return `{${localTempId}}`;
}

export function enqueue(input: EnqueueInput): QueueRow {
  const db = getDb();
  const now = Date.now();
  const row: QueueRow = {
    id: uuidv4(),
    method: input.method,
    path: input.path,
    body: JSON.stringify(input.body ?? {}),
    entity_type: input.entityType,
    entity_id: input.entityId,
    kind: input.kind,
    local_temp_id: input.localTempId ?? null,
    depends_on_queue_id: input.dependsOnQueueId ?? null,
    status: "pending",
    attempt_count: 0,
    next_attempt_at: now,
    last_error: null,
    created_at: now,
    updated_at: now,
  };
  if (!db) return row; // web / no local DB — mutate.ts falls back to a direct network call
  db.runSync(
    `INSERT INTO mutation_queue
       (id, method, path, body, entity_type, entity_id, kind, local_temp_id,
        depends_on_queue_id, status, attempt_count, next_attempt_at, last_error,
        created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      row.id, row.method, row.path, row.body, row.entity_type, row.entity_id, row.kind,
      row.local_temp_id, row.depends_on_queue_id, row.status, row.attempt_count,
      row.next_attempt_at, row.last_error, row.created_at, row.updated_at,
    ],
  );
  return row;
}

// The next row eligible to send: oldest-first among rows that are `pending`
// and whose backoff window (if any) has elapsed. Strict FIFO single-flight —
// see the plan's reasoning: enqueue order already encodes same-entity
// dependencies (a return can't be enqueued before its checkout because the
// UI won't let you return what isn't checked out), so this is sufficient
// without a general dependency graph.
export function nextDrainable(): QueueRow | null {
  const db = getDb();
  if (!db) return null;
  return db.getFirstSync<QueueRow>(
    `SELECT * FROM mutation_queue
     WHERE status = 'pending' AND next_attempt_at <= ?
     ORDER BY created_at ASC LIMIT 1`,
    [Date.now()],
  );
}

export function pendingCount(): number {
  const db = getDb();
  if (!db) return 0;
  const row = db.getFirstSync<{ n: number }>(
    `SELECT COUNT(*) as n FROM mutation_queue WHERE status IN ('pending', 'in_flight')`,
  );
  return row?.n ?? 0;
}

export function failedRows(): QueueRow[] {
  const db = getDb();
  if (!db) return [];
  return db.getAllSync<QueueRow>(
    `SELECT * FROM mutation_queue WHERE status IN ('failed', 'conflict') ORDER BY created_at ASC`,
  );
}

// Crash/kill recovery: a row stuck `in_flight` means the app died mid-
// request, not that the request is still running (there's no real
// background execution once the process is gone) — put it back in the
// eligible pool. Call once at sync-engine startup.
export function resetStuckInFlight(): void {
  const db = getDb();
  if (!db) return;
  db.runSync(
    `UPDATE mutation_queue SET status = 'pending', updated_at = ? WHERE status = 'in_flight'`,
    [Date.now()],
  );
}

export function markInFlight(id: string): void {
  const db = getDb();
  if (!db) return;
  db.runSync(`UPDATE mutation_queue SET status = 'in_flight', updated_at = ? WHERE id = ?`, [
    Date.now(),
    id,
  ]);
}

export function markSucceeded(id: string): void {
  const db = getDb();
  if (!db) return;
  db.runSync(`DELETE FROM mutation_queue WHERE id = ?`, [id]);
}

// Network failure — retryable. Backoff: 5s, 15s, 45s, ... capped at 5min.
export function markRetry(id: string, error: string): void {
  const db = getDb();
  if (!db) return;
  const row = db.getFirstSync<QueueRow>(`SELECT * FROM mutation_queue WHERE id = ?`, [id]);
  if (!row) return;
  const attempt = row.attempt_count + 1;
  const delayMs = Math.min(5000 * Math.pow(3, attempt - 1), 5 * 60 * 1000);
  db.runSync(
    `UPDATE mutation_queue
     SET status = 'pending', attempt_count = ?, next_attempt_at = ?, last_error = ?, updated_at = ?
     WHERE id = ?`,
    [attempt, Date.now() + delayMs, error, Date.now(), id],
  );
}

// Terminal HTTP error — stops auto-retrying, surfaced in sync-issues.tsx.
export function markTerminal(id: string, status: QueueStatus, error: string): void {
  const db = getDb();
  if (!db) return;
  db.runSync(
    `UPDATE mutation_queue SET status = ?, last_error = ?, updated_at = ? WHERE id = ?`,
    [status, error, Date.now(), id],
  );
}

// User-initiated retry from sync-issues.tsx: clears the terminal status and
// puts the row back at the front of the eligible queue.
export function retryNow(id: string): void {
  const db = getDb();
  if (!db) return;
  db.runSync(
    `UPDATE mutation_queue SET status = 'pending', next_attempt_at = 0, updated_at = ? WHERE id = ?`,
    [Date.now(), id],
  );
}

export function discard(id: string): QueueRow | null {
  const db = getDb();
  if (!db) return null;
  const row = db.getFirstSync<QueueRow>(`SELECT * FROM mutation_queue WHERE id = ?`, [id]);
  if (!row) return null;
  db.runSync(`DELETE FROM mutation_queue WHERE id = ?`, [id]);
  return row;
}

// Rows that reference a given (still-unsynced) create's temp id, in enqueue
// order — used to resolve placeholders once that create's real id is known,
// and to fail them together if the create itself ultimately fails.
export function dependentsOf(queueId: string): QueueRow[] {
  const db = getDb();
  if (!db) return [];
  return db.getAllSync<QueueRow>(
    `SELECT * FROM mutation_queue WHERE depends_on_queue_id = ? ORDER BY created_at ASC`,
    [queueId],
  );
}

// Rewrites any `{tmp_...}` placeholder in a dependent row's path/body to the
// now-known real id, once the create it depended on has synced.
export function resolveDependency(queueId: string, localTempId: string, realId: string): void {
  const db = getDb();
  if (!db) return;
  const placeholder = tempIdPlaceholder(localTempId);
  const row = db.getFirstSync<QueueRow>(`SELECT * FROM mutation_queue WHERE id = ?`, [queueId]);
  if (!row) return;
  const path = row.path.split(placeholder).join(realId);
  const body = row.body.split(placeholder).join(realId);
  db.runSync(
    `UPDATE mutation_queue SET path = ?, body = ?, depends_on_queue_id = NULL, updated_at = ? WHERE id = ?`,
    [path, body, Date.now(), queueId],
  );
}
