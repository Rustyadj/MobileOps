// The write-side counterpart to useCachedResource: replaces a direct
// `await api(...)` call in a phase-1 screen's write handler. Applies an
// optimistic change to the local cache immediately and enqueues the real
// request — the caller does not await a network round-trip. See the plan's
// three mutation kinds (create / update / command) for why each patches the
// cache differently.
import { patchCached, upsertCached } from "@/src/db/cacheTables";
import type { CacheResource } from "@/src/db/sqlite";
import { enqueue, tempIdPlaceholder, type QueueMethod } from "@/src/sync/queue";
import { drainQueue } from "@/src/sync/syncEngine";
import { uuidv4 } from "@/src/utils/uuid";

type WithId = { id: string };

type MutateCreateInput<T extends WithId> = {
  kind: "create";
  entityType: CacheResource;
  path: string;
  method: "POST";
  body: Record<string, unknown>;
  // Builds the full doc to show locally under the temp id, before the
  // server has assigned a real one (e.g. for a new equipment row appearing
  // in the list immediately).
  optimisticDoc: (tempId: string) => T;
  // Set when this create's path/body references another still-unsynced
  // create's temp id (rare in phase 1 — flagged for completeness).
  dependsOnQueueId?: string;
};

type MutateUpdateInput<T extends WithId> = {
  kind: "update";
  entityType: CacheResource;
  entityId: string;
  path: string;
  method: "PUT";
  body: Record<string, unknown>;
  optimisticDoc: T; // full replacement for the cached row
};

type MutateCommandInput = {
  kind: "command";
  entityType: CacheResource;
  entityId: string;
  path: string;
  method: Extract<QueueMethod, "POST" | "PATCH">;
  body: unknown;
  // Only the fields this command is known to affect — e.g. checkout:
  // { available: n - 1, checked_out: n + 1, checked_out_to: "..." }.
  optimisticPatch: Record<string, unknown>;
  dependsOnQueueId?: string;
};

export type MutateInput<T extends WithId> =
  | MutateCreateInput<T>
  | MutateUpdateInput<T>
  | MutateCommandInput;

export function mutate<T extends WithId>(input: MutateInput<T>): T | null {
  if (input.kind === "create") {
    const tempId = `tmp_${uuidv4()}`;
    const doc = input.optimisticDoc(tempId);
    upsertCached(input.entityType, [{ ...doc, id: tempId }]);
    // Caller embeds tempIdPlaceholder(...) in path/body directly when this
    // create depends on another still-unsynced create's temp id.
    enqueue({
      method: input.method,
      path: input.path,
      body: input.body,
      entityType: input.entityType,
      entityId: tempId,
      kind: "create",
      localTempId: tempId,
      dependsOnQueueId: input.dependsOnQueueId,
    });
    void drainQueue();
    return { ...doc, id: tempId };
  }

  if (input.kind === "update") {
    upsertCached(input.entityType, [input.optimisticDoc]);
    enqueue({
      method: input.method,
      path: input.path,
      body: input.body,
      entityType: input.entityType,
      entityId: input.entityId,
      kind: "update",
    });
    void drainQueue();
    return input.optimisticDoc;
  }

  // command
  const patched = patchCached<T>(input.entityType, input.entityId, input.optimisticPatch as Partial<T>);
  enqueue({
    method: input.method,
    path: input.path,
    body: input.body,
    entityType: input.entityType,
    entityId: input.entityId,
    kind: "command",
    dependsOnQueueId: input.dependsOnQueueId,
  });
  void drainQueue();
  return patched;
}

// Helper for building a path/body that references a not-yet-synced create's
// temp id (e.g. "check out this tool I just added while offline").
export { tempIdPlaceholder };
