// Repair lifecycle, mirroring server.py REPAIR_STATUSES. Ordered — the index
// is the ticket's progress through the shop.
export const REPAIR_STATUSES = [
  "reported",
  "diagnosing",
  "waiting_parts",
  "repairing",
  "ready_for_inspection",
  "ready",
  "returned_to_inventory",
] as const;

export type RepairStatus = (typeof REPAIR_STATUSES)[number];

export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  reported: "Reported",
  diagnosing: "Diagnosing",
  waiting_parts: "Waiting Parts",
  repairing: "Repairing",
  ready_for_inspection: "Ready for Inspection",
  ready: "Ready",
  returned_to_inventory: "Returned to Inventory",
};

// Tickets written before the lifecycle existed still carry these.
const LEGACY: Record<string, RepairStatus> = {
  open: "reported",
  in_progress: "repairing",
  resolved: "ready",
};

export const normalizeRepairStatus = (value?: string): RepairStatus => {
  const v = (value || "").trim().toLowerCase();
  if (LEGACY[v]) return LEGACY[v];
  return (REPAIR_STATUSES as readonly string[]).includes(v) ? (v as RepairStatus) : "reported";
};

export const isRepairClosed = (status: string) =>
  normalizeRepairStatus(status) === "returned_to_inventory";

/** Still occupying a bench — everything before the units go back. */
export const isRepairOpen = (status: string) => !isRepairClosed(status);

export const repairTone = (status: string): "error" | "warning" | "success" | "neutral" => {
  switch (normalizeRepairStatus(status)) {
    case "reported":
    case "diagnosing":
      return "error";
    case "waiting_parts":
    case "repairing":
    case "ready_for_inspection":
      return "warning";
    case "ready":
    case "returned_to_inventory":
      return "success";
    default:
      return "neutral";
  }
};

export const nextRepairStatus = (status: string): RepairStatus | null => {
  const index = REPAIR_STATUSES.indexOf(normalizeRepairStatus(status));
  return index >= 0 && index < REPAIR_STATUSES.length - 1 ? REPAIR_STATUSES[index + 1] : null;
};
