import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/api/client";
import { useRealtimeChannel } from "@/src/hooks/use-realtime-channel";
import type { AppNotification } from "@/src/types/notification";

// Per-user mention inbox. The backend is authoritative: it creates the
// notification when a post/comment is saved and pushes `notification.created`
// only to that user's own sockets over the shared `/whiteboard/ws` hub.
export function useNotifications(limit = 30) {
  const [items, setItems] = useState<AppNotification[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [list, count] = await Promise.all([
        api<AppNotification[]>(`/notifications?limit=${limit}`),
        api<{ count: number }>("/notifications/unread-count"),
      ]);
      if (!alive.current) return;
      setItems(list);
      setUnread(count.count);
    } catch (cause: any) {
      if (alive.current) setError(cause?.message || "Notifications could not load.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [limit]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  useRealtimeChannel(useCallback((event: any) => {
    // "ready" fires on every (re)connect: reload so nothing missed while offline is lost.
    if (event.type === "ready") {
      load();
    } else if (event.type === "notification.created" && event.notification) {
      setItems((current) => current.some((item) => item.id === event.notification.id)
        ? current
        : [event.notification, ...current].slice(0, Math.max(limit, 10)));
      if (typeof event.unread_count === "number") setUnread(event.unread_count);
    }
  }, [load, limit]));

  const markRead = useCallback(async (id: string) => {
    setItems((current) => current.map((item) => item.id === id ? { ...item, read: true } : item));
    try {
      const result = await api<{ count: number }>(`/notifications/${id}/read`, { method: "POST" });
      if (alive.current) setUnread(result.count);
    } catch {
      load();
    }
  }, [load]);

  const markAllRead = useCallback(async () => {
    setItems((current) => current.map((item) => ({ ...item, read: true })));
    setUnread(0);
    try {
      await api("/notifications/read-all", { method: "POST" });
    } catch {
      load();
    }
  }, [load]);

  return { items, unread, loading, error, reload: load, markRead, markAllRead };
}
