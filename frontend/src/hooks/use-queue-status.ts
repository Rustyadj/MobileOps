// Live pending/failed counts for the mutation queue, for the shell badge
// and the sync-issues screen. Subscribes to syncEngine's change notifier
// (fires after every drain step) rather than polling on an interval, so the
// badge updates the moment something syncs or fails.
import { useEffect, useState } from "react";
import { pendingCount, failedRows, subscribeQueueChanged } from "@/src/sync/syncEngine";

export type QueueStatus = { pending: number; failed: number };

export function useQueueStatus(): QueueStatus {
  const [status, setStatus] = useState<QueueStatus>(() => ({
    pending: pendingCount(),
    failed: failedRows().length,
  }));

  useEffect(() => {
    const refresh = () => setStatus({ pending: pendingCount(), failed: failedRows().length });
    refresh();
    return subscribeQueueChanged(refresh);
  }, []);

  return status;
}
