import { useCallback, useEffect, useState } from "react";
import { CategoryCardGrid } from "@/src/components/inventory/CategoryCardGrid";
import { api } from "@/src/api/client";
import { SCAFFOLDING_CATEGORIES } from "@/src/utils/inventory-categories";

export default function ScaffoldingInventoryScreen() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const equipment = await api<any[]>("/equipment");
      const next: Record<string, number> = {};
      for (const category of SCAFFOLDING_CATEGORIES) {
        next[category.key] = equipment.filter((item) => item.category === category.key).reduce((sum, item) => sum + (item.available || 0), 0);
      }
      setCounts(next);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  return (
    <CategoryCardGrid
      title="Crankups & Shoring"
      subtitle={SCAFFOLDING_CATEGORIES.map((c) => c.label).join(" · ")}
      testID="scaffolding-index-screen"
      onRefresh={load}
      loadError={loadError}
      items={SCAFFOLDING_CATEGORIES.map((category) => ({
        label: category.label,
        sub: `${counts?.[category.key] ?? "—"} units physically available`,
        route: category.route,
        icon: category.icon,
        testID: `scaffolding-${category.key}`,
      }))}
    />
  );
}
