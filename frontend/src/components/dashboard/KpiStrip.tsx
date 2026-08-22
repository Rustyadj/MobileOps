import React from "react";
import { View, StyleSheet } from "react-native";
import { colors, radii } from "@/src/theme";
import { KpiTile } from "./KpiTile";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

export const KpiStrip: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isShellWide } = useBreakpoint();
  return <View style={[styles.wrap, !isShellWide && styles.wrapMobile]} testID="dashboard-kpi-strip">{children}</View>;
};

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
  wrapMobile: { flexWrap: "wrap" },
});
