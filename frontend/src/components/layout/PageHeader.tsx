// Desktop/tablet page header — title, subtitle, and right-aligned actions.
// On phone, screens keep using the existing <Screen> header instead.
import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { spacing, type as typo } from "@/src/theme";

export const PageHeader: React.FC<{
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
  testID?: string;
}> = ({ title, subtitle, actions, testID }) => (
  <View style={styles.wrap} testID={testID}>
    <View style={{ flex: 1, minWidth: 0 }}>
      <Text style={typo.h1} numberOfLines={1}>{title}</Text>
      {subtitle ? <Text style={[typo.bodySmall, { marginTop: 4 }]}>{subtitle}</Text> : null}
    </View>
    {actions ? <View style={styles.actions}>{actions}</View> : null}
  </View>
);

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", alignItems: "flex-start", justifyContent: "space-between", paddingHorizontal: spacing.xl, paddingTop: spacing.xl, paddingBottom: spacing.md, gap: spacing.md },
  actions: { flexDirection: "row", alignItems: "center", gap: spacing.sm, flexShrink: 0 },
});
