import { useCallback, useState } from "react";
import { api } from "@/src/api/client";

export type Vendor = {
  id: string; name: string; contact_name: string; phone: string; email: string; address: string;
  categories: string[]; freight_terms: string; truck_capacity: string; lead_time_days: number; notes: string;
};

export const CATEGORY_OPTIONS = ["NUDURA", "Fox", "Amvic", "BuildBlock", "Standard"];

export function useVendors() {
  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setVendors(await api<Vendor[]>("/vendors")); } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const save = useCallback(async (editing: Partial<Vendor>) => {
    const body = {
      name: editing.name || "", contact_name: editing.contact_name || "",
      phone: editing.phone || "", email: editing.email || "", address: editing.address || "",
      categories: editing.categories || [], freight_terms: editing.freight_terms || "",
      truck_capacity: editing.truck_capacity || "", lead_time_days: Number(editing.lead_time_days) || 0,
      notes: editing.notes || "",
    };
    if (editing.id) await api(`/vendors/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/vendors", { method: "POST", body: JSON.stringify(body) });
    await load();
  }, [load]);

  const del = useCallback(async (id: string) => {
    await api(`/vendors/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  return { vendors, loading, refreshing, load, refresh, save, del };
}
