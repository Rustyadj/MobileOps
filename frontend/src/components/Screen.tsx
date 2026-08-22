// Corporate screen scaffold. On phone this renders its own header (title +
// back + right action) above a scroll view. On tablet/desktop the AppShell's
// TopBar already carries the page title/breadcrumb, so Screen skips its own
// header there and just provides the scrollable body — avoiding a duplicate
// title bar. Pass `desktopHeader` to keep a compact in-body header anyway
// (used by screens that need page-level actions the TopBar doesn't carry).
import React from "react";
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, RefreshControl } from "react-native";
import { SafeAreaView, useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, type as typo, maxContentWidth } from "@/src/theme";
import { useRouter } from "expo-router";
import { useBreakpoint } from "@/src/hooks/use-breakpoint";

type Props = {
  title: string;
  subtitle?: string;
  back?: boolean;
  rightAction?: { icon: keyof typeof Ionicons.glyphMap; onPress: () => void; testID?: string };
  children: React.ReactNode;
  scroll?: boolean;
  refreshing?: boolean;
  onRefresh?: () => void;
  testID?: string;
  desktopHeader?: React.ReactNode; // optional compact header shown even on wide shell
  clampWidth?: boolean; // clamp body to maxContentWidth and center (desktop forms)
};

export const Screen: React.FC<Props> = ({ title, subtitle, back, rightAction, children, scroll = true, refreshing, onRefresh, testID, desktopHeader, clampWidth }) => {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { isShellWide } = useBreakpoint();

  const Header = (
    <View style={[styles.header, { paddingTop: insets.top + 12 }]}>
      {back ? (
        <TouchableOpacity onPress={() => router.back()} style={styles.iconBtn} testID="header-back">
          <Ionicons name="chevron-back" size={22} color={colors.ink} />
        </TouchableOpacity>
      ) : null}
      <View style={{ flex: 1 }}>
        <Text style={styles.title}>{title}</Text>
        {subtitle ? <Text style={styles.subtitle}>{subtitle}</Text> : null}
      </View>
      {rightAction ? (
        <TouchableOpacity onPress={rightAction.onPress} style={styles.iconBtn} testID={rightAction.testID}>
          <Ionicons name={rightAction.icon} size={22} color={colors.ink} />
        </TouchableOpacity>
      ) : null}
    </View>
  );

  const body = (
    <View style={clampWidth ? { maxWidth: maxContentWidth, width: "100%", alignSelf: "center" } : undefined}>
      {children}
    </View>
  );

  return (
    <SafeAreaView edges={isShellWide ? [] : ["top"]} style={styles.safe} testID={testID}>
      {isShellWide ? desktopHeader ?? null : Header}
      {scroll ? (
        <ScrollView
          contentContainerStyle={styles.scroll}
          showsVerticalScrollIndicator={false}
          refreshControl={onRefresh ? <RefreshControl refreshing={!!refreshing} onRefresh={onRefresh} tintColor={colors.primary} /> : undefined}
        >
          {body}
        </ScrollView>
      ) : (
        <View style={{ flex: 1 }}>{body}</View>
      )}
    </SafeAreaView>
  );
};

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: colors.bg },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: spacing.lg,
    paddingBottom: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
    gap: spacing.sm,
  },
  title: { ...typo.h2, fontSize: 18, color: colors.ink },
  subtitle: { ...typo.bodySmall, marginTop: 2, fontSize: 12 },
  iconBtn: { padding: 8, minWidth: 40, minHeight: 40, alignItems: "center", justifyContent: "center" },
  scroll: { padding: spacing.lg, paddingBottom: 80 },
});
