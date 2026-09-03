import { useCallback, useEffect, useState } from "react";
import { CategoryCardGrid } from "@/src/components/inventory/CategoryCardGrid";
import { api } from "@/src/api/client";
import { toolType as classifyToolType, TOOL_TYPE_LABELS } from "@/src/utils/equipment-taxonomy";
import { TOOL_TYPE_ICONS, TOOL_TYPE_ORDER } from "@/src/utils/inventory-categories";

export default function ToolInventoryScreen() {
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const equipment = await api<any[]>("/equipment");
      const next: Record<string, number> = {};
      for (const item of equipment) {
        if (item.category !== "tool") continue;
        const key = classifyToolType(item);
        next[key] = (next[key] || 0) + 1;
      }
      setCounts(next);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const presentTypes = TOOL_TYPE_ORDER.filter((key) => (counts?.[key] ?? 0) > 0);

  return (
    <CategoryCardGrid
      title="Tools"
      subtitle="By tool type"
      testID="tools-index-screen"
      onRefresh={load}
      loadError={loadError}
      emptyLabel={counts ? "No tools tracked yet." : undefined}
      items={presentTypes.map((key) => ({
        label: TOOL_TYPE_LABELS[key],
        sub: `${counts?.[key]} tools tracked`,
        route: `/(app)/inventory/tools/${key}`,
        icon: TOOL_TYPE_ICONS[key] || "hammer-outline",
        testID: `inventory-tool-type-${key}`,
      }))}
    />
  );
}
