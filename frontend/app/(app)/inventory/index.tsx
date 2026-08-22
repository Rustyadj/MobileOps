// Inventory section landing — mobile "Inventory" tab target; also reachable
// from the desktop sidebar. Shows live counts so it's useful, not just a menu.
import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

export default function InventoryIndex() {
  const router = useRouter();
  const [equipCount, setEquipCount] = useState<number | null>(null);
  const [locationCount, setLocationCount] = useState<number | null>(null);
  const [pendingCounts, setPendingCounts] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [equipment, counts] = await Promise.all([
        api<any[]>("/equipment").catch(() => []),
        api<{ status: string }[]>("/inventory-counts").catch(() => []),
      ]);
      setEquipCount(equipment.length);
      setLocationCount(new Set(equipment.map((e) => e.location).filter(Boolean)).size);
      setPendingCounts(counts.filter((count) => count.status === "pending").length);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = [
    { label: "Equipment", sub: `${equipCount ?? "—"} SKUs owned`, route: "/(app)/inventory/equipment", icon: "cube-outline" as const, testID: "inventory-equipment" },
    { label: "Yard Inventory", sub: `${locationCount ?? "—"} yard locations`, route: "/(app)/inventory/yard", icon: "business-outline" as const, testID: "inventory-yard" },
    { label: "Transfers", sub: "Move stock between yards", route: "/(app)/inventory/transfers", icon: "swap-horizontal-outline" as const, testID: "inventory-transfers" },
    { label: "Inventory Counts", sub: `${pendingCounts ?? "—"} physical counts pending`, route: "/(app)/inventory/counts", icon: "clipboard-outline" as const, testID: "inventory-counts" },
  ];

  return (
    <Screen title="Inventory" subtitle="Equipment · Yard · Transfers · Counts" onRefresh={load} testID="inventory-index-screen">
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
