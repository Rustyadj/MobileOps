// In-page section tab bar. This is how a major sidebar section exposes its
// sub-workflows (Rentals -> Inbound/Outbound/Active/History) WITHOUT adding
// duplicate rows to the sidebar. Horizontal, scrollable on narrow screens,
// with an optional count badge per tab.
import React from "react";
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from "react-native";
import { useRouter } from "expo-router";
import { colors, spacing, radii } from "@/src/theme";

export type SectionTab = { key: string; label: string; route: string; count?: number; testID?: string };

export const SectionTabs: React.FC<{ tabs: SectionTab[]; active: string; testID?: string }> = ({ tabs, active, testID = "section-tabs" }) => {
  const router = useRouter();
  return (
    <View style={styles.wrap} testID={testID}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.row}>
        {tabs.map((tab) => {
          const isActive = tab.key === active;
          return (
            <TouchableOpacity
              key={tab.key}
              onPress={() => { if (!isActive) router.replace(tab.route as any); }}
              style={[styles.tab, isActive && styles.tabActive]}
              activeOpacity={0.7}
              accessibilityRole="tab"
              accessibilityState={{ selected: isActive }}
              testID={tab.testID || `${testID}-${tab.key}`}
            >
              <Text style={[styles.label, isActive && styles.labelActive]}>{tab.label}</Text>
              {typeof tab.count === "number" ? (
                <View style={[styles.badge, isActive && styles.badgeActive]}>
                  <Text style={[styles.badgeText, isActive && styles.badgeTextActive]}>{tab.count}</Text>
                </View>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </ScrollView>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: { borderBottomWidth: 1, borderBottomColor: colors.border, backgroundColor: colors.bg },
  row: { gap: spacing.xs, paddingHorizontal: spacing.md, alignItems: "flex-end" },
  tab: {
    flexDirection: "row", alignItems: "center", gap: 6,
    height: 42, paddingHorizontal: 14,
    borderBottomWidth: 2, borderBottomColor: "transparent",
  },
  tabActive: { borderBottomColor: colors.primary },
  label: { fontSize: 13.5, fontWeight: "600", color: colors.inkSecondary },
  labelActive: { color: colors.primary, fontWeight: "700" },
  badge: { minWidth: 20, paddingHorizontal: 6, height: 18, borderRadius: radii.sm, backgroundColor: colors.bgTint, alignItems: "center", justifyContent: "center" },
  badgeActive: { backgroundColor: colors.primarySoft },
  badgeText: { fontSize: 11, fontWeight: "700", color: colors.inkSecondary },
  badgeTextActive: { color: colors.primary },
});
