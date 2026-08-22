import React from "react";
import { View, TextInput, StyleSheet, TouchableOpacity } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { colors, radii } from "@/src/theme";

export const SearchInput: React.FC<{
  value: string;
  onChangeText: (t: string) => void;
  placeholder?: string;
  testID?: string;
  style?: any;
}> = ({ value, onChangeText, placeholder = "Search…", testID, style }) => (
  <View style={[styles.wrap, style]}>
    <Ionicons name="search" size={15} color={colors.inkMuted} />
    <TextInput
      value={value}
      onChangeText={onChangeText}
      placeholder={placeholder}
      placeholderTextColor={colors.inkMuted}
      style={styles.input}
      testID={testID}
    />
    {value ? (
      <TouchableOpacity onPress={() => onChangeText("")} testID={testID ? `${testID}-clear` : undefined}>
        <Ionicons name="close-circle" size={16} color={colors.inkMuted} />
      </TouchableOpacity>
    ) : null}
  </View>
);

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row", alignItems: "center", gap: 8,
    height: 40, minWidth: 220, paddingHorizontal: 12,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.bg,
  },
  input: { flex: 1, fontSize: 14, color: colors.ink, height: "100%" },
});
