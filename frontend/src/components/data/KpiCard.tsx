// Dashboard/operations KPI tile — clickable to jump to the filtered view it
// summarizes. Monospace value per design system (numbers/measurements).
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";

export const KpiCard: React.FC<{
  label: string;
  value: string;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  tone?: "default" | "accent" | "warning" | "error";
  onPress?: () => void;
  testID?: string;
}> = ({ label, value, icon, tone = "default", onPress, testID }) => {
  const toneColor = tone === "accent" ? colors.accent : tone === "warning" ? colors.warning : tone === "error" ? colors.error : colors.primary;
  const Wrapper = onPress ? TouchableOpacity : View;
  return (
    <Wrapper style={styles.card} onPress={onPress} activeOpacity={0.7} testID={testID}>
      <View style={styles.row}>
        <Text style={typo.caption}>{label}</Text>
        {icon ? <Ionicons name={icon} size={14} color={toneColor} /> : null}
      </View>
      <Text style={[styles.value, { color: toneColor === colors.primary ? colors.ink : toneColor }]}>{value}</Text>
      {onPress ? (
        <View style={styles.footer}>
          <Text style={styles.footerText}>View</Text>
          <Ionicons name="arrow-forward" size={11} color={colors.inkMuted} />
        </View>
      ) : null}
    </Wrapper>
  );
};

const styles = StyleSheet.create({
  card: {
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.bg, padding: spacing.md, minHeight: 92,
  },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between" },
  value: { fontFamily: "monospace", fontSize: 26, fontWeight: "700", marginTop: 8, color: colors.ink },
  footer: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 8 },
  footerText: { fontSize: 11, color: colors.inkMuted, fontWeight: "600" },
});
