// Compact dense table panel used for the dashboard's operational summaries
// (Active Rentals, Upcoming Bookings, Equipment Shortages, Maintenance
// Queue) and reused full-width for Recent Activity. Deliberately not the
// virtualized DataTable — these are 4-6 row previews, not paged lists.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "@/src/theme";

export type OpColumn<T> = {
  key: string;
  label: string;
  flex?: number;
  width?: number;
  align?: "left" | "right";
  render: (row: T) => React.ReactNode;
};

export function OperationalTable<T>({
  title, icon, columns, rows, keyExtractor, onRowPress, emptyLabel, viewAllLabel, onViewAll, testID, fullWidth, compact = false,
}: {
  title: string;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  columns: OpColumn<T>[];
  rows: T[];
  keyExtractor: (row: T) => string;
  onRowPress?: (row: T) => void;
  emptyLabel: string;
  viewAllLabel: string;
  onViewAll: () => void;
  testID?: string;
  fullWidth?: boolean;
  compact?: boolean;
}) {
  return (
    <View style={[styles.panel, fullWidth && { flex: undefined }]} testID={testID} role="table" accessibilityLabel={title}>
      <View style={[styles.header, compact && styles.headerCompact]}>
        {icon ? <Ionicons name={icon} size={16} color={colors.primary} style={{ marginRight: 7 }} /> : null}
        <Text style={styles.title} numberOfLines={1}>{title}</Text>
        <TouchableOpacity onPress={onViewAll} style={styles.headerAction} testID={testID ? `${testID}-view-all` : undefined} accessibilityLabel={viewAllLabel} accessibilityRole="button">
          <Text style={styles.headerActionText}>View All  →</Text>
        </TouchableOpacity>
      </View>

      <View style={[styles.colHeaderRow, compact && styles.colHeaderRowCompact]} role="row">
        {columns.map((c, index) => (
          <Text key={c.key} role="columnheader" style={[styles.colHeader, index < columns.length - 1 && styles.columnGap, c.width ? { width: c.width, flexGrow: 0 } : { flex: c.flex ?? 1 }, c.align === "right" && { textAlign: "right" }]} numberOfLines={1}>
            {c.label.toUpperCase()}
          </Text>
        ))}
      </View>

      {rows.length === 0 ? (
        <View style={styles.empty}><Text style={styles.emptyText}>{emptyLabel}</Text></View>
      ) : (
        rows.map((row) => {
          const Wrapper = onRowPress ? TouchableOpacity : View;
          return (
            <Wrapper key={keyExtractor(row)} style={[styles.row, compact && styles.rowCompact]} onPress={onRowPress ? () => onRowPress(row) : undefined} activeOpacity={0.6} role="row">
              {columns.map((c, index) => (
                <View key={c.key} role="cell" style={[index < columns.length - 1 && styles.columnGap, c.width ? { width: c.width, flexGrow: 0 } : { flex: c.flex ?? 1 }, c.align === "right" && { alignItems: "flex-end" }]}>
                  {c.render(row)}
                </View>
              ))}
            </Wrapper>
          );
        })
      )}

    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.lg, overflow: "hidden" },
  header: { height: 38, flexDirection: "row", alignItems: "center", paddingHorizontal: 11, borderBottomWidth: 1, borderBottomColor: colors.border },
  headerCompact: { height: 36 },
  title: { fontSize: 13, fontWeight: "800", color: colors.ink, letterSpacing: -0.1 },
  headerAction: { marginLeft: "auto", minHeight: 30, justifyContent: "center" },
  headerActionText: { fontSize: 11, fontWeight: "700", color: colors.primary },
  colHeaderRow: { flexDirection: "row", paddingHorizontal: 11, height: 24, alignItems: "center", backgroundColor: colors.bgMuted, borderBottomWidth: 1, borderBottomColor: colors.border },
  colHeaderRowCompact: { height: 22 },
  colHeader: { fontSize: 9, fontWeight: "700", color: colors.inkMuted, textTransform: "uppercase", letterSpacing: 0.3 },
  columnGap: { paddingRight: 6 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 11, minHeight: 32, borderBottomWidth: 1, borderBottomColor: colors.border },
  rowCompact: { minHeight: 27 },
  empty: { padding: 16, alignItems: "center" },
  emptyText: { fontSize: 11.5, color: colors.inkMuted },
});
