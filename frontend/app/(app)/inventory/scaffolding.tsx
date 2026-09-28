// Crankups / Shoring — one row per equipment type, each with its ledger status
// (Total / Yard / Out / Reserved / Repair). Drill into a type for units.
import { useMemo } from "react";
import { Screen } from "@/src/components/Screen";
import { SectionLabel } from "@/src/components/ui";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { StatusBoard, AvailabilityNote } from "@/src/components/inventory/StatusCounts";
import { InventoryRowList, type InventoryRow } from "@/src/components/inventory/InventorySectionList";
import { useEquipmentLedger } from "@/src/hooks/use-equipment-ledger";
import { SCAFFOLDING_CATEGORIES } from "@/src/utils/inventory-categories";
import { EMPTY_ROLLUP } from "@/src/utils/inventory-rollup";
import { spacing } from "@/src/theme";

const KEYS = SCAFFOLDING_CATEGORIES.map((c) => c.key);

export default function ScaffoldingInventoryScreen() {
  const ledger = useEquipmentLedger();
  const total = useMemo(() => ledger.forCategories(KEYS), [ledger]);

  const rows: InventoryRow[] = SCAFFOLDING_CATEGORIES.map((category) => ({
    key: category.key,
    label: category.label,
    route: category.route,
    icon: category.icon,
    rollup: ledger.byCategory.get(category.key) || EMPTY_ROLLUP,
    testID: `scaffolding-${category.key}`,
  }));

  return (
    <Screen title="Crankups / Shoring" subtitle="Crankups · Shoring" onRefresh={ledger.onRefresh} refreshing={ledger.refreshing} testID="scaffolding-index-screen">
      {ledger.error && ledger.equipment.length === 0 ? (
        <ErrorState message="Couldn't load the inventory ledger." onRetry={ledger.onRefresh} testID="scaffolding-error" />
      ) : null}
      <SectionLabel>All Crankups / Shoring</SectionLabel>
      <StatusBoard rollup={total} testID="scaffolding-status" />
      <AvailabilityNote />
      <SectionLabel style={{ marginTop: spacing.lg }}>By type</SectionLabel>
      <InventoryRowList rows={rows} />
    </Screen>
  );
}
