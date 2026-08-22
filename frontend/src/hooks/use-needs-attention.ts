// Shared exception feed for the TopBar alert badge and Dashboard panel.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/src/api/client";

type RentalLine = { equipment_id: string; sku: string; name: string; qty: number; delivered_qty?: number; returned_qty: number; damaged_qty?: number };
type Rental = { id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null; status: string; lines: RentalLine[] };
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string; items: RentalLine[] };
type Equipment = { id: string; sku: string; name: string; pending_inspection: number; in_maintenance: number };
type Shortage = { date: string; equipment_id: string; sku: string; name: string; shortage: number; demand: number; owned: number; jobs: string[] };
type InventoryCount = { id: string; equipment_id: string; equipment_name: string; variance: number; status: string; counted_at: string };
type ShopTask = {
  id: string;
  title: string;
  task_type: "general" | "repair" | "staging" | "inspection";
  status: "to_do" | "in_progress" | "blocked" | "done";
  due_date: string | null;
  related_booking_id: string | null;
  related_equipment_id: string | null;
};

const arrayResponse = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const rowsResponse = <T,>(value: unknown): T[] => {
  if (typeof value !== "object" || value === null) return [];
  return arrayResponse<T>((value as Record<string, unknown>).rows);
};

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
const weekdayLabel = (dateOnly: string) => new Date(`${dateOnly}T12:00:00`).toLocaleDateString(undefined, { weekday: "long" });
const rentalLabel = (id: string) => id.toUpperCase().startsWith("RNT-") ? id.toUpperCase() : `RNT-${id.slice(0, 4).toUpperCase()}`;
const sameLocalDay = (left: Date, right: Date) => left.getFullYear() === right.getFullYear() && left.getMonth() === right.getMonth() && left.getDate() === right.getDate();
const lineOutstanding = (line: RentalLine) => {
  const delivered = (line.delivered_qty ?? 0) > 0 ? line.delivered_qty ?? line.qty : line.qty;
  // returned_qty already counts every physically-returned unit, damaged or
  // not — damaged_qty is a subset marker, not an additional deduction.
  return Math.max(0, delivered - line.returned_qty);
};
const outstandingUnits = (rental: Rental) => rental.lines.reduce((sum, line) => sum + lineOutstanding(line), 0);
const unitLabel = (name: string, quantity: number) => `${quantity} ${name.toLowerCase()}`;

export function useNeedsAttention(): AttentionData {
  const [items, setItems] = useState<AttentionItem[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [rentals, bookings, equipment, shortages, inventoryCounts, shopTasks] = await Promise.all([
        api<unknown>("/rentals").then(arrayResponse<Rental>).catch(() => []),
        api<unknown>("/bookings").then(arrayResponse<Booking>).catch(() => []),
        api<unknown>("/equipment").then(arrayResponse<Equipment>).catch(() => []),
        api<unknown>("/dashboard/shortages?days=14").then(rowsResponse<Shortage>).catch(() => []),
        api<unknown>("/inventory-counts").then(arrayResponse<InventoryCount>).catch(() => []),
        api<unknown>("/shop-tasks").then(arrayResponse<ShopTask>).catch(() => []),
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
          out.push({ id: `overdue-${rental.id}`, kind: "rental-overdue", title: `Rental ${rentalLabel(rental.id)} overdue`, subtitle: `${rental.customer_name} · ${units} units on site · ${rental.job_site || "No job site"}`, route: `/(app)/operations/rentals?open=${rental.id}` });
        } else if (due && due <= nextDay) {
          for (const line of rental.lines) {
            const lineUnits = lineOutstanding(line);
            if (lineUnits === 0) continue;
            const returningToday = sameLocalDay(due, now);
            const timing = returningToday ? "returning today" : `due back ${due.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
            out.push({ id: `due-soon-${rental.id}-${line.equipment_id}`, kind: returningToday ? "returning-today" : "due-soon", title: `${unitLabel(line.name, lineUnits)} ${timing}`, subtitle: `Rental ${rentalLabel(rental.id)} · ${rental.customer_name}`, route: returningToday ? "/(app)/operations/returns" : `/(app)/operations/rentals?open=${rental.id}` });
          }
        }
      }

      for (const booking of bookings) {
        if (booking.status === "cancelled") continue;
        const endDate = new Date(booking.end_date);
        if (sameLocalDay(endDate, now)) {
          for (const item of booking.items) {
            if (item.qty <= 0) continue;
            out.push({ id: `returning-${booking.id}-${item.equipment_id}`, kind: "returning-today", title: `${unitLabel(item.name, item.qty)} returning today`, subtitle: `${booking.customer_name} · ${booking.job_site || "No job site"}`, route: "/(app)/operations/returns" });
          }
        }
      }

      for (const shortage of shortages) {
        out.push({
          id: `shortage-${shortage.date}-${shortage.equipment_id}`,
          kind: "shortage",
          title: `${unitLabel(shortage.name, shortage.shortage)} short${shortage.jobs[0] ? ` for ${shortage.jobs[0]}` : ""} ${weekdayLabel(shortage.date)}`,
          subtitle: `${dateLabel(shortage.date)} · ${shortage.demand} needed / ${shortage.owned} owned · ${shortage.jobs.length} job${shortage.jobs.length === 1 ? "" : "s"}`,
          route: `/(app)/operations/capacity?date=${shortage.date}`,
          jobs: shortage.jobs,
        });
      }

      const activeRepairByEquipment = new Map<string, ShopTask>();
      for (const task of shopTasks) {
        if (task.task_type === "repair" && task.status !== "done" && task.related_equipment_id) {
          activeRepairByEquipment.set(task.related_equipment_id, task);
        }
      }
      for (const item of equipment) {
        if (item.pending_inspection > 0) {
          out.push({ id: `inspection-${item.id}`, kind: "pending-inspection", title: `${unitLabel(item.name, item.pending_inspection)} returned awaiting inspection`, subtitle: item.sku, route: "/(app)/shop/inspections" });
        }
        if (item.in_maintenance > 0) {
          const repairTask = activeRepairByEquipment.get(item.id);
          out.push({ id: `maintenance-${item.id}`, kind: "damaged-maintenance", title: `${unitLabel(item.name, item.in_maintenance)} ${item.in_maintenance === 1 ? "needs" : "need"} repair`, subtitle: `${item.sku} · repair queue`, route: repairTask ? `/(app)/shop/tasks?open=${repairTask.id}` : `/(app)/shop/maintenance?equipment=${item.id}` });
        }
      }

      for (const booking of bookings) {
        if (booking.status !== "cancelled" && !booking.job_site.trim()) {
          out.push({ id: `booking-site-${booking.id}`, kind: "booking-missing-site", title: `${booking.customer_name} booking has no job site`, subtitle: "Add a job site before dispatch", route: `/(app)/operations/bookings?open=${booking.id}` });
        }
      }

      for (const count of inventoryCounts) {
        if (count.status === "pending" && count.variance !== 0) {
          out.push({ id: `count-${count.id}`, kind: "count-variance", title: `Inventory count variance: ${count.variance > 0 ? "+" : ""}${count.variance} ${count.equipment_name.toLowerCase()}`, subtitle: "Physical count needs reconciliation", route: `/(app)/inventory/counts?open=${count.id}` });
        }
      }

      const bookingById = new Map(bookings.map((booking) => [booking.id, booking]));
      for (const task of shopTasks) {
        if (task.task_type !== "staging" || task.status === "done") continue;
        const booking = task.related_booking_id ? bookingById.get(task.related_booking_id) : undefined;
        const startsAt = booking ? new Date(booking.start_date) : task.due_date ? new Date(task.due_date) : null;
        if (!startsAt || startsAt > nextDay) continue;
        out.push({ id: `loadout-${task.id}`, kind: "loadout-incomplete", title: `Loadout for ${booking?.job_site || booking?.customer_name || task.title} not complete`, subtitle: `Starts ${startsAt.toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" })}`, route: "/(app)/shop/staging" });
      }
      setItems(out);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { items, loading, reload: load };
}
