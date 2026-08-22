// Shop section landing — mobile "Shop" tab target; also reachable from the
// desktop sidebar. Shop work (tasks, staging, inspections, repairs) is
// first-class in MobileOps, not buried under Maintenance.
import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card } from "@/src/components/ui";
import { api } from "@/src/api/client";
import { colors, spacing, type as typo, radii } from "@/src/theme";

export default function ShopIndex() {
  const router = useRouter();
  const [openTasks, setOpenTasks] = useState<number | null>(null);
  const [staging, setStaging] = useState<number | null>(null);
  const [pendingInspection, setPendingInspection] = useState<number | null>(null);
  const [openRepairs, setOpenRepairs] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      const [tasks, equipment] = await Promise.all([
        api<any[]>("/shop-tasks").catch(() => []),
        api<any[]>("/equipment").catch(() => []),
      ]);
      setOpenTasks(tasks.filter((t) => t.status !== "done").length);
      setStaging(tasks.filter((t) => t.task_type === "staging" && t.status !== "done").length);
      setOpenRepairs(tasks.filter((t) => t.task_type === "repair" && t.status !== "done").length);
      setPendingInspection(equipment.reduce((sum, e) => sum + (e.pending_inspection || 0), 0));
    } catch {}
  }, []);
  useEffect(() => { load(); }, [load]);

  const items = [
    { label: "Tasks", sub: `${openTasks ?? "—"} open tasks`, route: "/(app)/shop/tasks", icon: "checkbox-outline" as const, testID: "shop-tasks" },
    { label: "Staging / Loadout", sub: `${staging ?? "—"} jobs to stage`, route: "/(app)/shop/staging", icon: "cube-outline" as const, testID: "shop-staging" },
    { label: "Inspections", sub: `${pendingInspection ?? "—"} units awaiting inspection`, route: "/(app)/shop/inspections", icon: "search-outline" as const, testID: "shop-inspections" },
    { label: "Maintenance / Repairs", sub: `${openRepairs ?? "—"} open repair tasks`, route: "/(app)/shop/maintenance", icon: "build-outline" as const, testID: "shop-maintenance" },
  ];

  return (
    <Screen title="Shop" subtitle="Tasks · Staging · Inspections · Repairs" onRefresh={load} testID="shop-index-screen">
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
