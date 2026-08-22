// Equipment data + mutations + CSV import/export, extracted from the route
// file. Also pulls maintenance so the list/detail can show service status
// and history without a second round of prop drilling.
import { useCallback, useState } from "react";
import { Platform } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import * as Sharing from "expo-sharing";
import { api, apiBaseUrl, getAccessToken } from "@/src/api/client";

export const CATEGORIES: { key: string; label: string }[] = [
  { key: "all", label: "All" },
  { key: "strongback", label: "Strongback" },
  { key: "turnbuckle", label: "Turnbuckle" },
  { key: "walkboard_bracket", label: "Walkboard" },
  { key: "hand_rail", label: "Hand Rail" },
  { key: "tb_extension", label: "TB Ext" },
  { key: "crankup_scaffold", label: "Scaffold" },
];

export type Equipment = {
  id: string; sku: string; name: string; category: string;
  condition: string; location: string; daily_rate: number;
  quantity: number; available: number; notes: string;
};
export type MaintenanceEntry = {
  id: string; equipment_id: string; equipment_name: string; issue: string;
  action_taken: string; cost: number; status: string; serviced_at?: string | null;
};
export type RentalUsage = { id: string; customer_name: string; job_site: string; status: string; qty: number };

export const blankEquipment: Partial<Equipment> = {
  sku: "", name: "", category: "strongback", condition: "good",
  location: "", daily_rate: 0, quantity: 1, available: 1, notes: "",
};

export function useEquipment() {
  const [items, setItems] = useState<Equipment[]>([]);
  const [maintenance, setMaintenance] = useState<MaintenanceEntry[]>([]);
  const [rentalUsage, setRentalUsage] = useState<Record<string, RentalUsage[]>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [e, m, rentals] = await Promise.all([
        api<Equipment[]>("/equipment"),
        api<MaintenanceEntry[]>("/maintenance").catch(() => []),
        api<any[]>("/rentals").catch(() => []),
      ]);
      setItems(e); setMaintenance(m);
      const usage: Record<string, RentalUsage[]> = {};
      for (const r of rentals) {
        if (r.status === "returned") continue;
        for (const line of r.lines || []) {
          const remaining = line.qty - (line.returned_qty || 0);
          if (remaining <= 0) continue;
          if (!usage[line.equipment_id]) usage[line.equipment_id] = [];
          usage[line.equipment_id].push({ id: r.id, customer_name: r.customer_name, job_site: r.job_site, status: r.status, qty: remaining });
        }
      }
      setRentalUsage(usage);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const save = useCallback(async (editing: Partial<Equipment>) => {
    const body = {
      sku: editing.sku || "", name: editing.name || "", category: editing.category || "strongback",
      condition: editing.condition || "good", location: editing.location || "",
      daily_rate: Number(editing.daily_rate) || 0,
      quantity: Number(editing.quantity) || 1,
      available: Number(editing.available ?? editing.quantity ?? 1),
      notes: editing.notes || "",
    };
    if (editing.id) {
      await api(`/equipment/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
    } else {
      await api("/equipment", { method: "POST", body: JSON.stringify(body) });
    }
    await load();
  }, [load]);

  const del = useCallback(async (id: string) => {
    await api(`/equipment/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  const exportCSV = useCallback(async () => {
    const tok = getAccessToken();
    const resp = await fetch(`${apiBaseUrl()}/equipment/export.csv`, { headers: { Authorization: `Bearer ${tok}` } });
    const text = await resp.text();
    if (Platform.OS === "web") {
      const blob = new Blob([text], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "equipment.csv"; a.click();
      URL.revokeObjectURL(url);
    } else {
      const path = (FileSystem.documentDirectory || "") + "equipment.csv";
      await FileSystem.writeAsStringAsync(path, text);
      if (await Sharing.isAvailableAsync()) await Sharing.shareAsync(path);
    }
  }, []);

  const importCSV = useCallback(async (): Promise<number | null> => {
    const res = await DocumentPicker.getDocumentAsync({ type: ["text/csv", "text/comma-separated-values", "application/csv", "*/*"] });
    if (res.canceled || !res.assets?.[0]) return null;
    const file = res.assets[0];
    const form = new FormData();
    // @ts-ignore RN file shape
    form.append("file", { uri: file.uri, name: file.name || "equipment.csv", type: file.mimeType || "text/csv" } as any);
    const tok = getAccessToken();
    const resp = await fetch(`${apiBaseUrl()}/equipment/import.csv`, { method: "POST", headers: { Authorization: `Bearer ${tok}` }, body: form as any });
    const j = await resp.json();
    await load();
    return j.imported ?? 0;
  }, [load]);

  return { items, maintenance, rentalUsage, loading, refreshing, load, refresh, save, del, exportCSV, importCSV };
}
