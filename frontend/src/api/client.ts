// API client with auth token attach + silent refresh on 401.
import { Platform } from "react-native";
import { storage } from "@/src/utils/storage";

// The sync engine and useCachedResource need to tell "never reached the
// server" (offline, DNS failure, timeout — retry later, not an error to
// show anyone) apart from "the server responded and said no" (4xx/5xx —
// a real error, potentially terminal). A raw `fetch` throw collapses both
// into the same untyped exception, so wrap them.
export class ApiNetworkError extends Error {
  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : "Network request failed");
    this.name = "ApiNetworkError";
  }
}

export class ApiHttpError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.name = "ApiHttpError";
    this.status = status;
  }
}

async function doFetch(input: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (e) {
    throw new ApiNetworkError(e);
  }
}

const BASE = process.env.EXPO_PUBLIC_BACKEND_URL!;
const API = `${BASE}/api`;

let accessToken: string | null = null;
let refreshing: Promise<string | null> | null = null;

export const setAccessToken = (t: string | null) => {
  accessToken = t;
};
export const getAccessToken = () => accessToken;

export const REFRESH_KEY = "cf_refresh_token";

async function doRefresh(): Promise<string | null> {
  const r = await storage.secureGet<string>(REFRESH_KEY, "");
  if (!r) return null;
  try {
    const resp = await fetch(`${API}/auth/refresh`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: r }),
    });
    if (!resp.ok) {
      await storage.secureRemove(REFRESH_KEY);
      accessToken = null;
      return null;
    }
    const data = await resp.json();
    accessToken = data.access_token;
    await storage.secureSet(REFRESH_KEY, data.refresh_token);
    return accessToken;
  } catch {
    return null;
  }
}

export async function api<T = any>(
  path: string,
  opts: RequestInit & { auth?: boolean; idempotencyKey?: string } = {},
): Promise<T> {
  const { auth = true, headers, idempotencyKey, ...rest } = opts;
  const h: Record<string, string> = { "Content-Type": "application/json", ...(headers as any) };
  if (auth && accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  if (idempotencyKey) h["Idempotency-Key"] = idempotencyKey;

  let resp = await doFetch(`${API}${path}`, { ...rest, headers: h });
  if (resp.status === 401 && auth) {
    if (!refreshing) refreshing = doRefresh();
    const newTok = await refreshing;
    refreshing = null;
    if (newTok) {
      h["Authorization"] = `Bearer ${newTok}`;
      resp = await doFetch(`${API}${path}`, { ...rest, headers: h });
    }
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const j = await resp.json();
      detail = j.detail || JSON.stringify(j);
    } catch {}
    throw new ApiHttpError(resp.status, detail);
  }
  const text = await resp.text();
  if (!text) return undefined as unknown as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export async function apiUpload<T = any>(path: string, formData: FormData): Promise<T> {
  const h: Record<string, string> = {};
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  let resp = await doFetch(`${API}${path}`, { method: "POST", headers: h, body: formData as any });
  if (resp.status === 401) {
    if (!refreshing) refreshing = doRefresh();
    const newTok = await refreshing;
    refreshing = null;
    if (newTok) {
      h["Authorization"] = `Bearer ${newTok}`;
      resp = await doFetch(`${API}${path}`, { method: "POST", headers: h, body: formData as any });
    }
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      detail = body.detail || JSON.stringify(body);
    } catch {}
    throw new ApiHttpError(resp.status, detail);
  }
  return resp.json() as Promise<T>;
}

/**
 * Fetch a binary endpoint with auth and return a URL an <Image> can render.
 *
 * Attachment downloads are token-protected, so an <img src> pointed straight
 * at the API would 401. Web gets an object URL (cheap, revocable); native has
 * no URL.createObjectURL, so it gets a base64 data URI.
 *
 * On web the caller owns the returned URL and must revoke it — see
 * releaseMediaUrl.
 */
export async function apiMediaUrl(path: string): Promise<string> {
  const h: Record<string, string> = {};
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  let resp = await doFetch(`${API}${path}`, { headers: h });
  if (resp.status === 401) {
    if (!refreshing) refreshing = doRefresh();
    const newTok = await refreshing;
    refreshing = null;
    if (newTok) {
      h["Authorization"] = `Bearer ${newTok}`;
      resp = await doFetch(`${API}${path}`, { headers: h });
    }
  }
  if (!resp.ok) throw new ApiHttpError(resp.status, `HTTP ${resp.status}`);
  const blob = await resp.blob();
  if (Platform.OS === "web") return URL.createObjectURL(blob);
  return await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("Attachment could not be read"));
    reader.onloadend = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

/**
 * Fetch a binary endpoint (exports, stored files, import review sheets) with auth and silent refresh.
 * Returns the blob plus the filename the server chose and, when present, the stored-file id.
 */
export async function apiBlob(path: string): Promise<{ blob: Blob; filename: string; fileId: string | null }> {
  const h: Record<string, string> = {};
  if (accessToken) h["Authorization"] = `Bearer ${accessToken}`;
  let resp = await doFetch(`${API}${path}`, { headers: h });
  if (resp.status === 401) {
    if (!refreshing) refreshing = doRefresh();
    const newTok = await refreshing;
    refreshing = null;
    if (newTok) {
      h["Authorization"] = `Bearer ${newTok}`;
      resp = await doFetch(`${API}${path}`, { headers: h });
    }
  }
  if (!resp.ok) {
    let detail = `HTTP ${resp.status}`;
    try {
      const body = await resp.json();
      detail = body.detail || JSON.stringify(body);
    } catch {}
    throw new ApiHttpError(resp.status, detail);
  }
  const disposition = resp.headers.get("content-disposition") || "";
  const match = /filename="?([^";]+)"?/i.exec(disposition);
  return { blob: await resp.blob(), filename: match?.[1] || "mobileops-file", fileId: resp.headers.get("x-file-id") };
}

export const releaseMediaUrl = (url: string | null) => {
  if (url && Platform.OS === "web" && url.startsWith("blob:")) URL.revokeObjectURL(url);
};

export const apiBaseUrl = () => API;
