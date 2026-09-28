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
  "future-shortage": "warning-outline",
  "return-dependency": "git-compare-outline",
  "preferred-equipment-conflict": "options-outline",
  "pending-inspection": "search-outline",
  "booking-missing-site": "location-outline",
  "damaged-maintenance": "build-outline",
  "count-variance": "clipboard-outline",
  "loadout-incomplete": "file-tray-stacked-outline",
  "pickup-overdue": "time-outline",
  "inbound-not-checked-in": "log-in-outline",
  "dispatch-unassigned": "person-remove-outline",
  "rental-no-pickup": "calendar-outline",
  "outbound-today": "arrow-up-circle-outline",
  "inbound-today": "arrow-down-circle-outline",
  "tool-overdue": "hammer-outline",
  "equipment-missing": "help-circle-outline",
};

const URGENT: Set<AttentionItem["kind"]> = new Set(["rental-overdue", "shortage", "future-shortage", "count-variance", "pickup-overdue", "rental-no-pickup", "tool-overdue", "equipment-missing"]);

export const NeedsAttention: React.FC<{
  items: AttentionItem[];
  total: number;
  onViewAll: () => void;
  onPressItem: (item: AttentionItem) => void;
}> = ({ items, total, onViewAll, onPressItem }) => (
  <View style={styles.panel} testID="dashboard-needs-attention">
    <View style={styles.header}>
      <View style={styles.headerTitle}>
        <Ionicons name="warning-outline" size={18} color={colors.error} />
        <Text style={styles.title}>Needs Attention <Text style={styles.count}>({total})</Text></Text>
      </View>
      <TouchableOpacity onPress={onViewAll} testID="needs-attention-view-all" accessibilityRole="button"><Text style={styles.viewAll}>View All  →</Text></TouchableOpacity>
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
          <TouchableOpacity key={item.id} style={styles.row} onPress={() => onPressItem(item)} activeOpacity={0.6} testID={`attention-${item.id}`} accessibilityRole="button">
            <View style={[styles.rowIcon, !urgent && styles.rowIconWarning]}>
              <Ionicons name={ICON[item.kind]} size={13} color={urgent ? colors.error : colors.warning} />
            </View>
            <View style={{ flex: 1, minWidth: 0 }}>
              <Text style={styles.rowTitle} numberOfLines={1}>{item.title}</Text>
              <Text style={styles.rowSubtitle} numberOfLines={1}>{item.subtitle}</Text>
            </View>
            <Ionicons name="chevron-forward" size={14} color={colors.inkMuted} />
          </TouchableOpacity>
        );
      })
    )}
  </View>
);

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, overflow: "hidden" },
  header: { height: 38, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerTitle: { flexDirection: "row", alignItems: "center", gap: 7 },
  title: { fontSize: 13, fontWeight: "800", color: colors.ink, letterSpacing: -0.1 },
  count: { color: colors.error },
  viewAll: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  row: { flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, minHeight: 44, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowIcon: { width: 23, height: 23, borderRadius: 12, backgroundColor: colors.errorSoft, alignItems: "center", justifyContent: "center" },
  rowIconWarning: { backgroundColor: colors.warningSoft },
  rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  rowSubtitle: { fontSize: 10.5, color: colors.inkMuted, marginTop: 1 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, padding: spacing.lg },
  emptyText: { fontSize: 12, color: colors.inkSecondary },
});
