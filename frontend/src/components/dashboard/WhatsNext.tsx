// Dashboard "WHAT'S NEXT" panel — the next upcoming/in-progress deliveries
// and pickups in chronological order, so the shop and drivers can see at a
// glance what happens next without opening Dispatch. Unscheduled movements
// sort last (they still need a time assigned, so they're not "next").
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { StatusBadge } from "@/src/components/data/StatusBadge";
import { colors, spacing, radii } from "@/src/theme";

export type DispatchLine = { equipment_id: string; sku: string; name: string; qty: number };
export type NextMovement = {
  id: string;
  direction: "outbound" | "inbound";
  status: string;
  scheduled_date?: string | null;
  customer_name: string;
  job_site: string;
  driver_name: string;
  lines: DispatchLine[];
};

const equipmentSummary = (lines: DispatchLine[]) => {
  if (lines.length === 0) return "No equipment";
  if (lines.length === 1) return `${lines[0].qty} ${lines[0].name}`;
  const total = lines.reduce((s, l) => s + l.qty, 0);
  return `${total} units · ${lines.length} lines`;
};

const timeLabel = (value?: string | null) =>
  value ? new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric" }) : "Unscheduled";

export const WhatsNext: React.FC<{
  items: NextMovement[];
  onPressItem: (item: NextMovement) => void;
  onViewAll: () => void;
}> = ({ items, onPressItem, onViewAll }) => (
  <View style={styles.panel} testID="dashboard-whats-next">
    <View style={styles.header}>
      <Text style={styles.title}>WHAT'S NEXT</Text>
      <TouchableOpacity onPress={onViewAll} testID="whats-next-view-all"><Text style={styles.viewAll}>Open Dispatch</Text></TouchableOpacity>
    </View>
    {items.length === 0 ? (
      <View style={styles.empty}>
        <Ionicons name="checkmark-circle-outline" size={20} color={colors.success} />
        <Text style={styles.emptyText}>Nothing scheduled to go out or come back.</Text>
      </View>
    ) : (
      items.map((item) => (
        <TouchableOpacity key={item.id} style={styles.row} onPress={() => onPressItem(item)} activeOpacity={0.6} testID={`whats-next-${item.id}`}>
          <View style={styles.timeCol}>
            <Text style={styles.timeText}>{timeLabel(item.scheduled_date)}</Text>
          </View>
          <View style={[styles.dirTag, item.direction === "outbound" ? styles.dirTagOut : styles.dirTagIn]}>
            <Ionicons name={item.direction === "outbound" ? "arrow-up-outline" : "arrow-down-outline"} size={12} color={item.direction === "outbound" ? colors.primary : colors.accent} />
            <Text style={[styles.dirText, { color: item.direction === "outbound" ? colors.primary : colors.accent }]}>{item.direction === "outbound" ? "OUTBOUND" : "INBOUND"}</Text>
          </View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <Text style={styles.rowTitle} numberOfLines={1}>{item.customer_name}</Text>
            <Text style={styles.rowSubtitle} numberOfLines={1}>{equipmentSummary(item.lines)}{item.driver_name ? ` · ${item.driver_name}` : ""}</Text>
          </View>
          <StatusBadge label={item.status} />
        </TouchableOpacity>
      ))
    )}
  </View>
);

const styles = StyleSheet.create({
  panel: { backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden", marginBottom: 12 },
  header: { height: 40, flexDirection: "row", alignItems: "center", justifyContent: "space-between", paddingHorizontal: 12, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, letterSpacing: 0.5 },
  viewAll: { fontSize: 11.5, fontWeight: "700", color: colors.primary },
  row: { flexDirection: "row", alignItems: "center", gap: 10, paddingHorizontal: 12, paddingVertical: 9, minHeight: 52, borderBottomWidth: 1, borderBottomColor: colors.border },
  timeCol: { width: 78 },
  timeText: { fontSize: 12, fontWeight: "700", color: colors.ink },
  dirTag: { flexDirection: "row", alignItems: "center", gap: 4, paddingHorizontal: 6, paddingVertical: 3, borderRadius: radii.sm, width: 92, justifyContent: "center" },
  dirTagOut: { backgroundColor: colors.primarySoft },
  dirTagIn: { backgroundColor: colors.accentSoft },
  dirText: { fontSize: 10, fontWeight: "800", letterSpacing: 0.3 },
  rowTitle: { fontSize: 12.5, fontWeight: "700", color: colors.ink },
  rowSubtitle: { fontSize: 11, color: colors.inkMuted, marginTop: 2 },
  empty: { alignItems: "center", justifyContent: "center", flexDirection: "row", gap: 8, padding: spacing.lg },
  emptyText: { fontSize: 12, color: colors.inkSecondary },
});
