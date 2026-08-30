import { useEffect, useRef } from "react";
import { apiBaseUrl, getAccessToken } from "@/src/api/client";

// Shared WebSocket connect/auth/backoff logic for the `/whiteboard/ws` hub.
// That hub now carries both Dispatch-chat events (message.*, nathan.status)
// and Shortages events (shortage.*) — see backend WhiteboardRealtimeHub — so
// this is factored out of use-whiteboard.ts rather than duplicated per
// feature. Callers just filter `event.type` themselves.
export function useRealtimeChannel(onEvent: (event: any) => void) {
  const handlerRef = useRef(onEvent);
  handlerRef.current = onEvent;

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
          handlerRef.current(JSON.parse(String(raw.data)));
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
  }, []);
}
