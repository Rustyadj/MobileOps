// Single summary card within the dashboard KPI strip. The card anatomy mirrors
// the supplied operations-dashboard reference while values and destinations
// remain backed by MobileOps' live data and routes.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

export type KpiTone = "primary" | "success" | "warning" | "danger" | "info";

const TONE_COLOR: Record<KpiTone, string> = {
  primary: colors.primary,
  success: colors.success,
  warning: colors.warning,
  danger: colors.error,
  info: "#7C3AED",
};

export const KpiTile: React.FC<{
  label: string;
  value: string;
  meta?: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  tone?: KpiTone;
  last?: boolean;
  onPress: () => void;
  testID?: string;
}> = ({ label, value, meta, icon, tone = "primary", onPress, testID }) => {
  const { isShellWide } = useBreakpoint();
  const toneColor = TONE_COLOR[tone];
  return <TouchableOpacity
    style={[styles.tile, !isShellWide && styles.tileMobile]}
    onPress={onPress}
    activeOpacity={0.72}
    testID={testID}
    accessibilityRole="button"
    accessibilityLabel={`${label}: ${value}${meta ? `. ${meta}` : ""}`}
  >
    <View style={[styles.iconWrap, !isShellWide && styles.iconWrapMobile, { backgroundColor: `${toneColor}14` }]}>
      <Ionicons name={icon} size={isShellWide ? 22 : 18} color={toneColor} />
    </View>
    <View style={styles.copy}>
      <View style={styles.valueRow}>
        <Text style={styles.value} numberOfLines={1}>{value}</Text>
        <Ionicons name="chevron-forward" size={14} color={colors.inkMuted} />
      </View>
      <Text style={[styles.label, !isShellWide && styles.labelMobile]} numberOfLines={1}>{label}</Text>
      {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
    </View>
  </TouchableOpacity>;
};

const styles = StyleSheet.create({
  tile: {
    flex: 1,
    minWidth: 0,
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 14,
    paddingVertical: 8,
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.lg,
  },
  tileMobile: { flexBasis: "48%", flexGrow: 1, minWidth: 150, gap: 8, paddingHorizontal: 10 },
  iconWrap: { width: 44, height: 44, borderRadius: radii.lg, alignItems: "center", justifyContent: "center" },
  iconWrapMobile: { width: 34, height: 34 },
  copy: { flex: 1, minWidth: 0 },
  valueRow: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 6 },
  label: { fontSize: 12, fontWeight: "700", color: colors.ink, marginTop: 1 },
  labelMobile: { fontSize: 11.5 },
  value: { fontSize: 22, lineHeight: 25, fontWeight: "800", color: colors.ink, letterSpacing: -0.4 },
  meta: { fontSize: 10.5, lineHeight: 14, color: colors.inkMuted, marginTop: 1 },
});
