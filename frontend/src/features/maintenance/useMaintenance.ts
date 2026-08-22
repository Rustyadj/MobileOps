// Maintenance data + mutations, extracted from the route file.
import { useCallback, useState } from "react";
import { api } from "@/src/api/client";

export type MaintItem = {
  id: string; equipment_id: string; equipment_name: string; issue: string;
  action_taken: string; cost: number; status: string; serviced_at?: string | null;
  created_at: string;
};
export type Eq = { id: string; sku: string; name: string };

export const STATUSES = ["open", "in_progress", "resolved"];

export function useMaintenance() {
  const [items, setItems] = useState<MaintItem[]>([]);
  const [equipment, setEquipment] = useState<Eq[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [m, e] = await Promise.all([api<MaintItem[]>("/maintenance"), api<Eq[]>("/equipment")]);
      setItems(m); setEquipment(e);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const save = useCallback(async (editing: any) => {
    const body = {
      equipment_id: editing.equipment_id, issue: editing.issue,
      action_taken: editing.action_taken || "", cost: Number(editing.cost) || 0,
      status: editing.status || "open", serviced_at: editing.serviced_at || null,
    };
    if (editing.id) await api(`/maintenance/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/maintenance", { method: "POST", body: JSON.stringify(body) });
    await load();
  }, [load]);

  const del = useCallback(async (id: string) => {
    await api(`/maintenance/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  return { items, equipment, loading, refreshing, load, refresh, save, del };
}

export function ageDays(createdAt: string): number {
  const ms = Date.now() - new Date(createdAt).getTime();
  return Math.max(0, Math.floor(ms / 86400000));
}
