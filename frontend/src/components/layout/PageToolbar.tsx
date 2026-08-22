// Row of filters/actions above a table or list. Wraps on narrow widths.
import React from "react";
import { View, StyleSheet } from "react-native";
import { spacing } from "@/src/theme";

export const PageToolbar: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <View style={styles.wrap}>{children}</View>
);

const styles = StyleSheet.create({
  wrap: { flexDirection: "row", flexWrap: "wrap", alignItems: "center", gap: spacing.sm, paddingHorizontal: spacing.xl, marginBottom: spacing.md },
});
