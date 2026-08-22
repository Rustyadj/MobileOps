// Persistent sibling-module navigation for desktop/tablet. The sidebar owns
// the complete information architecture; this rail keeps related operational
// modules visible while users work inside a section.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing } from "@/src/theme";
import { NAV_SECTIONS, activeSectionForPath } from "./nav-config";

const RAIL_SECTIONS = new Set(["operations", "inventory", "shop", "tools"]);

function routeToPath(route: string) {
  return route === "/(app)" ? "/" : route.replace("/(app)", "");
}

export const ModuleRail: React.FC = () => {
  const pathname = usePathname();
  const router = useRouter();
  const sectionKey = activeSectionForPath(pathname);
  if (!RAIL_SECTIONS.has(sectionKey)) return null;

  const section = NAV_SECTIONS.find((entry) => entry.key === sectionKey);
  if (!section) return null;

  return (
    <View style={styles.wrap} testID="module-rail">
      <Text style={styles.section}>{section.label}</Text>
      <View style={styles.divider} />
      {section.items.map((item) => {
        const active = pathname === routeToPath(item.route);
        return (
          <TouchableOpacity
            key={item.key}
            onPress={() => router.push(item.route as any)}
            style={[styles.item, active && styles.itemActive]}
            activeOpacity={0.7}
            testID={`rail-${item.key}`}
          >
            <Ionicons name={item.icon} size={14} color={active ? colors.primary : colors.inkMuted} />
            <Text style={[styles.label, active && styles.labelActive]}>{item.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    height: 42,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.xs,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  section: { fontSize: 11, fontWeight: "800", color: colors.inkSecondary, textTransform: "uppercase", letterSpacing: 0.7 },
  divider: { width: 1, height: 18, backgroundColor: colors.border, marginHorizontal: spacing.sm },
  item: { height: 30, flexDirection: "row", alignItems: "center", gap: 6, paddingHorizontal: 10, borderRadius: 4 },
  itemActive: { backgroundColor: colors.primarySoft },
  label: { fontSize: 12.5, fontWeight: "600", color: colors.inkSecondary },
  labelActive: { color: colors.primary },
});
