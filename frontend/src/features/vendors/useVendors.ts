import { useCallback, useState } from "react";
import { api } from "@/src/api/client";

export type Contact = {
  id: string; company: string; contact: string; phone: string; email: string; business_address: string;
  is_homeowner: boolean; follows_current_job: boolean;
  current_job_site: string; current_job_address: string;
  current_job_lat?: number | null; current_job_lng?: number | null; current_rental_id?: string | null;
  notes: string;
};

export function useContacts() {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try { setContacts(await api<Contact[]>("/contacts")); } catch (e) { console.warn(e); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const save = useCallback(async (editing: Partial<Contact>) => {
    const body = {
      company: editing.company || "", contact: editing.contact || "",
      phone: editing.phone || "", email: editing.email || "", business_address: editing.business_address || "",
      is_homeowner: !!editing.is_homeowner,
      follows_current_job: !!editing.follows_current_job || !!editing.is_homeowner,
      notes: editing.notes || "",
    };
    if (editing.id) await api(`/contacts/${editing.id}`, { method: "PUT", body: JSON.stringify(body) });
    else await api("/contacts", { method: "POST", body: JSON.stringify(body) });
    await load();
  }, [load]);

  const del = useCallback(async (id: string) => {
    await api(`/contacts/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  return { contacts, loading, refreshing, load, refresh, save, del };
}
