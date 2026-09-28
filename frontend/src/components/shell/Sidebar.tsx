// Persistent collapsible left sidebar — desktop/large-tablet navigation.
// Expanded: icon + label. Collapsed: icons only, with tooltips on web hover.
// MAJOR SECTIONS ONLY — sub-workflows live inside their section as in-page
// tabs or landing cards (see nav-config.ts).
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { useSidebarCollapsed } from "@/src/hooks/use-sidebar-collapsed";
import { NAV_ITEMS, activeSectionForPath } from "./nav-config";

const DASHBOARD_QUICK_ACTIONS: { label: string; route: string; icon: React.ComponentProps<typeof Ionicons>["name"]; primary?: boolean; testID: string }[] = [
  { label: "New Rental", route: "/(app)/operations/new-rental", icon: "add", primary: true, testID: "sidebar-new-rental" },
  { label: "Check In", route: "/(app)/inventory/tools", icon: "log-in-outline", testID: "sidebar-check-in" },
  { label: "Check Out", route: "/(app)/inventory/tools", icon: "log-out-outline", testID: "sidebar-check-out" },
  { label: "Add Equipment", route: "/(app)/inventory/equipment?new=1", icon: "cube-outline", testID: "sidebar-add-equipment" },
];

export const SIDEBAR_EXPANDED_W = 168;
export const SIDEBAR_COLLAPSED_W = 60;

export const Sidebar: React.FC<{ brandName?: string }> = ({ brandName = "MobileOps" }) => {
  const router = useRouter();
  const pathname = usePathname();
  const { collapsed, toggle } = useSidebarCollapsed();
  const [hover, setHover] = useState<string | null>(null);
  const activeSection = activeSectionForPath(pathname);

  const width = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W;

  return (
    <View style={[styles.wrap, { width }]} testID="sidebar">
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <Text style={styles.brandLetter}>M</Text>
        </View>
        {!collapsed ? <View style={styles.brandCopy}><Text style={styles.brandText} numberOfLines={1}>{brandName}</Text><Text style={styles.brandTagline} numberOfLines={1}>ICF · RENTAL · OPERATIONS</Text></View> : null}
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: spacing.sm }}>
        {NAV_ITEMS.map((item) => {
          const active = activeSection === item.key;
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
                accessibilityLabel={item.label}
                accessibilityRole="link"
                accessibilityState={{ selected: active }}
              >
                <Ionicons name={item.icon} size={17} color={active ? "#FFFFFF" : colors.sidebarItemMuted} />
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
      </ScrollView>

      {!collapsed && activeSection === "dashboard" ? (
        <View style={styles.quickActions}>
          <Text style={styles.quickLabel}>Quick Actions</Text>
          {DASHBOARD_QUICK_ACTIONS.map((action) => (
            <TouchableOpacity
              key={action.label}
              onPress={() => router.push(action.route as any)}
              style={[styles.quickButton, action.primary && styles.quickButtonPrimary]}
              activeOpacity={0.75}
              testID={action.testID}
              accessibilityRole="button"
            >
              <Ionicons name={action.icon} size={16} color={action.primary ? "#FFFFFF" : colors.sidebarText} />
              <Text style={[styles.quickButtonText, action.primary && styles.quickButtonTextPrimary]}>{action.label}</Text>
            </TouchableOpacity>
          ))}
        </View>
      ) : null}

      <TouchableOpacity onPress={toggle} style={styles.collapseBtn} testID="sidebar-toggle" activeOpacity={0.7} accessibilityLabel={collapsed ? "Expand sidebar" : "Collapse sidebar"} accessibilityRole="button">
        <Ionicons name={collapsed ? "chevron-forward" : "chevron-back"} size={14} color={colors.sidebarItemMuted} />
        {!collapsed ? <Text style={styles.collapseText}>Collapse</Text> : null}
      </TouchableOpacity>
    </View>
  );
};

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
    height: 50,
    borderBottomWidth: 1,
    borderBottomColor: colors.sidebarBorder,
  },
  brandMark: { width: 24, height: 24, borderRadius: radii.sm, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  brandLetter: { color: "#FFF", fontSize: 13, fontWeight: "700" },
  brandText: { ...typo.h3, fontSize: 14, color: colors.sidebarText, fontWeight: "700" },
  brandCopy: { flex: 1, minWidth: 0 },
  brandTagline: { marginTop: 1, fontSize: 7.5, fontWeight: "700", letterSpacing: 0.55, color: colors.sidebarItemMuted },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    height: 38,
    paddingHorizontal: 10,
    marginHorizontal: 6,
    borderRadius: radii.sm,
  },
  itemCollapsed: { justifyContent: "center", paddingHorizontal: 0, marginHorizontal: 6 },
  itemActive: { backgroundColor: colors.sidebarActive },
  itemLabel: { fontSize: 13.5, color: "#C9D6E8", flex: 1, fontWeight: "500" },
  itemLabelActive: { color: "#FFFFFF", fontWeight: "700" },
  quickActions: { paddingHorizontal: 12, paddingBottom: 10 },
  quickLabel: { marginBottom: 7, fontSize: 10, fontWeight: "700", color: colors.sidebarItemMuted },
  quickButton: { minHeight: 34, flexDirection: "row", alignItems: "center", gap: 9, paddingHorizontal: 12, marginBottom: 5, borderWidth: 1, borderColor: colors.sidebarBorder, borderRadius: radii.md, backgroundColor: "#102844" },
  quickButtonPrimary: { backgroundColor: colors.primary, borderColor: colors.primary },
  quickButtonText: { fontSize: 11.5, fontWeight: "600", color: colors.sidebarText },
  quickButtonTextPrimary: { color: "#FFFFFF", fontWeight: "700" },
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
