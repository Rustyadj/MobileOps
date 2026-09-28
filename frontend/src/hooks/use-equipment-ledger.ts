// One fetch of /equipment, shared by every Inventory screen, exposed as
// ledger rollups. Screens must not re-derive counts from raw buckets — call
// byCategory / forCategories / forPredicate so Inventory, Rentals, Repairs
// and Tools can never disagree about what "Available" means.
import { useCallback, useMemo } from "react";
import { api } from "@/src/api/client";
import { useCachedResource } from "@/src/hooks/use-cached-resource";
import { rollupEquipment, sumRollups, EMPTY_ROLLUP, type InventoryRollup, type EquipmentBuckets } from "@/src/utils/inventory-rollup";

export type LedgerEquipment = EquipmentBuckets & {
  id: string;
  sku: string;
  qr_code?: string | null;
  name: string;
  category: string;
  model?: string;
  serial_number?: string;
  condition?: string;
  location?: string;
  notes?: string;
  tracking_type?: string;
  checked_out_to?: string;
  daily_rate?: number;
};

export function useEquipmentLedger() {
  const res = useCachedResource<LedgerEquipment>("equipment", () => api<LedgerEquipment[]>("/equipment"));
  const equipment = res.data;

  const forPredicate = useCallback(
    (predicate: (item: LedgerEquipment) => boolean): InventoryRollup => sumRollups(equipment.filter(predicate)),
    [equipment],
  );

  const forCategories = useCallback(
    (categories: Iterable<string>): InventoryRollup => {
      const keys = new Set(categories);
      return sumRollups(equipment.filter((item) => keys.has(item.category)));
    },
    [equipment],
  );

  const byCategory = useMemo(() => {
    const map = new Map<string, InventoryRollup>();
    for (const item of equipment) {
      const current = map.get(item.category) || { ...EMPTY_ROLLUP };
      const next = rollupEquipment(item);
      map.set(item.category, {
        total: current.total + next.total,
        atYard: current.atYard + next.atYard,
        out: current.out + next.out,
        reserved: current.reserved + next.reserved,
        available: current.available + next.available,
        repair: current.repair + next.repair,
        awaitingInspection: current.awaitingInspection + next.awaitingInspection,
        missing: current.missing + next.missing,
      });
    }
    return map;
  }, [equipment]);

  return {
    equipment,
    byCategory,
    forCategories,
    forPredicate,
    stale: res.stale,
    refreshing: res.refreshing,
    onRefresh: res.onRefresh,
    error: res.error,
  };
}
