// Shared exception feed for the TopBar alert badge and Dashboard panel.
import { useCallback, useEffect, useState } from "react";
import { api } from "@/src/api/client";
import { equipmentIdentifier } from "@/src/utils/equipment-identifier";
import { DISPATCH_STATUS, isBookingActive, isDispatchLive, isRentalReturned } from "@/src/domain/status";

type RentalLine = { equipment_id: string; sku: string; name: string; qty: number; delivered_qty?: number; returned_qty: number; damaged_qty?: number };
type Rental = { id: string; customer_name: string; job_site: string; start_date: string; due_date?: string | null; status: string; lines: RentalLine[] };
type Booking = { id: string; customer_name: string; job_site: string; start_date: string; end_date: string; status: string; items: RentalLine[] };
type Equipment = {
  id: string; sku: string; qr_code?: string | null; name: string; category?: string;
  pending_inspection: number; in_maintenance: number; missing?: number;
  checked_out?: number; checked_out_to?: string; expected_return_at?: string | null;
};
type Shortage = { date: string; equipment_id: string; sku: string; name: string; shortage: number; demand: number; owned: number; jobs: string[]; outbound_id?: string };
type OutboundRisk = {
  outbound_id: string; customer_name: string; job_site: string; requested_date: string;
  risk: "green" | "yellow" | "red" | "critical"; route: string;
  lines: { equipment_id: string; name: string; requested_qty: number; available_now: number; projected_available: number; projected_shortage: number; inbound_dependency_qty?: number; preferred_equipment_match?: boolean; preference_type?: string | null; risky_returns?: unknown[] }[];
};
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
type DispatchDoc = {
  id: string; direction: "outbound" | "inbound"; status: string;
  scheduled_date: string | null; customer_name: string; job_site: string;
  rental_id: string | null; driver_name?: string; truck?: string;
  planning_only?: boolean;
};

const arrayResponse = <T,>(value: unknown): T[] => Array.isArray(value) ? value as T[] : [];
const rowsResponse = <T,>(value: unknown): T[] => {
  if (typeof value !== "object" || value === null) return [];
  return arrayResponse<T>((value as Record<string, unknown>).rows);
};

export type AttentionItem = {
  id: string;
  kind: "rental-overdue" | "due-soon" | "returning-today" | "shortage" | "future-shortage" | "return-dependency" | "preferred-equipment-conflict" | "pending-inspection" | "booking-missing-site" | "damaged-maintenance" | "count-variance" | "loadout-incomplete" | "pickup-overdue" | "inbound-not-checked-in" | "dispatch-unassigned" | "rental-no-pickup" | "outbound-today" | "inbound-today" | "tool-overdue" | "equipment-missing";
  title: string;
  subtitle: string;
  route: string;
  jobs?: string[];
};

export type AttentionData = { items: AttentionItem[]; loading: boolean; error: boolean; reload: () => Promise<void> };

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
  const [error, setError] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    let hadError = false;
    const guard = <T,>(p: Promise<T>, fallback: T): Promise<T> =>
      p.catch(() => { hadError = true; return fallback; });
    try {
      const [rentals, bookings, equipment, shortages, inventoryCounts, shopTasks, dispatches, outboundRisks] = await Promise.all([
        guard(api<unknown>("/rentals").then(arrayResponse<Rental>), []),
        guard(api<unknown>("/bookings").then(arrayResponse<Booking>), []),
        guard(api<unknown>("/equipment").then(arrayResponse<Equipment>), []),
        guard(api<unknown>("/dashboard/shortages?days=14").then(rowsResponse<Shortage>), []),
        guard(api<unknown>("/inventory-counts").then(arrayResponse<InventoryCount>), []),
        guard(api<unknown>("/shop-tasks").then(arrayResponse<ShopTask>), []),
        guard(api<unknown>("/dispatches").then(arrayResponse<DispatchDoc>), []),
        guard(api<unknown>("/dashboard/outbound-risks?days=30").then(rowsResponse<OutboundRisk>), []),
      ]);
      const out: AttentionItem[] = [];
      const now = new Date();
      const nextDay = new Date(now.getTime() + DAY_MS);

      for (const rental of rentals) {
        const units = outstandingUnits(rental);
        if (isRentalReturned(rental.status) || units === 0) continue;
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
            out.push({ id: `due-soon-${rental.id}-${line.equipment_id}`, kind: returningToday ? "returning-today" : "due-soon", title: `${unitLabel(line.name, lineUnits)} ${timing}`, subtitle: `Rental ${rentalLabel(rental.id)} · ${rental.customer_name}`, route: returningToday ? "/(app)/operations/inbound" : `/(app)/operations/rentals?open=${rental.id}` });
          }
        }
      }

      for (const booking of bookings) {
        if (!isBookingActive(booking.status)) continue;
        const endDate = new Date(booking.end_date);
        if (sameLocalDay(endDate, now)) {
          for (const item of booking.items) {
            if (item.qty <= 0) continue;
            out.push({ id: `returning-${booking.id}-${item.equipment_id}`, kind: "returning-today", title: `${unitLabel(item.name, item.qty)} returning today`, subtitle: `${booking.customer_name} · ${booking.job_site || "No job site"}`, route: "/(app)/operations/inbound" });
          }
        }
      }

      for (const shortage of shortages) {
        if (shortage.outbound_id) continue; // represented below with a direct outbound deep-link
        out.push({
          id: `shortage-${shortage.date}-${shortage.equipment_id}`,
          kind: "shortage",
          title: `${unitLabel(shortage.name, shortage.shortage)} short${shortage.jobs[0] ? ` for ${shortage.jobs[0]}` : ""} ${weekdayLabel(shortage.date)}`,
          subtitle: `${dateLabel(shortage.date)} · ${shortage.demand} needed / ${shortage.owned} owned · ${shortage.jobs.length} job${shortage.jobs.length === 1 ? "" : "s"}`,
          route: `/(app)/operations/capacity?date=${shortage.date}`,
          jobs: shortage.jobs,
        });
      }

      for (const risk of outboundRisks) {
        for (const line of risk.lines) {
          const customer = risk.customer_name || risk.job_site || "Outbound";
          if (line.projected_shortage > 0) {
            out.push({ id: `forecast-shortage-${risk.outbound_id}-${line.equipment_id}`, kind: "future-shortage", title: `Future Shortage · ${customer}`, subtitle: `${risk.requested_date} · ${line.name} · ${line.projected_shortage} units short`, route: risk.route });
          } else if ((line.inbound_dependency_qty || 0) > 0 || (line.risky_returns?.length || 0) > 0) {
            const dependency = line.inbound_dependency_qty || 0;
            out.push({ id: `return-dependency-${risk.outbound_id}-${line.equipment_id}`, kind: "return-dependency", title: `Return Dependency · ${customer}`, subtitle: `${risk.requested_date} · ${line.name} depends on ${dependency} inbound unit${dependency === 1 ? "" : "s"}`, route: risk.route });
          } else if ((line.preference_type === "preferred" || line.preference_type === "required") && !line.preferred_equipment_match) {
            const percent = line.requested_qty ? Math.min(100, Math.round(line.projected_available / line.requested_qty * 100)) : 0;
            out.push({ id: `preference-conflict-${risk.outbound_id}-${line.equipment_id}`, kind: "preferred-equipment-conflict", title: `Preferred Equipment Conflict · ${customer}`, subtitle: `${line.name} · ${percent}% currently fulfillable`, route: risk.route });
          }
        }
      }

      const activeRepairByEquipment = new Map<string, ShopTask>();
      for (const task of shopTasks) {
        if (task.task_type === "repair" && task.status !== "done" && task.related_equipment_id) {
          activeRepairByEquipment.set(task.related_equipment_id, task);
        }
      }
      for (const item of equipment) {
        if (item.pending_inspection > 0) {
          out.push({ id: `inspection-${item.id}`, kind: "pending-inspection", title: `${unitLabel(item.name, item.pending_inspection)} returned awaiting inspection`, subtitle: equipmentIdentifier(item), route: "/(app)/shop/inspections" });
        }
        if (item.in_maintenance > 0) {
          const repairTask = activeRepairByEquipment.get(item.id);
          out.push({ id: `maintenance-${item.id}`, kind: "damaged-maintenance", title: `${unitLabel(item.name, item.in_maintenance)} ${item.in_maintenance === 1 ? "needs" : "need"} repair`, subtitle: `${equipmentIdentifier(item)} · repair queue`, route: repairTask ? `/(app)/shop/tasks?open=${repairTask.id}` : `/(app)/shop/maintenance?equipment=${item.id}` });
        }
      }

      for (const booking of bookings) {
        if (isBookingActive(booking.status) && !booking.job_site.trim()) {
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

      const liveDispatches = dispatches.filter((d) => isDispatchLive(d.status));
      for (const d of liveDispatches) {
        const label = d.job_site || d.customer_name;
        if (d.direction === "inbound") {
          if (d.scheduled_date && new Date(d.scheduled_date) < now && d.status === DISPATCH_STATUS.scheduled) {
            out.push({ id: `pickup-overdue-${d.id}`, kind: "pickup-overdue", title: `${d.customer_name} pickup overdue`, subtitle: `${label} · was scheduled ${new Date(d.scheduled_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, route: `/(app)/operations/dispatch?open=${d.id}` });
          }
          if (d.status === DISPATCH_STATUS.atYard) {
            out.push({ id: `not-checked-in-${d.id}`, kind: "inbound-not-checked-in", title: `${d.customer_name} arrived at yard, not checked in`, subtitle: label, route: `/(app)/operations/dispatch?open=${d.id}` });
          }
        }
        const needsAssignment = !d.planning_only && (d.direction === "outbound" ? ([DISPATCH_STATUS.loaded, DISPATCH_STATUS.dispatched] as string[]).includes(d.status) : d.status !== DISPATCH_STATUS.scheduled);
        if (needsAssignment && !d.driver_name?.trim()) {
          out.push({ id: `unassigned-driver-${d.id}`, kind: "dispatch-unassigned", title: `${d.customer_name} ${d.direction} has no driver assigned`, subtitle: label, route: `/(app)/operations/dispatch?open=${d.id}` });
        } else if (needsAssignment && !d.truck?.trim()) {
          out.push({ id: `unassigned-truck-${d.id}`, kind: "dispatch-unassigned", title: `${d.customer_name} ${d.direction} has no truck assigned`, subtitle: label, route: `/(app)/operations/dispatch?open=${d.id}` });
        }
      }

      // Today's movements — the two things the yard has to get right before
      // anything else, deep-linked into the matching Rentals tab.
      for (const d of liveDispatches) {
        if (!d.scheduled_date || !sameLocalDay(new Date(d.scheduled_date), now)) continue;
        const label = d.job_site || d.customer_name;
        if (d.direction === "outbound") {
          out.push({ id: `outbound-today-${d.id}`, kind: "outbound-today", title: `${d.customer_name} delivery leaves today`, subtitle: `${label} · ${d.status.replace(/_/g, " ")}`, route: `/(app)/operations/dispatch?open=${d.id}` });
        } else {
          out.push({ id: `inbound-today-${d.id}`, kind: "inbound-today", title: `${d.customer_name} pickup due in today`, subtitle: `${label} · ${d.status.replace(/_/g, " ")}`, route: `/(app)/operations/dispatch?open=${d.id}` });
        }
      }

      // Tools out past their expected return, and anything unaccounted for at
      // the last physical count.
      for (const item of equipment) {
        if ((item.checked_out || 0) > 0 && item.expected_return_at && new Date(item.expected_return_at) < now) {
          out.push({ id: `tool-overdue-${item.id}`, kind: "tool-overdue", title: `${item.name} overdue back from ${item.checked_out_to || "the field"}`, subtitle: `${equipmentIdentifier(item)} · due ${new Date(item.expected_return_at).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`, route: "/(app)/inventory/tools" });
        }
        if ((item.missing || 0) > 0) {
          out.push({ id: `missing-${item.id}`, kind: "equipment-missing", title: `${unitLabel(item.name, item.missing || 0)} missing`, subtitle: `${equipmentIdentifier(item)} · unaccounted for at last count`, route: "/(app)/inventory/counts" });
        }
      }

            const rentalsWithLivePickup = new Set(liveDispatches.filter((d) => d.direction === "inbound" && d.rental_id).map((d) => d.rental_id));
      for (const rental of rentals) {
        if (isRentalReturned(rental.status) || rentalsWithLivePickup.has(rental.id)) continue;
        // Rentals created by an outbound Dispatch completing (the primary
        // Booking -> Dispatch -> Rental path) never get a due_date — fall
        // back to the same 30-active-day threshold rental-overdue uses,
        // otherwise those rentals could sit overdue forever with no pickup
        // scheduled and never surface here.
        const threshold = rental.due_date ? new Date(rental.due_date) : new Date(new Date(rental.start_date).getTime() + ACTIVE_RENTAL_OVERDUE_DAYS * DAY_MS);
        if (threshold >= now) continue;
        const dueLabel = rental.due_date
          ? `due ${new Date(rental.due_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
          : `active since ${new Date(rental.start_date).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
        out.push({ id: `no-pickup-${rental.id}`, kind: "rental-no-pickup", title: `${rental.customer_name} rental overdue with no pickup scheduled`, subtitle: `${rental.job_site || "No job site"} · ${dueLabel}`, route: `/(app)/operations/rentals?open=${rental.id}` });
      }

      setItems(out);
      setError(hadError);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  return { items, loading, error, reload: load };
}
