import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiBaseUrl, getAccessToken } from "@/src/api/client";
import { useAuth } from "@/src/context/AuthContext";
import type { Mentionable, WhiteboardMessage } from "@/src/types/whiteboard";

const byCreatedAt = (a: WhiteboardMessage, b: WhiteboardMessage) =>
  +new Date(a.created_at) - +new Date(b.created_at);

export function useWhiteboard(limit = 80, markRead = false) {
  const { user } = useAuth();
  const [messages, setMessages] = useState<WhiteboardMessage[]>([]);
  const [mentionables, setMentionables] = useState<Mentionable[]>([]);
  const [unread, setUnread] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const upsert = useCallback((message: WhiteboardMessage) => {
    setMessages((current) => {
      const next = current.some((item) => item.id === message.id)
        ? current.map((item) => item.id === message.id ? message : item)
        : [...current, message];
      return next.sort(byCreatedAt).slice(-Math.max(limit, 10));
    });
  }, [limit]);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [nextMessages, nextMentionables, nextUnread] = await Promise.all([
        api<WhiteboardMessage[]>(`/whiteboard/messages?limit=${limit}`),
        api<Mentionable[]>("/whiteboard/mentionables"),
        api<{ count: number }>("/whiteboard/unread"),
      ]);
      if (!alive.current) return;
      setMessages(nextMessages.sort(byCreatedAt));
      setMentionables(nextMentionables);
      setUnread(nextUnread.count);
      if (markRead) {
        await api("/whiteboard/read", { method: "POST", body: JSON.stringify({ thread_id: "dashboard" }) });
        if (alive.current) setUnread(0);
      }
    } catch (cause: any) {
      if (alive.current) setError(cause?.message || "Whiteboard could not load.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, [limit, markRead]);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let retryMs = 1000;
    const connect = () => {
      const token = getAccessToken();
      if (!token || stopped) return;
      const url = apiBaseUrl().replace(/^http/, "ws").replace(/\/api$/, "/api/whiteboard/ws");
      socket = new WebSocket(url);
      socket.onopen = () => {
        retryMs = 1000;
        socket?.send(JSON.stringify({ type: "authenticate", token }));
      };
      socket.onmessage = (raw) => {
        try {
          const event = JSON.parse(String(raw.data));
          if ((event.type === "message.created" || event.type === "message.updated") && event.message) {
            upsert(event.message);
            if (!markRead && event.type === "message.created" && event.message.author_id !== user?.id) setUnread((count) => count + 1);
            if (markRead && event.type === "message.created") {
              api("/whiteboard/read", { method: "POST", body: JSON.stringify({ thread_id: "dashboard" }) }).catch(() => {});
            }
          }
          if (event.type === "nathan.status") {
            setMessages((current) => current.map((message) => message.id === event.message_id
              ? { ...message, invocation_status: event.status }
              : message));
          }
        } catch {}
      };
      socket.onclose = () => {
        if (!stopped) {
          retry = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 15000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      socket?.close();
    };
  }, [markRead, upsert, user?.id]);

  const send = useCallback(async (body: string, parentId?: string | null) => {
    const created = await api<WhiteboardMessage>("/whiteboard/messages", {
      method: "POST",
      body: JSON.stringify({ body, thread_id: "dashboard", parent_id: parentId || null }),
    });
    upsert(created);
    return created;
  }, [upsert]);

  const edit = useCallback(async (id: string, body: string) => {
    const updated = await api<WhiteboardMessage>(`/whiteboard/messages/${id}`, { method: "PATCH", body: JSON.stringify({ body }) });
    upsert(updated);
  }, [upsert]);

  const remove = useCallback(async (id: string) => {
    const updated = await api<WhiteboardMessage>(`/whiteboard/messages/${id}`, { method: "DELETE" });
    upsert(updated);
  }, [upsert]);

  const pin = useCallback(async (id: string, pinned: boolean) => {
    const updated = await api<WhiteboardMessage>(`/whiteboard/messages/${id}/pin`, { method: "PATCH", body: JSON.stringify({ pinned }) });
    upsert(updated);
  }, [upsert]);

  return { messages, mentionables, unread, loading, error, reload: load, send, edit, remove, pin };
}
