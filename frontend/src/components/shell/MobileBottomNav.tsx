// 5-item bottom nav for phones, mirroring the top of the desktop sidebar:
// Home / Rentals / Inventory / Shop / Menu. Live Feed, Utilities and Admin
// live behind Menu instead of crowding the bar.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/src/theme";
import { MOBILE_TABS, activeSectionForPath } from "./nav-config";

export const MobileBottomNav: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const rawSection = activeSectionForPath(pathname);
  // Utilities/Admin/Live Feed have no bottom-nav tab of their own — they read
  // as "Menu" so the bar never shows a phantom selection.
  const activeSection = ["admin", "utilities", "whiteboard"].includes(rawSection) ? "menu" : rawSection;

  return (
    <View style={[styles.wrap, { height: 58 + insets.bottom, paddingBottom: insets.bottom }]} testID="mobile-bottom-nav">
      {MOBILE_TABS.map((tab) => {
        const active = tab.key === activeSection;
        return (
          <TouchableOpacity
            key={tab.key}
            onPress={() => router.push(tab.route as any)}
            style={styles.tab}
            activeOpacity={0.7}
            testID={tab.testID}
          >
            <Ionicons name={tab.icon} size={22} color={active ? colors.primary : colors.inkMuted} />
            <Text style={[styles.label, active && styles.labelActive]}>{tab.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    flexDirection: "row",
    backgroundColor: colors.bg,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: 6,
  },
  tab: { flex: 1, alignItems: "center", justifyContent: "flex-start", gap: 2, minHeight: 44, paddingTop: 2 },
  label: { fontSize: 10.5, fontWeight: "600", color: colors.inkMuted, letterSpacing: 0.1 },
  labelActive: { color: colors.primary },
});
