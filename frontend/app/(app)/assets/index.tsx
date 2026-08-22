// Assets section landing — mobile "Assets" tab target; also reachable from
// the desktop sidebar. Shows live counts so it's useful, not just a menu.
import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

export default function AssetsIndex() {
  const router = useRouter();
  const [equipCount, setEquipCount] = useState<number | null>(null);
  const [openMaint, setOpenMaint] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [equipment, maintenance] = await Promise.all([
        api<any[]>("/equipment").catch(() => []),
        api<any[]>("/maintenance").catch(() => []),
      ]);
      setEquipCount(equipment.length);
      setOpenMaint(maintenance.filter((m) => m.status === "open" || m.status === "in_progress").length);
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = [
    { label: "Equipment", sub: `${equipCount ?? "—"} SKUs in inventory`, route: "/(app)/assets/equipment", icon: "cube-outline" as const, testID: "assets-equipment" },
    { label: "Maintenance", sub: `${openMaint ?? "—"} open service entries`, route: "/(app)/assets/maintenance", icon: "build-outline" as const, testID: "assets-maintenance" },
  ];

  return (
    <Screen title="Assets" subtitle="Equipment · Maintenance" onRefresh={load} testID="assets-index-screen">
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
