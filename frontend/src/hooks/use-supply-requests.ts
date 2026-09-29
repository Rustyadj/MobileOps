import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/api/client";
import { useRealtimeChannel } from "@/src/hooks/use-realtime-channel";
import { uuidv4 } from "@/src/utils/uuid";

// Crew supply asks ("I need 6 more turnbuckles") waiting on an admin's
// decision. Rows arrive from the Add Request form or are auto-detected from
// Live Feed posts server-side — see backend request_parser.py.
export type SupplyRequestStatus = "pending" | "approved" | "denied" | "fulfilled";

export type SupplyRequest = {
  id: string;
  item_name: string;
  qty: number;
  notes: string;
  job_site: string;
  equipment_id?: string | null;
  equipment_name?: string | null;
  status: SupplyRequestStatus;
  source: "manual" | "live_feed" | "nathan";
  source_message_id?: string | null;
  source_text: string;
  requested_by: string;
  requested_by_id?: string | null;
  created_at: string;
  decided_by?: string | null;
  decided_at?: string | null;
  decision_note?: string;
  fulfilled_by?: string | null;
  fulfilled_at?: string | null;
};

export type SupplyRequestInput = { item_name: string; qty: number; notes?: string; job_site?: string };

// Pending first (oldest first — they've waited longest), then everything
// else newest first.
const byQueueOrder = (a: SupplyRequest, b: SupplyRequest) => {
  const aPending = a.status === "pending", bPending = b.status === "pending";
  if (aPending !== bPending) return aPending ? -1 : 1;
  return aPending ? a.created_at.localeCompare(b.created_at) : b.created_at.localeCompare(a.created_at);
};

export function useSupplyRequests() {
  const [rows, setRows] = useState<SupplyRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const upsert = useCallback((row: SupplyRequest) => {
    setRows((current) => {
      const next = current.some((item) => item.id === row.id)
        ? current.map((item) => item.id === row.id ? row : item)
        : [...current, row];
      return [...next].sort(byQueueOrder);
    });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api<SupplyRequest[]>("/supply-requests");
      if (!alive.current) return;
      setRows([...response].sort(byQueueOrder));
    } catch (cause: any) {
      if (alive.current) setError(cause?.message || "Requests could not load.");
    } finally {
      if (alive.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    alive.current = true;
    load();
    return () => { alive.current = false; };
  }, [load]);

  useRealtimeChannel(useCallback((event: any) => {
    if (event.type === "ready") {
      load();
      return;
    }
    if ((event.type === "supply_request.created" || event.type === "supply_request.updated") && event.request) {
      upsert(event.request);
    }
  }, [load, upsert]));

  const create = useCallback(async (input: SupplyRequestInput) => {
    const created = await api<SupplyRequest>("/supply-requests", {
      method: "POST", body: JSON.stringify(input), idempotencyKey: uuidv4(),
    });
    upsert(created);
    return created;
  }, [upsert]);

  const setStatus = useCallback(async (id: string, status: SupplyRequestStatus, note = "") => {
    const updated = await api<SupplyRequest>(`/supply-requests/${id}/status`, {
      method: "PATCH", body: JSON.stringify({ status, note }), idempotencyKey: uuidv4(),
    });
    upsert(updated);
    return updated;
  }, [upsert]);

  const pendingCount = rows.filter((row) => row.status === "pending").length;

  return { rows, pendingCount, loading, error, reload: load, create, setStatus };
}
