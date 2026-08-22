import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii } from "@/src/theme";
import type { AttentionItem } from "@/src/hooks/use-needs-attention";

const ICON: Record<AttentionItem["kind"], React.ComponentProps<typeof Ionicons>["name"]> = {
  "rental-overdue": "time-outline",
  "due-soon": "alarm-outline",
  "returning-today": "arrow-undo-outline",
  shortage: "warning-outline",
  "pending-inspection": "search-outline",
  "booking-missing-site": "location-outline",
  "damaged-maintenance": "build-outline",
  "count-variance": "clipboard-outline",
  "loadout-incomplete": "file-tray-stacked-outline",
};

const URGENT: Set<AttentionItem["kind"]> = new Set(["rental-overdue", "shortage", "count-variance"]);

export const NeedsAttention: React.FC<{
  items: AttentionItem[];
  total: number;
  onViewAll: () => void;
  onPressItem: (item: AttentionItem) => void;
}> = ({ items, total, onViewAll, onPressItem }) => (
  <View style={styles.panel} testID="dashboard-needs-attention">
    <View style={styles.header}>
      <Text style={styles.title}>NEEDS ATTENTION</Text>
      <TouchableOpacity onPress={onViewAll} testID="needs-attention-view-all"><Text style={styles.viewAll}>View all ({total})</Text></TouchableOpacity>
    </View>
    {items.length === 0 ? (
      <View style={styles.empty}>
        <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
        <Text style={styles.emptyText}>All clear — nothing needs attention.</Text>
      </View>
    ) : (
      items.map((item) => {
        const urgent = URGENT.has(item.kind);
        return (
          <TouchableOpacity key={item.id} style={styles.row} onPress={() => onPressItem(item)} activeOpacity={0.6} testID={`attention-${item.id}`}>
            <Ionicons name={ICON[item.kind]} size={16} color={urgent ? colors.error : colors.warning} style={{ marginTop: 1 }} />
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>{item.subtitle}</Text>
            </View>
          </TouchableOpacity>
        );
      })
    )}
  </View>
);

const styles = StyleSheet.create({
  panel: { flex: 1, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  header: { height: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 },
  viewAll: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  row: { flexDirection: "row", alignItems: "flex-start", gap: 9, paddingHorizontal: 12, paddingVertical: 9, minHeight: 54, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  rowSubtitle: { fontSize: 11, color: colors.inkMuted, marginTop: 2 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, padding: spacing.lg },
  emptyText: { fontSize: 12, color: colors.inkSecondary },
});
