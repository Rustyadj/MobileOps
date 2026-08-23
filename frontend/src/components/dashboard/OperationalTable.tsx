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
  title, icon, columns, rows, keyExtractor, onRowPress, emptyLabel, viewAllLabel, onViewAll, testID, fullWidth,
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
}) {
  return (
    <View style={[styles.panel, fullWidth && { flex: undefined }]} testID={testID} role="table" accessibilityLabel={title}>
      <View style={styles.header}>
        {icon ? <Ionicons name={icon} size={13} color={colors.inkSecondary} style={{ marginRight: 6 }} /> : null}
        <Text style={styles.title} numberOfLines={1}>{title.toUpperCase()}</Text>
      </View>

      <View style={styles.colHeaderRow} role="row">
        {columns.map((c) => (
          <Text key={c.key} role="columnheader" style={[styles.colHeader, c.width ? { width: c.width, flexGrow: 0 } : { flex: c.flex ?? 1 }, c.align === "right" && { textAlign: "right" }]} numberOfLines={1}>
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
            <Wrapper key={keyExtractor(row)} style={styles.row} onPress={onRowPress ? () => onRowPress(row) : undefined} activeOpacity={0.6} role="row">
              {columns.map((c) => (
                <View key={c.key} role="cell" style={[c.width ? { width: c.width, flexGrow: 0 } : { flex: c.flex ?? 1 }, c.align === "right" && { alignItems: "flex-end" }]}>
                  {c.render(row)}
                </View>
              ))}
            </Wrapper>
          );
        })
      )}

      <TouchableOpacity onPress={onViewAll} style={styles.footer} testID={testID ? `${testID}-view-all` : undefined} accessibilityLabel={viewAllLabel} accessibilityRole="button">
        <Text style={styles.footerText}>{viewAllLabel}</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { flex: 1, minWidth: 0, backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, overflow: "hidden" },
  header: { height: 36, flexDirection: "row", alignItems: "center", paddingHorizontal: 11, borderBottomWidth: 1, borderBottomColor: colors.border },
  title: { fontSize: 10.5, fontWeight: "800", color: colors.ink, letterSpacing: 0.4 },
  colHeaderRow: { flexDirection: "row", paddingHorizontal: 11, height: 24, alignItems: "center", backgroundColor: colors.bgMuted, borderBottomWidth: 1, borderBottomColor: colors.border },
  colHeader: { fontSize: 9, fontWeight: "700", color: colors.inkMuted, textTransform: "uppercase", letterSpacing: 0.3 },
  row: { flexDirection: "row", alignItems: "center", paddingHorizontal: 11, minHeight: 32, borderBottomWidth: 1, borderBottomColor: colors.border },
  empty: { padding: 16, alignItems: "center" },
  emptyText: { fontSize: 11.5, color: colors.inkMuted },
  footer: { height: 28, alignItems: "center", justifyContent: "center", borderTopWidth: 0 },
  footerText: { fontSize: 11, fontWeight: "700", color: colors.primary },
});
