// Persistent collapsible left sidebar — desktop/large-tablet navigation.
// Expanded: icon + label. Collapsed: icons only, with tooltips on web hover.
import React, { useEffect, useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView, Platform } from "react-native";
import { useRouter, usePathname } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { storage } from "@/src/utils/storage";
import { NAV_SECTIONS } from "./nav-config";

const COLLAPSE_KEY = "cf_sidebar_collapsed";
export const SIDEBAR_EXPANDED_W = 248;
export const SIDEBAR_COLLAPSED_W = 68;

export const Sidebar: React.FC<{ brandName?: string }> = ({ brandName = "Concrete Form" }) => {
  const router = useRouter();
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);
  const [hover, setHover] = useState<string | null>(null);

  useEffect(() => {
    storage.getItem<boolean>(COLLAPSE_KEY, false).then((v) => setCollapsed(!!v));
  }, []);

  const toggle = () => {
    setCollapsed((c) => {
      storage.setItem(COLLAPSE_KEY, !c);
      return !c;
    });
  };

  const width = collapsed ? SIDEBAR_COLLAPSED_W : SIDEBAR_EXPANDED_W;

  return (
    <View style={[styles.wrap, { width }]} testID="sidebar">
      <View style={styles.brandRow}>
        <View style={styles.brandMark}>
          <Text style={styles.brandLetter}>C</Text>
        </View>
        {!collapsed ? <Text style={styles.brandText} numberOfLines={1}>{brandName}</Text> : null}
      </View>

      <ScrollView style={{ flex: 1 }} showsVerticalScrollIndicator={false} contentContainerStyle={{ paddingVertical: spacing.sm }}>
        {NAV_SECTIONS.map((section) => (
          <View key={section.key} style={{ marginBottom: spacing.sm }}>
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
                    activeOpacity={0.7}
                    testID={item.testID}
                  >
                    <Ionicons name={item.icon} size={18} color={active ? "#FFFFFF" : "#94A3B8"} />
                    {!collapsed ? (
                      <Text style={[styles.itemLabel, active && styles.itemLabelActive]} numberOfLines={1}>
                        {item.label}
                      </Text>
                    ) : null}
                    {active ? <View style={styles.activeBar} /> : null}
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
        <Ionicons name={collapsed ? "chevron-forward" : "chevron-back"} size={16} color="#94A3B8" />
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
    backgroundColor: "#0B1835",
    borderRightWidth: 1,
    borderRightColor: "#172B52",
    ...(Platform.OS === "web" ? ({ transition: "width 150ms ease-out" } as any) : null),
  },
  brandRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingHorizontal: 14,
    height: 56,
    borderBottomWidth: 1,
    borderBottomColor: "#172B52",
  },
  brandMark: { width: 28, height: 28, borderRadius: radii.sm, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center" },
  brandLetter: { color: "#FFF", fontSize: 15, fontWeight: "700" },
  brandText: { ...typo.h3, fontSize: 15, color: "#F8FAFC" },
  sectionLabel: { ...typo.caption, color: "#64748B", paddingHorizontal: 14, marginTop: spacing.sm, marginBottom: 6 },
  collapsedDivider: { height: 1, backgroundColor: "#172B52", marginHorizontal: 14, marginTop: spacing.sm, marginBottom: spacing.sm },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    height: 38,
    paddingHorizontal: 14,
    marginHorizontal: 8,
    borderRadius: radii.sm,
  },
  itemCollapsed: { justifyContent: "center", paddingHorizontal: 0, marginHorizontal: 8 },
  itemActive: { backgroundColor: "#1D3A70" },
  itemLabel: { ...typo.body, fontSize: 13.5, color: "#CBD5E1", flex: 1 },
  itemLabelActive: { color: "#FFFFFF", fontWeight: "700" },
  activeBar: { position: "absolute", left: -8, top: 6, bottom: 6, width: 3, borderRadius: 2, backgroundColor: colors.accent },
  collapseBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    height: 44,
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: "#172B52",
  },
  collapseText: { ...typo.label, color: "#94A3B8" },
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
