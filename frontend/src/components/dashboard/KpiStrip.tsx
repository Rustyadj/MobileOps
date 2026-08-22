import React from "react";
import { View, StyleSheet } from "react-native";
import { colors, radii } from "@/src/theme";
import { KpiTile } from "./KpiTile";

export const KpiStrip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={styles.wrap} testID="dashboard-kpi-strip">{children}</View>
);

KpiStrip.displayName = "KpiStrip";
export { KpiTile };

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    marginBottom: 12,
  },
});
