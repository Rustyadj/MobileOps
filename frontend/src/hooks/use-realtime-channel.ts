import { useEffect, useRef, useState } from "react";
import { apiBaseUrl, getAccessToken } from "@/src/api/client";

// Shared WebSocket connect/auth/backoff logic for the `/whiteboard/ws` hub.
// That hub now carries both Dispatch-chat events (message.*, nathan.status)
// and Shortages events (shortage.*) — see backend WhiteboardRealtimeHub — so
// this is factored out of use-whiteboard.ts rather than duplicated per
// feature. Callers just filter `event.type` themselves.
export type RealtimeStatus = "connecting" | "live" | "reconnecting";

const HEARTBEAT_MS = 25_000;

export function useRealtimeChannel(onEvent: (event: any) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;
  const [status, setStatus] = useState<RealtimeStatus>("connecting");

  useEffect(() => {
    let socket: WebSocket | null = null;
    let retry: ReturnType<typeof setTimeout> | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    let stopped = false;
    let retryMs = 1000;

    const clearHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    const connect = () => {
      const token = getAccessToken();
      if (!token || stopped) return;
      const url = apiBaseUrl().replace(/^http/, "ws").replace(/\/api$/, "/api/whiteboard/ws");
      setStatus((current) => current === "connecting" ? current : "reconnecting");
      socket = new WebSocket(url);
      socket.onopen = () => {
        socket?.send(JSON.stringify({ type: "authenticate", token }));
      };
      socket.onmessage = (raw) => {
        try {
          const event = JSON.parse(String(raw.data));
          if (event.type === "ready") {
            retryMs = 1000;
            setStatus("live");
            clearHeartbeat();
            heartbeat = setInterval(() => {
              if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
            }, HEARTBEAT_MS);
          }
          handlerRef.current(event);
        } catch {}
      };
      socket.onclose = () => {
        clearHeartbeat();
        if (!stopped) {
          setStatus("reconnecting");
          retry = setTimeout(connect, retryMs);
          retryMs = Math.min(retryMs * 2, 15000);
        }
      };
    };
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clearHeartbeat();
      socket?.close();
    };
  }, []);

  return status;
}
