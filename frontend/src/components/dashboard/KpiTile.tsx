// Single tile within the dashboard KPI strip — icon, label, big value, meta
// line, chevron. Tiles sit edge-to-edge with subtle vertical separators so
// the row reads as one continuous strip rather than detached cards.
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
}> = ({ label, value, meta, icon, tone = "primary", last, onPress, testID }) => {
  const { isShellWide } = useBreakpoint();
  return <TouchableOpacity style={[styles.tile, !last && styles.tileBorder, !isShellWide && styles.tileMobile]} onPress={onPress} activeOpacity={0.7} testID={testID}>
    <View style={[styles.iconWrap, { backgroundColor: `${TONE_COLOR[tone]}1A` }]}>
      <Ionicons name={icon} size={15} color={TONE_COLOR[tone]} />
    </View>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={styles.label} numberOfLines={1}>{label}</Text>
      <Text style={styles.value} numberOfLines={1}>{value}</Text>
      {meta ? <Text style={styles.meta} numberOfLines={1}>{meta}</Text> : null}
    </View>
    <Ionicons name="chevron-forward" size={14} color={colors.inkMuted} />
  </TouchableOpacity>;
};

const styles = StyleSheet.create({
  tile: { flex: 1, flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 12, paddingHorizontal: 14, minWidth: 0 },
  tileBorder: { borderRightWidth: 1, borderRightColor: colors.border },
  tileMobile: { flexBasis: "50%", flexGrow: 0, borderBottomWidth: 1, borderBottomColor: colors.border },
  iconWrap: { width: 30, height: 30, borderRadius: radii.sm, alignItems: "center", justifyContent: "center" },
  label: { fontSize: 10, fontWeight: "700", color: colors.inkSecondary, textTransform: "uppercase", letterSpacing: 0.5 },
  value: { fontSize: 21, fontWeight: "700", color: colors.ink, marginTop: 2, fontFamily: "monospace" },
  meta: { fontSize: 10.5, color: colors.inkMuted, marginTop: 1 },
});
