// Shared "what needs attention" computation — powers the TopBar alert badge
// and the Dashboard's Needs Attention panel. Everything here is derived
// client-side from existing list/capacity endpoints; no new backend contract.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/src/api/client";

export type AttentionItem = {
  id: string;
  kind: "overdue" | "low-availability" | "missing-location" | "open-maintenance" | "booking-conflict";
  title: string;
  subtitle: string;
  route: string;
};

export type AttentionData = {
  items: AttentionItem[];
  loading: boolean;
  reload: () => Promise<void>;
};

const UPCOMING_DAYS = 14;

export function useNeedsAttention(): AttentionData {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rentals, equipment, maintenance, bookings] = await Promise.all([
        api<any[]>("/rentals").catch(() => []),
        api<any[]>("/equipment").catch(() => []),
        api<any[]>("/maintenance").catch(() => []),
        api<any[]>("/bookings").catch(() => []),
      ]);

      const out: AttentionItem[] = [];
      const now = new Date();

      for (const r of rentals) {
        if (r.status === "returned") continue;
        if (r.due_date && new Date(r.due_date) < now) {
          out.push({
            id: `overdue-${r.id}`,
            kind: "overdue",
            title: `${r.customer_name} — return overdue`,
            subtitle: r.job_site || "No job site",
            route: `/(app)/operations/rentals?open=${r.id}`,
          });
        }
        if (r.lat == null || r.lng == null) {
          out.push({
            id: `noloc-${r.id}`,
            kind: "missing-location",
            title: `${r.customer_name} — no location set`,
            subtitle: r.job_site || "Set a job-site pin",
            route: `/(app)/operations/rentals?open=${r.id}`,
          });
        }
      }

      for (const e of equipment) {
        if ((e.available ?? 0) <= 0 && (e.quantity ?? 0) > 0) {
          out.push({
            id: `lowavail-${e.id}`,
            kind: "low-availability",
            title: `${e.name} — none available`,
            subtitle: `${e.sku} · 0/${e.quantity} on hand`,
            route: `/(app)/assets/equipment?open=${e.id}`,
          });
        }
      }

      for (const m of maintenance) {
        if (m.status === "open" || m.status === "in_progress") {
          out.push({
            id: `maint-${m.id}`,
            kind: "open-maintenance",
            title: `${m.equipment_name || "Equipment"} — ${m.issue}`,
            subtitle: m.status === "open" ? "Open" : "In progress",
            route: `/(app)/assets/maintenance?open=${m.id}`,
          });
        }
      }

      // Booking conflicts: check capacity on each distinct upcoming booking
      // start date (next N days) for demand exceeding on-hand quantity.
      const cutoff = new Date(now.getTime() + UPCOMING_DAYS * 86400000);
      const upcoming = bookings.filter((b: any) => {
        if (b.status === "cancelled") return false;
        const sd = new Date(b.start_date);
        return sd >= new Date(now.toDateString()) && sd <= cutoff;
      });
      const distinctDates = Array.from(new Set(upcoming.map((b: any) => b.start_date.slice(0, 10))));
      const conflictChecks = await Promise.all(
        distinctDates.map((d) => api<{ date: string; rows: any[] }>(`/bookings/capacity?target_date=${d}T00:00:00`).catch(() => null)),
      );
      for (const check of conflictChecks) {
        if (!check) continue;
        for (const row of check.rows) {
          if (row.committed > row.quantity) {
            out.push({
              id: `conflict-${check.date}-${row.equipment_id}`,
              kind: "booking-conflict",
              title: `${row.name} short ${row.committed - row.quantity} on ${check.date}`,
              subtitle: `${row.committed}/${row.quantity} committed`,
              route: `/(app)/operations/capacity?date=${check.date}`,
            });
          }
        }
      }

      setItems(out);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return { items, loading, reload: load };
}
