// Reorganized 5-item bottom nav for phones: Home / Operations / Assets /
// Tools / Menu. Secondary destinations (Vendors, Site Admin, account) live
// behind Menu instead of crowding the bar.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { colors } from "@/src/theme";
import { MOBILE_TABS, activeSectionForPath } from "./nav-config";

const TAB_TO_SECTION: Record<string, string> = {
  home: "overview",
  operations: "operations",
  assets: "assets",
  tools: "tools",
  menu: "menu",
};

export const MobileBottomNav: React.FC = () => {
  const router = useRouter();
  const pathname = usePathname();
  const insets = useSafeAreaInsets();
  const activeSection = activeSectionForPath(pathname);

  return (
    <View style={[styles.wrap, { height: 58 + insets.bottom, paddingBottom: insets.bottom }]} testID="mobile-bottom-nav">
      {MOBILE_TABS.map((tab) => {
        const active = TAB_TO_SECTION[tab.key] === activeSection;
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
