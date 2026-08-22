// Semantic status pill. Maps common status strings to success/warning/error/
// info/neutral tones so every screen renders "active"/"open"/"returned" etc
// consistently instead of ad-hoc color picks.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { colors, radii } from "@/src/theme";

export type StatusTone = "success" | "warning" | "error" | "info" | "neutral" | "accent";

const TONE_MAP: Record<StatusTone, { fg: string; bg: string }> = {
  success: { fg: colors.success, bg: colors.successSoft },
  warning: { fg: colors.warning, bg: colors.warningSoft },
  error: { fg: colors.error, bg: colors.errorSoft },
  info: { fg: colors.info, bg: colors.primarySoft },
  accent: { fg: colors.accent, bg: colors.accentSoft },
  neutral: { fg: colors.inkSecondary, bg: colors.bgTint },
};

// Best-effort status -> tone inference for the common vocab used across
// rentals/bookings/maintenance/equipment. Callers can pass `tone` explicitly
// to override.
export function toneForStatus(status: string): StatusTone {
  const s = status.toLowerCase();
  if (["returned", "resolved", "confirmed", "good"].includes(s)) return "success";
  if (["partially_returned", "in_progress", "tentative", "fair"].includes(s)) return "warning";
  if (["cancelled", "open", "poor", "broken", "conflict"].includes(s)) return "error";
  return "neutral";
}

export const StatusBadge: React.FC<{ label: string; tone?: StatusTone; testID?: string }> = ({ label, tone, testID }) => {
  const t = TONE_MAP[tone || toneForStatus(label)];
  return (
    <View testID={testID} style={[styles.pill, { backgroundColor: t.bg }]}>
      <Text style={[styles.text, { color: t.fg }]}>{label.replace(/_/g, " ")}</Text>
    </View>
  );
};

const styles = StyleSheet.create({
  pill: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: radii.sm, alignSelf: "flex-start" },
  text: { fontSize: 11, fontWeight: "700", letterSpacing: 0.2, textTransform: "capitalize" },
});
