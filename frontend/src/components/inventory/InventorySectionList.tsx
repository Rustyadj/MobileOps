// Shared list body for the Inventory landing and each category landing page:
// a vertical row per category/type showing its ledger status strip, plus an
// optional secondary "utilities" row (Yard Count, Transfers, …) that stays
// out of the sidebar.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { StatusStrip } from "./StatusCounts";
import type { InventoryRollup } from "@/src/utils/inventory-rollup";

export type InventoryRow = {
  key: string;
  label: string;
  sub?: string;
  route: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  rollup?: InventoryRollup;
  testID: string;
};

export const InventoryRowList: React.FC<{ rows: InventoryRow[]; emptyLabel?: string }> = ({ rows, emptyLabel }) => {
  const router = useRouter();
  if (!rows.length) return emptyLabel ? <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>{emptyLabel}</Text> : null;
  return (
    <View style={styles.list}>
      {rows.map((row) => (
        <TouchableOpacity key={row.key} onPress={() => router.push(row.route as any)} activeOpacity={0.65} style={styles.row} testID={row.testID}>
          <View style={styles.iconBox}><Ionicons name={row.icon} size={18} color={colors.primary} /></View>
          <View style={{ flex: 1, minWidth: 0 }}>
            <View style={styles.titleRow}>
              <Text style={styles.label} numberOfLines={1}>{row.label}</Text>
              <Ionicons name="chevron-forward" size={16} color={colors.inkMuted} />
            </View>
            {row.sub ? <Text style={styles.sub} numberOfLines={1}>{row.sub}</Text> : null}
            {row.rollup ? <StatusStrip rollup={row.rollup} testID={`${row.testID}-status`} /> : null}
          </View>
        </TouchableOpacity>
      ))}
    </View>
  );
};

export const UtilityLinks: React.FC<{ links: { label: string; route: string; icon: React.ComponentProps<typeof Ionicons>["name"]; badge?: number; testID: string }[] }> = ({ links }) => {
  const router = useRouter();
  return (
    <View style={styles.utilRow}>
      {links.map((link) => (
        <TouchableOpacity key={link.route} onPress={() => router.push(link.route as any)} style={styles.util} activeOpacity={0.7} testID={link.testID}>
          <Ionicons name={link.icon} size={15} color={colors.inkSecondary} />
          <Text style={styles.utilText}>{link.label}</Text>
          {link.badge ? <View style={styles.utilBadge}><Text style={styles.utilBadgeText}>{link.badge}</Text></View> : null}
        </TouchableOpacity>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  list: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.md, backgroundColor: colors.bg, overflow: "hidden" },
  row: { flexDirection: "row", gap: spacing.sm, paddingVertical: spacing.sm, paddingHorizontal: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.border, alignItems: "flex-start" },
  iconBox: { width: 34, height: 34, borderRadius: radii.sm, backgroundColor: colors.primarySoft, alignItems: "center", justifyContent: "center" },
  titleRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: spacing.sm },
  label: { ...typo.h3, fontSize: 15, flex: 1 },
  sub: { ...typo.bodySmall, fontSize: 11.5, marginTop: 1 },
  utilRow: { flexDirection: "row", flexWrap: "wrap", gap: spacing.sm, marginTop: spacing.md },
  util: { flexDirection: "row", alignItems: "center", gap: 6, height: 34, paddingHorizontal: 12, borderRadius: radii.md, borderWidth: 1, borderColor: colors.border, backgroundColor: colors.bg },
  utilText: { fontSize: 12.5, fontWeight: "600", color: colors.inkSecondary },
  utilBadge: { minWidth: 18, height: 18, paddingHorizontal: 5, borderRadius: 9, backgroundColor: colors.errorSoft, alignItems: "center", justifyContent: "center" },
  utilBadgeText: { fontSize: 10.5, fontWeight: "800", color: colors.error },
});
