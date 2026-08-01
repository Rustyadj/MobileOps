// Corporate UI primitives — soft borders, rounded corners, restrained typography.
import React from "react";
import {
  View, Text, TouchableOpacity, TextInput, StyleSheet,
  ViewStyle, TextStyle, StyleProp, TextInputProps, ActivityIndicator,
} from "react-native";
import { colors, type as typo, spacing, radii, shadows } from "@/src/theme";

export const Card: React.FC<{ children: React.ReactNode; style?: StyleProp<ViewStyle>; testID?: string }> = ({ children, style, testID }) => (
  <View testID={testID} style={[styles.card, style]}>{children}</View>
);

export const SectionLabel: React.FC<{ children: string; style?: StyleProp<TextStyle> }> = ({ children, style }) => (
  <Text style={[typo.caption, { marginBottom: spacing.sm }, style]}>{children}</Text>
);

export const H1: React.FC<{ children: React.ReactNode; style?: StyleProp<TextStyle> }> = ({ children, style }) => (
  <Text style={[typo.h1, style]}>{children}</Text>
);
export const H2: React.FC<{ children: React.ReactNode; style?: StyleProp<TextStyle> }> = ({ children, style }) => (
  <Text style={[typo.h2, style]}>{children}</Text>
);
export const H3: React.FC<{ children: React.ReactNode; style?: StyleProp<TextStyle> }> = ({ children, style }) => (
  <Text style={[typo.h3, style]}>{children}</Text>
);
export const Mono: React.FC<{ children: React.ReactNode; large?: boolean; style?: StyleProp<TextStyle> }> = ({ children, large, style }) => (
  <Text style={[large ? typo.monoLarge : typo.mono, style]}>{children}</Text>
);

type ButtonProps = {
  title: string;
  onPress: () => void;
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  disabled?: boolean;
  loading?: boolean;
  testID?: string;
  style?: StyleProp<ViewStyle>;
  fullWidth?: boolean;
};

export const Button: React.FC<ButtonProps> = ({ title, onPress, variant = "primary", disabled, loading, testID, style, fullWidth = true }) => {
  const v = btnStyles[variant];
  return (
    <TouchableOpacity
      testID={testID}
      onPress={onPress}
      disabled={disabled || loading}
      activeOpacity={0.85}
      style={[styles.btnBase, v.bg, fullWidth && { alignSelf: "stretch" }, disabled && { opacity: 0.5 }, style]}
    >
      {loading ? (
        <ActivityIndicator color={v.fg.color as string} />
      ) : (
        <Text style={[styles.btnText, v.fg]}>{title}</Text>
      )}
    </TouchableOpacity>
  );
};

export const Input: React.FC<TextInputProps & { label?: string; mono?: boolean; testID?: string }> = ({ label, mono, style, testID, ...rest }) => (
  <View style={{ marginBottom: spacing.md }}>
    {label ? <SectionLabel>{label}</SectionLabel> : null}
    <TextInput
      testID={testID}
      placeholderTextColor={colors.inkMuted}
      {...rest}
      style={[styles.input, mono && { fontFamily: "monospace", fontSize: 15 }, style]}
    />
  </View>
);

export const Pill: React.FC<{ children: string; color?: string; bg?: string; testID?: string }> = ({ children, color = colors.inkSecondary, bg = colors.bgTint, testID }) => (
  <View testID={testID} style={[styles.pill, { backgroundColor: bg, borderColor: "transparent" }]}>
    <Text style={{ color, fontSize: 11, fontWeight: "600", letterSpacing: 0.3 }}>{children}</Text>
  </View>
);

export const Divider: React.FC<{ vertical?: boolean }> = ({ vertical }) => (
  <View style={vertical ? { width: 1, backgroundColor: colors.border, alignSelf: "stretch" } : { height: 1, backgroundColor: colors.border, marginVertical: spacing.md }} />
);

export const Row: React.FC<{ children: React.ReactNode; style?: StyleProp<ViewStyle> }> = ({ children, style }) => (
  <View style={[{ flexDirection: "row", alignItems: "center" }, style]}>{children}</View>
);

const styles = StyleSheet.create({
  card: {
    backgroundColor: colors.bg,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    padding: spacing.md,
    ...shadows.card,
  },
  btnBase: {
    height: 48,
    paddingHorizontal: 20,
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderRadius: radii.md,
  },
  btnText: { fontSize: 14, fontWeight: "600", letterSpacing: 0.2 },
  input: {
    height: 48,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radii.md,
    paddingHorizontal: 14,
    fontSize: 15,
    color: colors.ink,
    backgroundColor: colors.bg,
  },
  pill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radii.sm,
    alignSelf: "flex-start",
  },
});

const btnStyles = {
  primary: { bg: { backgroundColor: colors.primary, borderColor: colors.primary }, fg: { color: "#FFF" } },
  secondary: { bg: { backgroundColor: colors.ink, borderColor: colors.ink }, fg: { color: "#FFF" } },
  outline: { bg: { backgroundColor: colors.bg, borderColor: colors.borderStrong }, fg: { color: colors.ink } },
  ghost: { bg: { backgroundColor: "transparent", borderColor: "transparent" }, fg: { color: colors.primary } },
  danger: { bg: { backgroundColor: colors.error, borderColor: colors.error }, fg: { color: "#FFF" } },
} as const;
