// Persistent collapsible left sidebar — desktop/large-tablet navigation.
// Expanded: icon + label. Collapsed: icons only, with tooltips on web hover.
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { useSidebarCollapsed } from "@/src/hooks/use-sidebar-collapsed";
import { NAV_SECTIONS } from "./nav-config";

export const SIDEBAR_EXPANDED_W = 180;
export const SIDEBAR_COLLAPSED_W = 60;

export const Sidebar: React.FC<{ brandName?: string }> = ({ brandName = "MobileOps" }) => {
  const router = useRouter();
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarCollapsed();
  const [hover, setHover] = useState<string | null>(null);

  const width = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W;

  return (
    <View style={[styles.wrap, { width }]} testID="sidebar">
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <Text style={styles.brandLetter}>M</Text>
        </View>
        {!collapsed ? <Text style={styles.brandText} numberOfLines={1}>{brandName}</Text> : null}
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: spacing.sm }}>
        {NAV_SECTIONS.map((section) => (
          <View key={section.key} style={{ marginBottom: 6 }}>
            {!collapsed ? <Text style={styles.sectionLabel}>{section.label}</Text> : <View style={styles.collapsedDivider} />}
            {section.items.map((item) => {
              const active = pathname === routeToPath(item.route);
              return (
                <View
                  key={item.key}
                  // @ts-ignore — web-only hover events, harmless no-op on native
                  onMouseEnter={Platform.OS === "web" ? () => setHover(item.key) : undefined}
                  // @ts-ignore
                  onMouseLeave={Platform.OS === "web" ? () => setHover(null) : undefined}
                >
                  <TouchableOpacity
                    onPress={() => router.push(item.route as any)}
                    style={[styles.item, active && styles.itemActive, collapsed && styles.itemCollapsed]}
                    activeOpacity={0.75}
                    testID={item.testID}
                  >
                    <Ionicons name={item.icon} size={16} color={active ? "#FFFFFF" : colors.sidebarItemMuted} />
                    {!collapsed ? (
                      <Text style={[styles.itemLabel, active && styles.itemLabelActive]} numberOfLines={1}>
                        {item.label}
                      </Text>
                    ) : null}
                  </TouchableOpacity>
                  {collapsed && hover === item.key ? (
                    <View style={styles.tooltip} pointerEvents="none">
                      <Text style={styles.tooltipText}>{item.label}</Text>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        ))}
      </ScrollView>

      <TouchableOpacity onPress={toggle} style={styles.collapseBtn} testID="sidebar-toggle" activeOpacity={0.7}>
        <Ionicons name={collapsed ? "chevron-forward" : "chevron-back"} size={14} color={colors.sidebarItemMuted} />
        {!collapsed ? <Text style={styles.collapseText}>Collapse</Text> : null}
      </TouchableOpacity>
    </View>
  );
};

function routeToPath(route: string): string {
  if (route === "/(app)") return "/";
  return route.replace("/(app)", "");
}

const styles = StyleSheet.create({
  wrap: {
    height: "100%",
    backgroundColor: colors.sidebar,
    borderRightWidth: 1,
    borderRightColor: colors.sidebarBorder,
    ...(Platform.OS === "web" ? ({ transition: "width 150ms ease-out" } as any) : null),
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
    height: 52,
    borderBottomWidth: 1,
    borderBottomColor: colors.sidebarBorder,
  },
  brandMark: { width: 24, height: 24, borderRadius: radii.sm, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  brandLetter: { color: "#FFF", fontSize: 13, fontWeight: "700" },
  brandText: { ...typo.h3, fontSize: 14, color: colors.sidebarText, fontWeight: "700" },
  sectionLabel: { fontSize: 10, fontWeight: "700", color: "#5E7191", textTransform: "uppercase", letterSpacing: 0.6, paddingHorizontal: 12, marginTop: 10, marginBottom: 5 },
  collapsedDivider: { height: 1, backgroundColor: colors.sidebarBorder, marginHorizontal: 12, marginTop: spacing.sm, marginBottom: spacing.sm },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 32,
    paddingHorizontal: 10,
    marginHorizontal: 6,
    borderRadius: radii.sm,
  },
  itemCollapsed: { justifyContent: "center", paddingHorizontal: 0, marginHorizontal: 6 },
  itemActive: { backgroundColor: colors.sidebarActive },
  itemLabel: { fontSize: 12.5, color: "#C9D6E8", flex: 1, fontWeight: "500" },
  itemLabelActive: { color: "#FFFFFF", fontWeight: "700" },
  collapseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 38,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: colors.sidebarBorder,
  },
  collapseText: { fontSize: 11.5, fontWeight: "600", color: colors.sidebarItemMuted },
  tooltip: {
    position: "absolute",
    left: SIDEBAR_COLLAPSED_W + 4,
    top: 4,
    backgroundColor: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radii.sm,
    zIndex: 50,
  },
  tooltipText: { color: "#FFF", fontSize: 12, fontWeight: "600" },
});
