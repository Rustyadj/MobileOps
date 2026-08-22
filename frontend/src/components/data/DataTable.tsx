// Lightweight virtualized data table for desktop/tablet screens (Equipment,
// Rentals, Bookings, Capacity, Vendors). Not a <table> — flexbox rows, so it
// behaves identically on web and native. Rows render through FlatList for
// large-dataset performance.
import React, { useCallback } from "react";
import { View, Text, StyleSheet, TouchableOpacity, FlatList, ListRenderItemInfo, StyleProp, ViewStyle } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, type as typo } from "@/src/theme";

export type ColumnDef<T> = {
  key: string;
  label: string;
  flex?: number; // relative width, default 1
  width?: number; // fixed px width, overrides flex
  align?: "left" | "right" | "center";
  render: (row: T) => React.ReactNode;
};

function DataTableInner<T>({
  columns,
  rows,
  keyExtractor,
  onRowPress,
  rowTestID,
  selectedId,
  emptyLabel = "No results.",
  sortKey,
  sortDirection = "asc",
  onSort,
}: {
  columns: ColumnDef<T>[];
  rows: T[];
  keyExtractor: (row: T) => string;
  onRowPress?: (row: T) => void;
  rowTestID?: (row: T) => string;
  selectedId?: string | null;
  emptyLabel?: string;
  sortKey?: string;
  sortDirection?: "asc" | "desc";
  onSort?: (key: string) => void;
}) {
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<T>) => {
      const id = keyExtractor(item);
      const selected = selectedId != null && id === selectedId;
      const Wrapper = onRowPress ? TouchableOpacity : View;
      return (
        <Wrapper
          style={[styles.row, selected && styles.rowSelected]}
          onPress={onRowPress ? () => onRowPress(item) : undefined}
          activeOpacity={0.6}
          testID={rowTestID ? rowTestID(item) : undefined}
        >
          {columns.map((col) => {
            const content = col.render(item);
            return (
              <View key={col.key} style={[styles.cell, col.width ? { width: col.width, flexGrow: 0 } : { flex: col.flex ?? 1 }, col.align === "right" && { alignItems: "flex-end" }, col.align === "center" && { alignItems: "center" }]}>
                {typeof content === "string" ? <Text style={typo.body} numberOfLines={1}>{content}</Text> : content}
              </View>
            );
          })}
        </Wrapper>
      );
    },
    [columns, onRowPress, rowTestID, selectedId, keyExtractor],
  );

  return (
    <View style={{ flex: 1 }}>
      <View style={styles.headerRow}>
        {columns.map((col) => {
          const active = sortKey === col.key;
          const content = (
            <View style={[styles.headerContent, col.align === "right" && { justifyContent: "flex-end" }, col.align === "center" && { justifyContent: "center" }]}>
              <Text style={[typo.label, active && { color: colors.primary }]} numberOfLines={1}>{col.label}</Text>
              {active ? <Ionicons name={sortDirection === "asc" ? "chevron-up" : "chevron-down"} size={12} color={colors.primary} /> : null}
            </View>
          );
          const cellStyle: StyleProp<ViewStyle> = [styles.cell, col.width ? { width: col.width, flexGrow: 0 } : { flex: col.flex ?? 1 }, col.align === "right" && { alignItems: "flex-end" }, col.align === "center" && { alignItems: "center" }];
          return onSort ? (
            <TouchableOpacity key={col.key} style={cellStyle} onPress={() => onSort(col.key)} activeOpacity={0.65} testID={`sort-${col.key}`}>
              {content}
            </TouchableOpacity>
          ) : (
            <View key={col.key} style={cellStyle}>{content}</View>
          );
        })}
      </View>
      {rows.length === 0 ? (
        <View style={styles.emptyWrap}><Text style={[typo.body, { color: colors.inkMuted }]}>{emptyLabel}</Text></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={keyExtractor}
          renderItem={renderItem}
          initialNumToRender={20}
          maxToRenderPerBatch={20}
          windowSize={7}
          removeClippedSubviews
        />
      )}
    </View>
  );
}

export const DataTable = React.memo(DataTableInner) as typeof DataTableInner;

const styles = StyleSheet.create({
  headerRow: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.md, height: 36,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.bgMuted,
  },
  row: {
    flexDirection: "row", alignItems: "center",
    paddingHorizontal: spacing.md, minHeight: 48,
    borderBottomWidth: 1, borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  rowSelected: { backgroundColor: colors.primarySoft },
  cell: { paddingRight: spacing.sm, justifyContent: "center" },
  headerContent: { width: "100%", flexDirection: "row", alignItems: "center", gap: 4 },
  emptyWrap: { padding: spacing.xl, alignItems: "center" },
});
