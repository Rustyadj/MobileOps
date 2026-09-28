// Inventory section landing. One sidebar row ("Inventory") opens this; the
// five primary categories live here as rows, not as sidebar clutter.
// Every count comes from useEquipmentLedger -> rollupEquipment, the single
// authoritative read of the backend inventory ledger.
import { useMemo } from "react";
import { View, Text } from "react-native";
import { Screen } from "@/src/components/Screen";
import { SectionLabel } from "@/src/components/ui";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { StatusBoard, AvailabilityNote } from "@/src/components/inventory/StatusCounts";
import { InventoryRowList, UtilityLinks, type InventoryRow } from "@/src/components/inventory/InventorySectionList";
import { useEquipmentLedger } from "@/src/hooks/use-equipment-ledger";
import { BRACING_CATEGORIES, SCAFFOLDING_CATEGORIES } from "@/src/utils/inventory-categories";
import { spacing, type as typo } from "@/src/theme";

const BRACING_KEYS = BRACING_CATEGORIES.map((c) => c.key);
const SCAFFOLDING_KEYS = SCAFFOLDING_CATEGORIES.map((c) => c.key);

export default function InventoryIndex() {
  const ledger = useEquipmentLedger();
  const { equipment, forCategories, forPredicate } = ledger;

  const bracing = useMemo(() => forCategories(BRACING_KEYS), [forCategories]);
  const scaffolding = useMemo(() => forCategories(SCAFFOLDING_KEYS), [forCategories]);
  const tools = useMemo(() => forPredicate((item) => item.category === "tool"), [forPredicate]);
  const rentalFleet = useMemo(
    () => forCategories([...BRACING_KEYS, ...SCAFFOLDING_KEYS]),
    [forCategories],
  );
  const toolCount = useMemo(() => equipment.filter((item) => item.category === "tool").length, [equipment]);

  const rows: InventoryRow[] = [
    { key: "bracing", label: "Bracing", sub: BRACING_CATEGORIES.map((c) => c.label).join(" · "), route: "/(app)/inventory/bracing", icon: "construct-outline", rollup: bracing, testID: "inventory-bracing" },
    { key: "scaffolding", label: "Crankups / Shoring", sub: SCAFFOLDING_CATEGORIES.map((c) => c.label).join(" · "), route: "/(app)/inventory/scaffolding", icon: "grid-outline", rollup: scaffolding, testID: "inventory-scaffolding" },
    { key: "tools", label: "Tools", sub: `${toolCount} individually tracked assets`, route: "/(app)/inventory/tools", icon: "hammer-outline", rollup: tools, testID: "inventory-tools" },
    { key: "consumables", label: "Consumables", sub: "Sold and consumed stock", route: "/(app)/inventory/consumables", icon: "flask-outline", testID: "inventory-consumables" },
    { key: "block", label: "ICF Block", sub: "Nudura · FoxBlocks · Amvic · BuildBlock", route: "/(app)/inventory/block", icon: "layers-outline", testID: "inventory-block" },
  ];

  return (
    <Screen
      title="Inventory"
      subtitle="Bracing · Crankups/Shoring · Tools · Consumables · ICF Block"
      back={false}
      onRefresh={ledger.onRefresh}
      refreshing={ledger.refreshing}
      testID="inventory-index-screen"
    >
      {ledger.error && equipment.length === 0 ? (
        <ErrorState message="Couldn't load the inventory ledger." onRetry={ledger.onRefresh} testID="inventory-index-error" />
      ) : null}

      <SectionLabel>Rental fleet — all bracing, crankups &amp; shoring</SectionLabel>
      <StatusBoard rollup={rentalFleet} testID="inventory-fleet-status" />
      <AvailabilityNote />

      <View style={{ height: spacing.lg }} />
      <SectionLabel>Categories</SectionLabel>
      <InventoryRowList rows={rows} />

      <SectionLabel style={{ marginTop: spacing.lg }}>Inventory tools</SectionLabel>
      <UtilityLinks
        links={[
          { label: "Yard Count", route: "/(app)/inventory/counts", icon: "clipboard-outline", testID: "inventory-utility-counts" },
          { label: "Transfers", route: "/(app)/inventory/transfers", icon: "swap-horizontal-outline", testID: "inventory-utility-transfers" },
          { label: "Damaged", route: "/(app)/inventory/damaged", icon: "warning-outline", badge: rentalFleet.repair + tools.repair || undefined, testID: "inventory-utility-damaged" },
          { label: "All Equipment", route: "/(app)/inventory/equipment", icon: "list-outline", testID: "inventory-utility-equipment" },
        ]}
      />
      {ledger.stale ? <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>Showing last synced counts — reconnecting.</Text> : null}
    </Screen>
  );
}
