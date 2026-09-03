// Inventory section landing — mobile "Inventory" tab target; also reachable
// from the desktop sidebar. Shows live counts so it's useful, not just a menu.
import { useCallback, useEffect, useState } from "react";
import { View, Text, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { Screen } from "@/src/components/Screen";
import { Card, SectionLabel } from "@/src/components/ui";
import { ErrorState } from "@/src/components/feedback/ErrorState";
import { api } from "@/src/api/client";
import { toolType as classifyToolType, TOOL_TYPE_LABELS } from "@/src/utils/equipment-taxonomy";
import { colors, spacing, type as typo, radii } from "@/src/theme";

const CATEGORY_CARDS = [
  { category: "strongback", label: "Stiffbacks", icon: "remove-outline" as const, testID: "inventory-stiffbacks", route: "/(app)/inventory/stiffbacks" },
  { category: "turnbuckle", label: "Turnbuckles", icon: "sync-outline" as const, testID: "inventory-turnbuckles", route: "/(app)/inventory/turnbuckles" },
  { category: "walkboard_bracket", label: "Walk-Board Brackets", icon: "walk-outline" as const, testID: "inventory-walkboard-brackets", route: "/(app)/inventory/walkboard-brackets" },
  { category: "hand_rail", label: "Handrails", icon: "hand-left-outline" as const, testID: "inventory-handrails", route: "/(app)/inventory/handrails" },
  { category: "tb_extension", label: "Extensions", icon: "resize-outline" as const, testID: "inventory-extensions", route: "/(app)/inventory/extensions" },
  { category: "crankup_scaffold", label: "Crankups", icon: "trending-up-outline" as const, testID: "inventory-crankups", route: "/(app)/inventory/crankups" },
  { category: "shoring_post", label: "Shoring", icon: "shield-outline" as const, testID: "inventory-shoring", route: "/(app)/inventory/shoring" },
];

const TOOL_TYPE_ICONS: Record<string, React.ComponentProps<typeof Ionicons>["name"]> = {
  battery_charger: "battery-charging-outline",
  circular_saw: "disc-outline",
  sawzall: "pulse-outline",
  miter_saw: "cut-outline",
  table_saw: "grid-outline",
  band_saw: "infinite-outline",
  jigsaw: "extension-puzzle-outline",
  other_saw: "cut-outline",
  hammer_drill: "hammer-outline",
  impact: "flash-outline",
  drill: "build-outline",
  grinder: "settings-outline",
  compressor: "speedometer-outline",
  laser_level: "scan-outline",
  concrete_tools: "cube-outline",
  nailer: "git-commit-outline",
  blower: "cloud-outline",
  other_tools: "ellipsis-horizontal-circle-outline",
};
// Preserves TOOL_TYPE_LABELS' declared order so cards read Battery/Charger,
// saw types, drills, then everything else — matching how the yard thinks
// about tool categories rather than an alphabetical shuffle.
const TOOL_TYPE_ORDER = Object.keys(TOOL_TYPE_LABELS);

export default function InventoryIndex() {
  const router = useRouter();
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number> | null>(null);
  const [toolTypeCounts, setToolTypeCounts] = useState<Record<string, number> | null>(null);
  const [damagedCount, setDamagedCount] = useState<number | null>(null);
  const [pendingCounts, setPendingCounts] = useState<number | null>(null);
  const [loadError, setLoadError] = useState(false);

  const load = useCallback(async () => {
    try {
      const [equipment, counts] = await Promise.all([
        api<any[]>("/equipment"),
        api<{ status: string }[]>("/inventory-counts"),
      ]);
      const counted: Record<string, number> = {};
      for (const card of CATEGORY_CARDS) {
        counted[card.category] = equipment.filter((item) => item.category === card.category).reduce((sum, item) => sum + (item.available || 0), 0);
      }
      setCategoryCounts(counted);
      const toolCounts: Record<string, number> = {};
      for (const item of equipment) {
        if (item.category !== "tool") continue;
        const key = classifyToolType(item);
        toolCounts[key] = (toolCounts[key] || 0) + 1;
      }
      setToolTypeCounts(toolCounts);
      setDamagedCount(equipment.filter((item) => (item.in_maintenance || 0) > 0 || ["poor", "broken", "damaged"].includes(item.condition)).length);
      setPendingCounts(counts.filter((count) => count.status === "pending").length);
      setLoadError(false);
    } catch {
      setLoadError(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  const bracingItems = CATEGORY_CARDS.map((card) => ({
    label: card.label,
    sub: `${categoryCounts?.[card.category] ?? "—"} units physically available`,
    route: card.route,
    icon: card.icon,
    testID: card.testID,
  }));
  const toolItems = TOOL_TYPE_ORDER
    .filter((key) => (toolTypeCounts?.[key] ?? 0) > 0)
    .map((key) => ({
      label: TOOL_TYPE_LABELS[key],
      sub: `${toolTypeCounts?.[key]} tools tracked`,
      route: `/(app)/inventory/tools/${key}`,
      icon: TOOL_TYPE_ICONS[key] || "hammer-outline",
      testID: `inventory-tool-type-${key}`,
    }));
  const otherItems = [
    { label: "Damaged", sub: `${damagedCount ?? "—"} types need attention`, route: "/(app)/inventory/damaged", icon: "warning-outline" as const, testID: "inventory-damaged" },
    { label: "Yard Count", sub: `${pendingCounts ?? "—"} variances awaiting review`, route: "/(app)/inventory/counts", icon: "clipboard-outline" as const, testID: "inventory-yard-count" },
  ];

  const renderCard = (it: { label: string; sub: string; route: string; icon: React.ComponentProps<typeof Ionicons>["name"]; testID: string }) => (
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
  );

  return (
    <Screen title="Inventory" subtitle="Bracing · Scaffolding · Tools · Damaged · Yard Count" onRefresh={load} testID="inventory-index-screen">
      {loadError ? <ErrorState message="Couldn't load inventory counts." onRetry={load} testID="inventory-index-error" /> : null}
      <SectionLabel>Bracing & Scaffolding</SectionLabel>
      {bracingItems.map(renderCard)}
      <SectionLabel>Tools</SectionLabel>
      {toolItems.length ? toolItems.map(renderCard) : <Text style={[typo.bodySmall, { marginBottom: spacing.md }]}>No tools tracked yet.</Text>}
      <SectionLabel>Other</SectionLabel>
      {otherItems.map(renderCard)}
    </Screen>
  );
}
