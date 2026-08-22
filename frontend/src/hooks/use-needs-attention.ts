// Shared exception feed for the TopBar alert badge and Dashboard panel.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/src/api/client";

type RentalLine = { qty: number; delivered_qty?: number; returned_qty: number; damaged_qty?: number };
type Rental = { id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null; status: string; lines: RentalLine[] };
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string; items: { qty: number }[] };
type Equipment = { id: string; sku: string; name: string; pending_inspection: number; in_maintenance: number };
type Shortage = { date: string; equipment_id: string; sku: string; name: string; shortage: number; demand: number; owned: number; jobs: string[] };
type InventoryCount = { id: string; equipment_id: string; equipment_name: string; variance: number; status: string; counted_at: string };
type ShopTask = { id: string; title: string; task_type: string; status: string; due_date: string | null; related_booking_id: string | null };

export type AttentionItem = {
  id: string;
  kind: "rental-overdue" | "due-soon" | "returning-today" | "shortage" | "pending-inspection" | "booking-missing-site" | "damaged-maintenance" | "count-variance" | "loadout-incomplete";
  title: string;
  subtitle: string;
  route: string;
  jobs?: string[];
};

export type AttentionData = { items: AttentionItem[]; loading: boolean; reload: () => Promise<void> };

const DAY_MS = 86_400_000;
// Rentals without a due date become exceptions after 30 active days.
const ACTIVE_RENTAL_OVERDUE_DAYS = 30;
const dateLabel = (dateOnly: string) => new Date(`${dateOnly}T12:00:00`)
  .toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" })
  .replace(",", "");
const isToday = (value: string) => {
  const d = new Date(value);
  const now = new Date();
  return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
};
const outstandingUnits = (rental: Rental) => rental.lines.reduce((sum, line) => {
  const delivered = (line.delivered_qty ?? 0) > 0 ? line.delivered_qty ?? line.qty : line.qty;
  return sum + Math.max(0, delivered - line.returned_qty - (line.damaged_qty ?? 0));
}, 0);

export function useNeedsAttention(): AttentionData {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rentals, bookings, equipment, shortageData, inventoryCounts, shopTasks] = await Promise.all([
        api<Rental[]>("/rentals").catch(() => []),
        api<Booking[]>("/bookings").catch(() => []),
        api<Equipment[]>("/equipment").catch(() => []),
        api<{ rows: Shortage[] }>("/dashboard/shortages?days=14").catch(() => ({ rows: [] })),
        api<InventoryCount[]>("/inventory-counts").catch(() => []),
        api<ShopTask[]>("/shop-tasks").catch(() => []),
      ]);
      const out: AttentionItem[] = [];
      const now = new Date();
      const nextDay = new Date(now.getTime() + DAY_MS);

      for (const rental of rentals) {
        const units = outstandingUnits(rental);
        if (rental.status === "returned" || units === 0) continue;
        const due = rental.due_date ? new Date(rental.due_date) : null;
        const threshold = due ?? new Date(new Date(rental.start_date).getTime() + ACTIVE_RENTAL_OVERDUE_DAYS * DAY_MS);
        if (threshold < now) {
          out.push({ id: `overdue-${rental.id}`, kind: "rental-overdue", title: `${rental.customer_name} — return overdue`, subtitle: `${units} units on site · ${rental.job_site || "No job site"}`, route: `/(app)/operations/rentals?open=${rental.id}` });
        } else if (due && due <= nextDay) {
          out.push({ id: `due-soon-${rental.id}`, kind: "due-soon", title: `${rental.customer_name} — due back within 24 hours`, subtitle: `${units} units on site · ${rental.job_site || "No job site"}`, route: `/(app)/operations/rentals?open=${rental.id}` });
        }
      }

      for (const booking of bookings) {
        if (booking.status === "cancelled") continue;
        if (isToday(booking.end_date)) {
          const qty = booking.items.reduce((sum, i) => sum + i.qty, 0);
          if (qty > 0) {
            out.push({ id: `returning-${booking.id}`, kind: "returning-today", title: `${qty} units returning today`, subtitle: `${booking.customer_name} · ${booking.job_site || "No job site"}`, route: `/(app)/operations/returns` });
          }
        }
      }

      for (const shortage of shortageData.rows) {
        out.push({
          id: `shortage-${shortage.date}-${shortage.equipment_id}`,
          kind: "shortage",
          title: `SHORTAGE — ${shortage.shortage} ${shortage.name} — ${dateLabel(shortage.date)}`,
          subtitle: `${shortage.demand} needed / ${shortage.owned} owned · ${shortage.jobs.length} job${shortage.jobs.length === 1 ? "" : "s"}`,
          route: `/(app)/operations/capacity?date=${shortage.date}`,
          jobs: shortage.jobs,
        });
      }

      for (const item of equipment) {
        if (item.pending_inspection > 0) {
          out.push({ id: `inspection-${item.id}`, kind: "pending-inspection", title: `${item.pending_inspection} ${item.name} returned but not inspected`, subtitle: item.sku, route: `/(app)/shop/inspections` });
        }
        if (item.in_maintenance > 0) {
          out.push({ id: `maintenance-${item.id}`, kind: "damaged-maintenance", title: `${item.in_maintenance} ${item.name} damaged, need repair`, subtitle: `${item.sku} · repair queue`, route: `/(app)/shop/maintenance` });
        }
      }

      for (const booking of bookings) {
        if (booking.status !== "cancelled" && !booking.job_site.trim()) {
          out.push({ id: `booking-site-${booking.id}`, kind: "booking-missing-site", title: `${booking.customer_name} booking has no job site`, subtitle: "Add a job site before dispatch", route: `/(app)/operations/bookings?open=${booking.id}` });
        }
      }

      for (const count of inventoryCounts) {
        if (count.status === "pending" && count.variance !== 0) {
          out.push({ id: `count-${count.id}`, kind: "count-variance", title: `${count.equipment_name} count variance ${count.variance > 0 ? "+" : ""}${count.variance}`, subtitle: "Physical count needs reconciliation", route: `/(app)/inventory/counts?open=${count.id}` });
        }
      }

      const bookingById = Object.fromEntries(bookings.map((b) => [b.id, b]));
      for (const task of shopTasks) {
        if (task.task_type !== "staging" || task.status === "done") continue;
        const booking = task.related_booking_id ? bookingById[task.related_booking_id] : null;
        const startsAt = booking ? new Date(booking.start_date) : null;
        if (startsAt && startsAt <= nextDay) {
          out.push({ id: `loadout-${task.id}`, kind: "loadout-incomplete", title: `Loadout for ${booking?.job_site || booking?.customer_name || task.title} not complete`, subtitle: `Starts ${startsAt.toLocaleDateString(undefined, { weekday: "long" })}`, route: `/(app)/shop/staging` });
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
