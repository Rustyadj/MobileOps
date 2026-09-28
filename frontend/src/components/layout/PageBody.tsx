// Scrollable page content region with consistent horizontal padding and a
// desktop max-width clamp so wide monitors don't stretch forms edge to edge.
// Pass scroll={false} for pages that manage their own scrolling (e.g. tables,
// split-pane map/list layouts).
import React from "react";
import { View, ScrollView, StyleSheet, RefreshControl, StyleProp, ViewStyle } from "react-native";
import { colors, spacing, maxContentWidth } from "@/src/theme";

export const PageBody: React.FC<{
  children: React.ReactNode;
  scroll?: boolean;
  clampWidth?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
  dense?: boolean;
}> = ({ children, scroll = true, clampWidth = false, refreshing, onRefresh, style, testID, dense = false }) => {
  const inner = <View style={[clampWidth && styles.clamp, style]}>{children}</View>;
  if (!scroll) return <View style={{ flex: 1 }} testID={testID}>{inner}</View>;
  return (
    <ScrollView
      testID={testID}
      style={{ flex: 1 }}
      contentContainerStyle={[styles.scroll, dense && styles.scrollDense]}
      showsVerticalScrollIndicator={false}
      refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
    >
      {inner}
    </ScrollView>
  );
};

const styles = StyleSheet.create({
  scroll: { paddingHorizontal: spacing.xl, paddingBottom: spacing.xxl },
  scrollDense: { paddingHorizontal: 18, paddingBottom: spacing.lg },
  clamp: { maxWidth: maxContentWidth, width: "100%", alignSelf: "center" },
});
