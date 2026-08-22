// Top application bar — breadcrumb, global search, + New, attention
// indicator, and the user/profile menu. Rendered above the routed Stack on
// tablet/desktop widths (AppShell decides when to mount it).
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { useCommandMenu } from "@/src/context/CommandMenuContext";
import { useNeedsAttention } from "@/src/hooks/use-needs-attention";
import { breadcrumbForPath } from "./nav-config";

export const TOPBAR_HEIGHT = 56;

export const TopBar: React.FC = () => {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { openSearch, openNew } = useCommandMenu();
  const { items } = useNeedsAttention();
  const router = useRouter();
  const [profileOpen, setProfileOpen] = useState(false);

  const { section, page } = breadcrumbForPath(pathname);
  const initials = (user?.name || user?.email || "?").split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("") || "?";

  return (
    <View style={styles.wrap} testID="topbar">
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text style={styles.crumb} numberOfLines={1}>{section}</Text>
        <Text style={styles.title} numberOfLines={1}>{page}</Text>
      </View>

      <TouchableOpacity onPress={openSearch} style={styles.searchBtn} testID="topbar-search" activeOpacity={0.7}>
        <Ionicons name="search" size={15} color={colors.inkMuted} />
        <Text style={styles.searchText}>Search…</Text>
        <View style={styles.kbd}><Text style={styles.kbdText}>⌘K</Text></View>
      </TouchableOpacity>

      <TouchableOpacity onPress={openNew} style={styles.newBtn} testID="topbar-new" activeOpacity={0.85}>
        <Ionicons name="add" size={16} color="#FFF" />
        <Text style={styles.newText}>New</Text>
      </TouchableOpacity>

      <TouchableOpacity onPress={() => router.push("/(app)" as any)} style={styles.iconBtn} testID="topbar-attention">
        <Ionicons name="notifications-outline" size={19} color={colors.inkSecondary} />
        {items.length > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{items.length > 9 ? "9+" : items.length}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <View>
        <TouchableOpacity onPress={() => setProfileOpen((o) => !o)} style={styles.avatar} testID="topbar-profile">
          <Text style={styles.avatarText}>{initials}</Text>
        </TouchableOpacity>
        {profileOpen ? (
          <>
            <TouchableOpacity style={StyleSheet.absoluteFillObject as any} activeOpacity={1} onPress={() => setProfileOpen(false)} />
            <View style={styles.profileMenu} testID="topbar-profile-menu">
              <Text style={typo.body} numberOfLines={1}>{user?.name}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]} numberOfLines={1}>{user?.email}</Text>
              <View style={styles.roleTag}><Text style={styles.roleText}>{user?.role}</Text></View>
              <View style={styles.menuDivider} />
              <TouchableOpacity onPress={logout} style={styles.menuItem} testID="topbar-signout">
                <Ionicons name="log-out-outline" size={16} color={colors.error} />
                <Text style={[typo.body, { color: colors.error, fontSize: 13 }]}>Sign out</Text>
              </TouchableOpacity>
            </View>
          </>
        ) : null}
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  wrap: {
    height: TOPBAR_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  crumb: { ...typo.caption, marginBottom: 0 },
  title: { ...typo.h3, fontSize: 15 },
  searchBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    height: 34, paddingHorizontal: 10, minWidth: 220,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.bgMuted,
  },
  searchText: { flex: 1, fontSize: 12.5, color: colors.inkMuted },
  kbd: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 5, paddingVertical: 1 },
  kbdText: { fontSize: 10, fontWeight: "700", color: colors.inkMuted },
  newBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    height: 34, paddingHorizontal: 14,
    backgroundColor: colors.accent, borderRadius: radii.md,
  },
  newText: { color: "#FFF", fontSize: 13, fontWeight: "700" },
  iconBtn: { width: 34, height: 34, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  badge: { position: "absolute", top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 8, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  badgeText: { color: "#FFF", fontSize: 9, fontWeight: "700" },
  avatar: { width: 32, height: 32, borderRadius: 16, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFF", fontSize: 12, fontWeight: "700" },
  profileMenu: {
    position: "absolute", top: 40, right: 0, width: 220, zIndex: 100,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    padding: spacing.md,
  },
  roleTag: { marginTop: 6, alignSelf: "flex-start", backgroundColor: colors.bgTint, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.sm },
  roleText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", color: colors.inkSecondary },
  menuDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
});
