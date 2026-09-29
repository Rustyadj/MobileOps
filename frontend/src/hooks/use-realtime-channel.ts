import { useEffect, useRef, useState } from "react";
import { AppState, type AppStateStatus } from "react-native";
import { apiBaseUrl, getAccessToken } from "@/src/api/client";

// Shared WebSocket connect/auth/backoff logic for the `/whiteboard/ws` hub.
// That hub now carries both Dispatch-chat events (message.*, nathan.status)
// and Shortages events (shortage.*) — see backend WhiteboardRealtimeHub — so
// this is factored out of use-whiteboard.ts rather than duplicated per
// feature. Callers just filter `event.type` themselves.
export type RealtimeStatus = "connecting" | "live" | "reconnecting";

const HEARTBEAT_MS = 25_000;
const STALE_CONNECTION_MS = 65_000;

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
    let appState: AppStateStatus = AppState.currentState;
    let lastMessageAt = Date.now();

    const clearHeartbeat = () => {
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = null;
    };

    const scheduleReconnect = () => {
      if (stopped || appState !== "active" || retry) return;
      setStatus("reconnecting");
      retry = setTimeout(() => {
        retry = null;
        connect();
      }, retryMs);
      retryMs = Math.min(retryMs * 2, 15000);
    };

    const connect = () => {
      const token = getAccessToken();
      if (stopped || appState !== "active") return;
      if (!token) {
        scheduleReconnect();
        return;
      }
      if (socket?.readyState === WebSocket.CONNECTING || socket?.readyState === WebSocket.OPEN) return;
      const url = apiBaseUrl().replace(/^http/, "ws").replace(/\/api$/, "/api/whiteboard/ws");
      setStatus((current) => current === "connecting" ? current : "reconnecting");
      const nextSocket = new WebSocket(url);
      socket = nextSocket;
      lastMessageAt = Date.now();
      nextSocket.onopen = () => {
        nextSocket.send(JSON.stringify({ type: "authenticate", token }));
      };
      nextSocket.onmessage = (raw) => {
        lastMessageAt = Date.now();
        try {
          const event = JSON.parse(String(raw.data));
          if (event.type === "ready") {
            retryMs = 1000;
            setStatus("live");
            clearHeartbeat();
            heartbeat = setInterval(() => {
              if (Date.now() - lastMessageAt > STALE_CONNECTION_MS) {
                nextSocket.close();
                return;
              }
              if (nextSocket.readyState === WebSocket.OPEN) nextSocket.send(JSON.stringify({ type: "ping" }));
            }, HEARTBEAT_MS);
          }
          handlerRef.current(event);
        } catch {}
      };
      nextSocket.onerror = () => nextSocket.close();
      nextSocket.onclose = () => {
        if (socket === nextSocket) socket = null;
        clearHeartbeat();
        scheduleReconnect();
      };
    };

    const appStateSubscription = AppState.addEventListener("change", (nextState) => {
      const returningToForeground = appState !== "active" && nextState === "active";
      appState = nextState;
      if (nextState !== "active") {
        if (retry) clearTimeout(retry);
        retry = null;
        clearHeartbeat();
        socket?.close();
        socket = null;
        setStatus("reconnecting");
        return;
      }
      if (returningToForeground) {
        retryMs = 1000;
        socket?.close();
        socket = null;
        connect();
      }
    });
    connect();
    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      clearHeartbeat();
      socket?.close();
      appStateSubscription.remove();
    };
  }, []);

  return status;
}
