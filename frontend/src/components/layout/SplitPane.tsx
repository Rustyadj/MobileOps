// Two-region layout: primary (map/table) + a fixed-ish secondary panel
// (filters/detail list). Side-by-side on tablet/desktop, stacked on phone.
// Used by the Map workspace (map + list) and any master/detail screen that
// wants panes instead of a DetailDrawer overlay.
import React from "react";
import { View, StyleSheet } from "react-native";
import { colors } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

export const SplitPane: React.FC<{
  primary: React.ReactNode;
  secondary: React.ReactNode;
  secondaryWidth?: number; // px on desktop
  primaryRatio?: number; // 0-1, used for phone stacking heights (secondary gets the rest)
}> = ({ primary, secondary, secondaryWidth = 380 }) => {
  const { isShellWide } = useBreakpoint();

  if (!isShellWide) {
    return (
      <View style={{ flex: 1 }}>
        <View style={{ flex: 1 }}>{primary}</View>
        <View style={styles.phoneSecondary}>{secondary}</View>
      </View>
    );
  }

  return (
    <View style={styles.row}>
      <View style={{ flex: 1, minWidth: 0 }}>{primary}</View>
      <View style={[styles.secondary, { width: secondaryWidth }]}>{secondary}</View>
    </View>
  );
};

const styles = StyleSheet.create({
  row: { flex: 1, flexDirection: "row" },
  secondary: { borderLeftWidth: 1, borderLeftColor: colors.border, backgroundColor: colors.bg },
  phoneSecondary: { maxHeight: "45%", borderTopWidth: 1, borderTopColor: colors.border, backgroundColor: colors.bg },
});
