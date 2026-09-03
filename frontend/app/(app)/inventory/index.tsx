// Inventory section landing — mobile "Inventory" tab target; also reachable
// from the desktop sidebar. Mirrors the sidebar's top-level groups; tapping
// Bracing / Crankups & Shoring / Tools opens a landing page that groups
// their categories (Stiffbacks, Turnbuckles, Circular Saw, …).
import { useCallback, useEffect, useState } from "react";
import { CategoryCardGrid } from "@/src/components/inventory/CategoryCardGrid";
import { api } from "@/src/api/client";
import { BRACING_CATEGORIES, SCAFFOLDING_CATEGORIES } from "@/src/utils/inventory-categories";

export default function InventoryIndex() {
  const [bracingCount, setBracingCount] = useState<number | null>(null);
  const [scaffoldingCount, setScaffoldingCount] = useState<number | null>(null);
  const [toolCount, setToolCount] = useState<number | null>(null);
  const [damagedCount, setDamagedCount] = useState<number | null>(null);
  const [pendingCounts, setPendingCounts] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [equipment, counts] = await Promise.all([
        api<any[]>("/equipment"),
        api<{ status: string }[]>("/inventory-counts"),
      ]);
      const bracingKeys = new Set(BRACING_CATEGORIES.map((c) => c.key));
      const scaffoldingKeys = new Set(SCAFFOLDING_CATEGORIES.map((c) => c.key));
      setBracingCount(equipment.filter((item) => bracingKeys.has(item.category)).reduce((sum, item) => sum + (item.available || 0), 0));
      setScaffoldingCount(equipment.filter((item) => scaffoldingKeys.has(item.category)).reduce((sum, item) => sum + (item.available || 0), 0));
      setToolCount(equipment.filter((item) => item.category === "tool").length);
      setDamagedCount(equipment.filter((item) => (item.in_maintenance || 0) > 0 || ["poor", "broken", "damaged"].includes(item.condition)).length);
      setPendingCounts(counts.filter((count) => count.status === "pending").length);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = [
    { label: "Bracing", sub: `${bracingCount ?? "—"} units physically available`, route: "/(app)/inventory/bracing", icon: "construct-outline" as const, testID: "inventory-bracing" },
    { label: "Crankups & Shoring", sub: `${scaffoldingCount ?? "—"} units physically available`, route: "/(app)/inventory/scaffolding", icon: "grid-outline" as const, testID: "inventory-scaffolding" },
    { label: "Tools", sub: `${toolCount ?? "—"} tools tracked`, route: "/(app)/inventory/tools", icon: "hammer-outline" as const, testID: "inventory-tools" },
    { label: "Consumables", sub: "Tap to view", route: "/(app)/inventory/consumables", icon: "flask-outline" as const, testID: "inventory-consumables" },
    { label: "ICF Block", sub: "Tap to view", route: "/(app)/inventory/block", icon: "layers-outline" as const, testID: "inventory-block" },
    { label: "Damaged", sub: `${damagedCount ?? "—"} types need attention`, route: "/(app)/inventory/damaged", icon: "warning-outline" as const, testID: "inventory-damaged" },
    { label: "Yard Count", sub: `${pendingCounts ?? "—"} variances awaiting review`, route: "/(app)/inventory/counts", icon: "clipboard-outline" as const, testID: "inventory-yard-count" },
  ];

  return (
    <CategoryCardGrid
      title="Inventory"
      subtitle="Bracing · Crankups & Shoring · Tools · Consumables · ICF Block · Damaged · Yard Count"
      testID="inventory-index-screen"
      back={false}
      onRefresh={load}
      loadError={loadError}
      items={items}
    />
  );
}
