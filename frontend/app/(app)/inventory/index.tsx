// Inventory section landing — mobile "Inventory" tab target; also reachable
// from the desktop sidebar. Shows live counts so it's useful, not just a menu.
import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

export default function InventoryIndex() {
  const router = useRouter();
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
      const scaffoldCategories = new Set(["crankup_scaffold", "shoring_post"]);
      const bracingCategories = new Set(["strongback", "turnbuckle", "walkboard_bracket", "hand_rail", "tb_extension"]);
      setBracingCount(equipment.filter((item) => bracingCategories.has(item.category)).reduce((sum, item) => sum + (item.available || 0), 0));
      setScaffoldingCount(equipment.filter((item) => scaffoldCategories.has(item.category)).reduce((sum, item) => sum + (item.available || 0), 0));
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
    { label: "Scaffolding", sub: `${scaffoldingCount ?? "—"} units physically available`, route: "/(app)/inventory/scaffolding", icon: "grid-outline" as const, testID: "inventory-scaffolding" },
    { label: "Tools", sub: `${toolCount ?? "—"} tools tracked`, route: "/(app)/inventory/tools", icon: "hammer-outline" as const, testID: "inventory-tools" },
    { label: "Damaged", sub: `${damagedCount ?? "—"} types need attention`, route: "/(app)/inventory/damaged", icon: "warning-outline" as const, testID: "inventory-damaged" },
    { label: "Yard Count", sub: `${pendingCounts ?? "—"} variances awaiting review`, route: "/(app)/inventory/counts", icon: "clipboard-outline" as const, testID: "inventory-yard-count" },
  ];

  return (
    <Screen title="Inventory" subtitle="Bracing · Scaffolding · Tools · Damaged · Yard Count" onRefresh={load} testID="inventory-index-screen">
      {loadError ? <ErrorState message="Couldn't load inventory counts." onRetry={load} testID="inventory-index-error" /> : null}
      {items.map((it) => (
        <TouchableOpacity key={it.route} onPress={() => router.push(it.route as any)} activeOpacity={0.6} testID={it.testID}>
          <Card style={{ marginBottom: spacing.sm, flexDirection: "row", alignItems: "center" }}>
            <View style={{ width: 40, height: 40, borderRadius: radii.md, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center", marginRight: spacing.md }}>
              <Ionicons name={it.icon} size={20} color={colors.primary} />
            </View>
            <View style={{ flex: 1 }}>
              <Text style={typo.h3}>{it.label}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]}>{it.sub}</Text>
            </View>
            <Ionicons name="chevron-forward" size={20} color={colors.inkMuted} />
          </Card>
        </TouchableOpacity>
      ))}
    </Screen>
  );
}
