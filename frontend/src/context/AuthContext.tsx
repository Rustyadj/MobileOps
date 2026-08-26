// Auth context — email/password JWT login, signup, logout, and refresh.

import React, { createContext, useContext, useEffect, useState, useCallback } from "react";
import { api, setAccessToken, REFRESH_KEY } from "@/src/api/client";
import { storage } from "@/src/utils/storage";
import { startSyncEngine } from "@/src/sync/syncEngine";

export type Role = "admin" | "foreman" | "crew";
export type User = { id: string; email: string; name: string; role: Role };

type Ctx = {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (name: string, email: string, password: string, inviteCode: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshUser: () => Promise<void>;
};

const LEGACY_SESSION_KEY = "cf_session_token";
const DEMO_MODE = process.env.EXPO_PUBLIC_DEMO_MODE === "true";
const DEMO_USER: User = { id: "demo-user", email: "demo@mobileops.local", name: "Demo Operator", role: "admin" };

const AuthCtx = createContext<Ctx | undefined>(undefined);

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const bootstrap = useCallback(async () => {
    try {
      // Remove obsolete provider-session credentials left by older clients.
      await storage.secureRemove(LEGACY_SESSION_KEY);
      if (DEMO_MODE) {
        setAccessToken("demo-access-token");
        setUser(DEMO_USER);
        return;
      }

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
      setAccessToken(null);
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    bootstrap();
  }, [bootstrap]);

  // Starts NetInfo/AppState-driven queue draining once there's a session to
  // sync mutations against — covers login, signup, and restored sessions.
  // Idempotent: startSyncEngine() is a no-op after the first successful call.
  useEffect(() => {
    if (user) startSyncEngine();
  }, [user]);

  const login = async (email: string, password: string) => {
    const data = await api<{ access_token: string; refresh_token: string; user: User }>(
      "/auth/login",
      { method: "POST", body: JSON.stringify({ email, password }), auth: false },
    );
    setAccessToken(data.access_token);
    await storage.secureSet(REFRESH_KEY, data.refresh_token);
    setUser(data.user);
  };

  const signup = async (name: string, email: string, password: string, inviteCode: string) => {
    const data = await api<{ access_token: string; refresh_token: string; user: User }>(
      "/auth/signup",
      {
        method: "POST",
        body: JSON.stringify({ name, email, password, invite_code: inviteCode.trim() }),
        auth: false,
      },
    );
    setAccessToken(data.access_token);
    await storage.secureSet(REFRESH_KEY, data.refresh_token);
    setUser(data.user);
  };

  const logout = async () => {
    if (DEMO_MODE) {
      setUser(DEMO_USER);
      return;
    }
    await storage.secureRemove(REFRESH_KEY);
    await storage.secureRemove(LEGACY_SESSION_KEY);
    setAccessToken(null);
    setUser(null);
  };

  const refreshUser = async () => {
    if (DEMO_MODE) return;
    try {
      const u = await api<User>("/auth/me");
      setUser(u);
    } catch {}
  };

  return (
    <AuthCtx.Provider value={{ user, loading, login, signup, logout, refreshUser }}>
      {children}
    </AuthCtx.Provider>
  );
};

export function useAuth() {
  const ctx = useContext(AuthCtx);
  if (!ctx) throw new Error("useAuth must be used inside AuthProvider");
  return ctx;
}
