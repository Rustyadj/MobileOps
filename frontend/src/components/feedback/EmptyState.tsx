import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, type as typo } from "@/src/theme";
import { Button } from "@/src/components/ui";

export const EmptyState: React.FC<{
  icon?: React.ComponentProps<typeof Ionicons>["name"];
  title: string;
  subtitle?: string;
  actionLabel?: string;
  onAction?: () => void;
  testID?: string;
}> = ({ icon = "file-tray-outline", title, subtitle, actionLabel, onAction, testID }) => (
  <View style={styles.wrap} testID={testID}>
    <Ionicons name={icon} size={32} color={colors.inkMuted} />
    <Text style={[typo.h3, { marginTop: spacing.sm, textAlign: "center" }]}>{title}</Text>
    {subtitle ? <Text style={[typo.bodySmall, { marginTop: 4, textAlign: "center" }]}>{subtitle}</Text> : null}
    {actionLabel && onAction ? (
      <View style={{ marginTop: spacing.md, minWidth: 160 }}>
        <Button title={actionLabel} onPress={onAction} variant="outline" testID={testID ? `${testID}-action` : undefined} />
      </View>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", padding: spacing.xxl },
});
