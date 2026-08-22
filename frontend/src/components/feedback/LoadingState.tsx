import React from "react";
import { View, Text, StyleSheet, ActivityIndicator } from "react-native";
import { colors, spacing, type as typo } from "@/src/theme";

export const LoadingState: React.FC<{ label?: string; testID?: string }> = ({ label = "Loading…", testID }) => (
  <View style={styles.wrap} testID={testID}>
    <ActivityIndicator size="small" color={colors.primary} />
    <Text style={[typo.bodySmall, { marginTop: spacing.sm }]}>{label}</Text>
  </View>
);

// Simple skeleton block for card/row placeholders while data loads.
export const SkeletonBlock: React.FC<{ height?: number; width?: number | `${number}%`; style?: any }> = ({ height = 16, width = "100%", style }) => (
  <View style={[{ height, width, backgroundColor: colors.bgTint, borderRadius: 4 }, style]} />
);

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", padding: spacing.xxl },
});
