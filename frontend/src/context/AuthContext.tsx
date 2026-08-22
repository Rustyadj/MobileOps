// Auth context — supports:
//   1. Email/password JWT flow (login/logout/refresh)
//   2. Emergent Google Sign-in (session_token stored in secure store)
// Both eventually put a bearer token in `accessToken` module state.

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { Platform } from "react-native";
import * as Linking from "expo-linking";
import * as WebBrowser from "expo-web-browser";
import { api, setAccessToken, REFRESH_KEY } from "@/src/api/client";
import { storage } from "@/src/utils/storage";

export type Role = "admin" | "foreman" | "crew";
export type User = { id: string; email: string; name: string; role: Role };

type Ctx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string) => Promise<void>;
  loginWithGoogle: () => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const SESSION_KEY = "cf_session_token";  // Emergent Google session (7-day)
const AUTH_URL = "https://auth.emergentagent.com/";

// Track session_ids we've already exchanged so a re-mount / hot deep link doesn't fire twice.
const exchangedSessionIds = new Set<string>();

const AuthCtx = createContext<Ctx | undefined>(undefined);

function extractSessionId(url: string | null | undefined): string | null {
  if (!url) return null;
  const m = /[?#&]session_id=([^&#]+)/.exec(url);
  return m ? decodeURIComponent(m[1]) : null;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const exchange = useCallback(async (sessionId: string): Promise<boolean> => {
    if (!sessionId || exchangedSessionIds.has(sessionId)) return false;
    exchangedSessionIds.add(sessionId);
    try {
      const data = await api<{ access_token: string; refresh_token: string; user: User }>(
        "/auth/session",
        { method: "POST", body: JSON.stringify({ session_id: sessionId }), auth: false },
      );
      setAccessToken(data.access_token);
      await storage.secureSet(SESSION_KEY, data.access_token);
      // Clear any lingering JWT refresh so bootstrap doesn't get confused.
      await storage.secureRemove(REFRESH_KEY);
      setUser(data.user);
      return true;
    } catch {
      exchangedSessionIds.delete(sessionId);
      return false;
    }
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      // On web: check the URL for a session_id BEFORE anything else (playbook rule #3).
      if (Platform.OS === "web" && typeof window !== "undefined") {
        const sidFromUrl = extractSessionId(window.location.hash) || extractSessionId(window.location.search);
        if (sidFromUrl) {
          const ok = await exchange(sidFromUrl);
          if (ok) {
            // Clean session_id from URL — preserve everything else.
            try {
              const url = new URL(window.location.href);
              url.hash = url.hash.replace(/([?#&])session_id=[^&#]+&?/, "$1").replace(/[?#&]$/, "");
              url.searchParams.delete("session_id");
              window.history.replaceState(window.history.state, "", url.toString());
            } catch {}
            return;
          }
        }
      }

      // Mobile cold start: check the deep link that opened the app.
      if (Platform.OS !== "web") {
        try {
          const initial = await Linking.getInitialURL();
          const sid = extractSessionId(initial);
          if (sid) {
            const ok = await exchange(sid);
            if (ok) return;
          }
        } catch {}
      }

      // Existing Emergent session?
      const stored = await storage.secureGet<string>(SESSION_KEY, "");
      if (stored) {
        setAccessToken(stored);
        try {
          const u = await api<User>("/auth/me");
          setUser(u);
          return;
        } catch {
          setAccessToken(null);
          await storage.secureRemove(SESSION_KEY);
        }
      }

      // Existing JWT refresh?
      const r = await storage.secureGet<string>(REFRESH_KEY, "");
      if (!r) {
        setUser(null);
        return;
      }
      const data = await api<{ access_token: string; refresh_token: string; user: User }>(
        "/auth/refresh",
        { method: "POST", body: JSON.stringify({ refresh_token: r }), auth: false },
      );
      setAccessToken(data.access_token);
      await storage.secureSet(REFRESH_KEY, data.refresh_token);
      setUser(data.user);
    } catch {
      await storage.secureRemove(REFRESH_KEY);
      await storage.secureRemove(SESSION_KEY);
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, [exchange]);

  useEffect(() => {
    bootstrap();
    // Hot deep-link (mobile): user tapped a link while app was already open.
    if (Platform.OS !== "web") {
      const sub = Linking.addEventListener("url", (event) => {
        const sid = extractSessionId(event?.url);
        if (sid) exchange(sid);
      });
      return () => sub.remove();
    }
  }, [bootstrap, exchange]);

  const login = async (email: string, password: string) => {
    const data = await api<{ access_token: string; refresh_token: string; user: User }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }), auth: false },
    );
    setAccessToken(data.access_token);
    await storage.secureSet(REFRESH_KEY, data.refresh_token);
    await storage.secureRemove(SESSION_KEY);
    setUser(data.user);
  };

  const signup = async (name: string, email: string, password: string) => {
    const data = await api<{ access_token: string; refresh_token: string; user: User }>(
      "/auth/signup",
      { method: "POST", body: JSON.stringify({ name, email, password }), auth: false },
    );
    setAccessToken(data.access_token);
    await storage.secureSet(REFRESH_KEY, data.refresh_token);
    await storage.secureRemove(SESSION_KEY);
    setUser(data.user);
  };

  const loginWithGoogle = async () => {
    const redirectUrl =
      Platform.OS === "web" && typeof window !== "undefined"
        ? window.location.origin + "/"
        : Linking.createURL("/");
    const authUrl = `${AUTH_URL}?redirect=${encodeURIComponent(redirectUrl)}`;

    if (Platform.OS === "web") {
      if (typeof window !== "undefined") window.location.href = authUrl;
      return;
    }

    // Mobile: register listener BEFORE opening the session (Android relaunch guard).
    let captured: string | null = null;
    const sub = Linking.addEventListener("url", (event) => {
      if (!captured) captured = event?.url ?? null;
    });
    try {
      const result = await WebBrowser.openAuthSessionAsync(authUrl, redirectUrl);
      // 1) result.url
      let sid = extractSessionId((result as any)?.url);
      // 2) listener capture
      if (!sid) sid = extractSessionId(captured);
      // 3) getInitialURL fallback
      if (!sid) {
        try { sid = extractSessionId(await Linking.getInitialURL()); } catch {}
      }
      if (sid) {
        await exchange(sid);
      }
    } finally {
      sub.remove();
    }
  };

  const logout = async () => {
    await storage.secureRemove(REFRESH_KEY);
    await storage.secureRemove(SESSION_KEY);
    setAccessToken(null);
    setUser(null);
  };

  const refreshUser = async () => {
    try {
      const u = await api<User>("/auth/me");
      setUser(u);
    } catch {}
  };

  return (
    <AuthCtx.Provider value={{ user, loading, login, signup, loginWithGoogle, logout, refreshUser }}>
      {children}
    </AuthCtx.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
