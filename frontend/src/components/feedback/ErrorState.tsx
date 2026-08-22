import React from "react";
import { View, Text, StyleSheet } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, type as typo } from "@/src/theme";
import { Button } from "@/src/components/ui";

export const ErrorState: React.FC<{
  message?: string;
  onRetry?: () => void;
  testID?: string;
}> = ({ message = "Something went wrong loading this.", onRetry, testID }) => (
  <View style={styles.wrap} testID={testID}>
    <Ionicons name="alert-circle-outline" size={28} color={colors.error} />
    <Text style={[typo.body, { marginTop: spacing.sm, textAlign: "center" }]}>{message}</Text>
    {onRetry ? (
      <View style={{ marginTop: spacing.md, minWidth: 140 }}>
        <Button title="Retry" onPress={onRetry} variant="outline" testID={testID ? `${testID}-retry` : undefined} />
      </View>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  wrap: { alignItems: "center", justifyContent: "center", padding: spacing.xxl },
});
