import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/src/api/client";
import { useRealtimeChannel } from "@/src/hooks/use-realtime-channel";
import { uuidv4 } from "@/src/utils/uuid";

export type ShortageStatus = "open" | "ordered" | "resolved";

export type ShortageRow = {
  id: string;
  source: "auto" | "manual";
  item_name: string;
  qty_needed: number;
  equipment_id?: string | null;
  quantity_available?: number;
  quantity_short?: number;
  status: ShortageStatus;
  notes?: string;
  priority?: string | null;
  created_by?: string;
  created_at?: string;
  resolved_by?: string | null;
  resolved_at?: string | null;
};

export type ShortageInput = {
  item_name: string;
  qty_needed: number;
  notes?: string;
  priority?: string;
  equipment_id?: string | null;
};

// Auto rows sort first (matches the server's merged-list ordering), manual
// rows after — see backend list_shortages().
const bySourceThenCreated = (a: ShortageRow, b: ShortageRow) => {
  if (a.source !== b.source) return a.source === "auto" ? -1 : 1;
  return (b.created_at || "").localeCompare(a.created_at || "");
};

export function useShortages() {
  const [rows, setRows] = useState<ShortageRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  const upsertManual = useCallback((row: ShortageRow) => {
    setRows((current) => {
      const next = current.some((item) => item.id === row.id)
        ? current.map((item) => item.id === row.id ? row : item)
        : [...current, row];
      return [...next].sort(bySourceThenCreated);
    });
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const response = await api<{ rows: ShortageRow[] }>("/shortages");
      if (!alive.current) return;
      setRows(response.rows);
    } catch (cause: any) {
      if (alive.current) setError(cause?.message || "Shortages could not load.");
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
    if ((event.type === "shortage.created" || event.type === "shortage.updated") && event.shortage) {
      upsertManual({ ...event.shortage, source: "manual" });
    }
  }, [upsertManual]));

  const create = useCallback(async (input: ShortageInput) => {
    const created = await api<ShortageRow>("/shortages", {
      method: "POST", body: JSON.stringify(input), idempotencyKey: uuidv4(),
    });
    upsertManual({ ...created, source: "manual" });
    return created;
  }, [upsertManual]);

  const setStatus = useCallback(async (id: string, status: ShortageStatus) => {
    const updated = await api<ShortageRow>(`/shortages/${id}/status`, {
      method: "PATCH", body: JSON.stringify({ status }), idempotencyKey: uuidv4(),
    });
    upsertManual({ ...updated, source: "manual" });
    return updated;
  }, [upsertManual]);

  return { rows, loading, error, reload: load, create, setStatus };
}
