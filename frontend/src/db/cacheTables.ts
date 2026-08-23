// Typed get/upsert/clear helpers over the per-resource cache_<resource>
// tables created in sqlite.ts. Every row is (id, payload JSON, updated_at) —
// deliberately not one JSON blob per resource, so a partial fetch or a
// single optimistic patch (see sync/mutate.ts) never has to rewrite every
// other cached row to update one.
import { getDb, type CacheResource } from "./sqlite";

function tableName(resource: CacheResource): string {
  return `cache_${resource}`;
}

// Every cached entity needs an `id` field — matches every domain model in
// backend/server.py (Equipment, Rental, Dispatch, ... all key off `id`).
type WithId = { id: string };

export function getAllCached<T extends WithId>(resource: CacheResource): T[] {
  const db = getDb();
  if (!db) return [];
  const rows = db.getAllSync<{ payload: string }>(
    `SELECT payload FROM ${tableName(resource)} ORDER BY updated_at DESC`,
  );
  return rows.map((r) => JSON.parse(r.payload) as T);
}

export function getCachedById<T extends WithId>(resource: CacheResource, id: string): T | null {
  const db = getDb();
  if (!db) return null;
  const row = db.getFirstSync<{ payload: string }>(
    `SELECT payload FROM ${tableName(resource)} WHERE id = ?`,
    [id],
  );
  return row ? (JSON.parse(row.payload) as T) : null;
}

// Upserts every row by id. Does NOT delete rows missing from `items` — a
// filtered/partial fetch (or a single-item optimistic patch) should never
// silently evict unrelated cached rows. Screens that need "replace the
// whole list" semantics (a full GET /resource refresh) should follow this
// with replaceAllCached instead.
export function upsertCached<T extends WithId>(resource: CacheResource, items: T[]): void {
  const db = getDb();
  if (!db || items.length === 0) return;
  const now = Date.now();
  const table = tableName(resource);
  db.withTransactionSync(() => {
    for (const item of items) {
      db.runSync(
        `INSERT INTO ${table} (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        [item.id, JSON.stringify(item), now],
      );
    }
  });
}

// Full-list refresh: upserts every item in `items`, then deletes any cached
// row whose id wasn't in this response. Use this for GET /resource list
// reads (useCachedResource's background revalidation); use upsertCached for
// partial writes (a single mutation's response, or an optimistic patch).
export function replaceAllCached<T extends WithId>(resource: CacheResource, items: T[]): void {
  const db = getDb();
  if (!db) return;
  const table = tableName(resource);
  const now = Date.now();
  db.withTransactionSync(() => {
    const keep = items.map((i) => i.id);
    for (const item of items) {
      db.runSync(
        `INSERT INTO ${table} (id, payload, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET payload = excluded.payload, updated_at = excluded.updated_at`,
        [item.id, JSON.stringify(item), now],
      );
    }
    if (keep.length === 0) {
      db.runSync(`DELETE FROM ${table}`);
    } else {
      const placeholders = keep.map(() => "?").join(",");
      db.runSync(`DELETE FROM ${table} WHERE id NOT IN (${placeholders})`, keep);
    }
  });
}

export function removeCached(resource: CacheResource, id: string): void {
  const db = getDb();
  if (!db) return;
  db.runSync(`DELETE FROM ${tableName(resource)} WHERE id = ?`, [id]);
}

export function clearCached(resource: CacheResource): void {
  const db = getDb();
  if (!db) return;
  db.runSync(`DELETE FROM ${tableName(resource)}`);
}

// Read-modify-write patch for one cached row — the mechanism `command`-kind
// optimistic mutations use (mutate.ts) to update only the fields a checkout/
// checkin/status-transition is known to affect, without clobbering the rest
// of the doc.
export function patchCached<T extends WithId>(
  resource: CacheResource,
  id: string,
  patch: Partial<T>,
): T | null {
  const existing = getCachedById<T>(resource, id);
  if (!existing) return null;
  const next = { ...existing, ...patch };
  upsertCached(resource, [next]);
  return next;
}
