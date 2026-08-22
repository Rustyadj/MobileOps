// Bookings data + mutations, plus the equipment/rentals needed to compute
// capacity inline (booking detail shows a live conflict check for its
// start date instead of sending users to a separate screen to find out).
import { useCallback, useState } from "react";
import { api } from "@/src/api/client";
import { CapEquipment, CapRental } from "@/src/features/capacity/computeCapacity";

export type BookingItem = { equipment_id: string; sku: string; name: string; qty: number; daily_rate: number; returned_qty: number };
export type Booking = {
  id: string; customer_name: string; job_site: string;
  start_date: string; end_date: string; status: string;
  items: BookingItem[]; notes: string;
};

export function useBookings() {
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [equipment, setEquipment] = useState<CapEquipment[]>([]);
  const [rentals, setRentals] = useState<CapRental[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback(async () => {
    try {
      const [b, e, r] = await Promise.all([
        api<Booking[]>("/bookings"),
        api<CapEquipment[]>("/equipment").catch(() => []),
        api<CapRental[]>("/rentals").catch(() => []),
      ]);
      setBookings(b); setEquipment(e); setRentals(r);
    } catch (err) { console.warn(err); }
    finally { setLoading(false); }
  }, []);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    await load();
    setRefreshing(false);
  }, [load]);

  const save = useCallback(async (draft: any) => {
    const body = {
      customer_name: draft.customer_name,
      job_site: draft.job_site || "",
      start_date: draft.start_date,
      end_date: draft.end_date,
      status: draft.status || "tentative",
      items: (draft.items || []).map((l: BookingItem) => ({ equipment_id: l.equipment_id, sku: l.sku, name: l.name, qty: l.qty, daily_rate: l.daily_rate, returned_qty: 0 })),
      notes: draft.notes || "",
    };
    await api("/bookings", { method: "POST", body: JSON.stringify(body) });
    await load();
  }, [load]);

  const del = useCallback(async (id: string) => {
    await api(`/bookings/${id}`, { method: "DELETE" });
    await load();
  }, [load]);

  return { bookings, equipment, rentals, loading, refreshing, load, refresh, save, del };
}
