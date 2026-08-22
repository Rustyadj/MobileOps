// Wrapping grid — N columns on desktop, fewer on tablet, stacked on phone.
// Children are expected to be flexible-width (percentage) via minItemWidth.
import React from "react";
import { View, StyleSheet } from "react-native";
import { spacing } from "@/src/theme";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

export const ResponsiveGrid: React.FC<{
  children: React.ReactNode;
  minItemWidth?: number; // px — used to derive column count
  gap?: number;
}> = ({ children, minItemWidth = 220, gap = spacing.md }) => {
  const { width, isShellWide } = useBreakpoint();
  const usable = width - (isShellWide ? 280 : spacing.xl * 2); // rough sidebar+padding allowance
  const columns = Math.max(1, Math.min(6, Math.floor(usable / minItemWidth)));
  const itemWidth = `${100 / columns}%`;

  const items = React.Children.toArray(children);
  return (
    <View style={[styles.wrap, { marginHorizontal: -gap / 2 }]}>
      {items.map((child, i) => (
        <View key={i} style={{ width: itemWidth as any, paddingHorizontal: gap / 2, marginBottom: gap }}>
          {child}
        </View>
      ))}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap" },
});
