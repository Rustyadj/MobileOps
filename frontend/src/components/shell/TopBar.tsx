// Top application bar — hamburger/sidebar toggle, breadcrumb, global search,
// + New, notifications, help, and the user/profile menu. Rendered above the
// routed Stack on tablet/desktop widths (AppShell decides when to mount it).
import React, { useState } from "react";
import { View, Text, StyleSheet, TouchableOpacity } from "react-native";
import { usePathname, useRouter } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { colors, spacing, radii, type as typo } from "@/src/theme";
import { useAuth } from "@/src/context/AuthContext";
import { useCommandMenu } from "@/src/context/CommandMenuContext";
import { useNeedsAttention } from "@/src/hooks/use-needs-attention";
import { useSidebarCollapsed } from "@/src/hooks/use-sidebar-collapsed";
import { breadcrumbForPath } from "./nav-config";
import { SyncStatusBadge } from "./SyncStatusBadge";

export const TOPBAR_HEIGHT = 56;

const ROLE_LABEL: Record<string, string> = {
  admin: "Operations Manager",
  foreman: "Foreman",
  crew: "Crew",
};

export const TopBar: React.FC = () => {
  const pathname = usePathname();
  const { user, logout } = useAuth();
  const { openSearch, openNew } = useCommandMenu();
  const { items, error: attentionError } = useNeedsAttention();
  const { toggle: toggleSidebar } = useSidebarCollapsed();
  const router = useRouter();
  const [profileOpen, setProfileOpen] = useState(false);

  const { section, page } = breadcrumbForPath(pathname);
  const initials = (user?.name || user?.email || "?").split(" ").filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase() || "").join("") || "?";
  const roleLabel = user?.title || (user?.role ? (ROLE_LABEL[user.role] || user.role) : "");

  return (
    <View style={styles.wrap} testID="topbar">
      <TouchableOpacity onPress={toggleSidebar} style={styles.iconBtn} testID="topbar-sidebar-toggle" accessibilityLabel="Toggle sidebar" accessibilityRole="button">
        <Ionicons name="menu-outline" size={20} color={colors.inkSecondary} />
      </TouchableOpacity>

      <View style={styles.breadcrumb}>
        <Text style={styles.crumbMuted} numberOfLines={1}>{section}</Text>
        <Ionicons name="chevron-forward" size={12} color={colors.inkMuted} style={{ marginHorizontal: 4 }} />
        <Text style={styles.crumbActive} numberOfLines={1}>{page}</Text>
      </View>

      <TouchableOpacity onPress={openSearch} style={styles.searchBtn} testID="topbar-search" activeOpacity={0.7} accessibilityLabel="Search rentals, equipment, sites, contacts" accessibilityRole="button">
        <Ionicons name="search" size={15} color={colors.inkMuted} />
        <Text style={styles.searchText} numberOfLines={1}>Search rentals, equipment, sites, contacts…</Text>
        <View style={styles.kbd}><Text style={styles.kbdText}>⌘K</Text></View>
      </TouchableOpacity>

      <TouchableOpacity onPress={openNew} style={styles.newBtn} testID="topbar-new" activeOpacity={0.85} accessibilityLabel="Create new" accessibilityRole="button">
        <Ionicons name="add" size={15} color="#FFF" />
        <Text style={styles.newText}>New</Text>
      </TouchableOpacity>

      <TouchableOpacity
        onPress={() => router.push("/(app)" as any)}
        style={styles.iconBtn}
        testID="topbar-attention"
        accessibilityLabel={attentionError ? "Needs attention (data may be incomplete — some sources failed to load)" : `Needs attention, ${items.length} item${items.length === 1 ? "" : "s"}`}
        accessibilityRole="button"
      >
        <Ionicons name="notifications-outline" size={18} color={colors.inkSecondary} />
        {attentionError ? (
          <View style={[styles.badge, styles.badgeWarning]}>
            <Ionicons name="warning-outline" size={9} color="#FFF" />
          </View>
        ) : items.length > 0 ? (
          <View style={styles.badge}>
            <Text style={styles.badgeText}>{items.length > 9 ? "9+" : items.length}</Text>
          </View>
        ) : null}
      </TouchableOpacity>

      <SyncStatusBadge />

      <View style={styles.helpBtn}>
        <Text style={styles.helpText}>?</Text>
      </View>

      <View>
        <TouchableOpacity onPress={() => setProfileOpen((o) => !o)} style={styles.profileBtn} testID="topbar-profile" activeOpacity={0.75} accessibilityLabel={`Account menu for ${user?.name || "current user"}`} accessibilityRole="button">
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{initials}</Text>
          </View>
          <View style={styles.profileNames}>
            <Text style={styles.profileName} numberOfLines={1}>{user?.name || ""}</Text>
            <Text style={styles.profileRole} numberOfLines={1}>{roleLabel}</Text>
          </View>
          <Ionicons name="chevron-down" size={13} color={colors.inkMuted} />
        </TouchableOpacity>
        {profileOpen ? (
          <>
            <TouchableOpacity style={StyleSheet.absoluteFillObject as any} activeOpacity={1} onPress={() => setProfileOpen(false)} />
            <View style={styles.profileMenu} testID="topbar-profile-menu">
              <Text style={typo.body} numberOfLines={1}>{user?.name}</Text>
              <Text style={[typo.bodySmall, { marginTop: 2 }]} numberOfLines={1}>{user?.email}</Text>
              <View style={styles.roleTag}><Text style={styles.roleText}>{user?.role}</Text></View>
              <View style={styles.menuDivider} />
              <TouchableOpacity onPress={logout} style={styles.menuItem} testID="topbar-signout" accessibilityLabel="Sign out" accessibilityRole="button">
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
    paddingHorizontal: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.bg,
  },
  breadcrumb: { flexDirection: "row", alignItems: "center", minWidth: 0 },
  crumbMuted: { fontSize: 12.5, color: colors.inkMuted, fontWeight: "500" },
  crumbActive: { fontSize: 13, color: colors.ink, fontWeight: "700" },
  searchBtn: {
    flexDirection: "row", alignItems: "center", gap: 8,
    height: 34, paddingHorizontal: 10, flex: 1, maxWidth: 460, marginLeft: spacing.md,
    borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    backgroundColor: colors.bgMuted,
  },
  searchText: { flex: 1, fontSize: 12.5, color: colors.inkMuted },
  kbd: { borderWidth: 1, borderColor: colors.border, borderRadius: radii.sm, paddingHorizontal: 5, paddingVertical: 1 },
  kbdText: { fontSize: 10, fontWeight: "700", color: colors.inkMuted },
  newBtn: {
    flexDirection: "row", alignItems: "center", gap: 6,
    height: 32, paddingHorizontal: 12,
    backgroundColor: colors.primary, borderRadius: radii.md,
    marginLeft: "auto",
  },
  newText: { color: "#FFF", fontSize: 12.5, fontWeight: "700" },
  iconBtn: { width: 32, height: 32, alignItems: "center", justifyContent: "center", borderRadius: radii.md },
  helpBtn: { width: 24, height: 24, borderRadius: 12, borderWidth: 1, borderColor: colors.border, alignItems: "center", justifyContent: "center" },
  helpText: { fontSize: 12, fontWeight: "700", color: colors.inkMuted },
  badge: { position: "absolute", top: 2, right: 2, minWidth: 15, height: 15, borderRadius: 8, backgroundColor: colors.accent, alignItems: "center", justifyContent: "center", paddingHorizontal: 3 },
  badgeWarning: { backgroundColor: colors.error },
  badgeText: { color: "#FFF", fontSize: 9, fontWeight: "700" },
  profileBtn: { flexDirection: "row", alignItems: "center", gap: 8, paddingLeft: 4, paddingRight: 2 },
  avatar: { width: 30, height: 30, borderRadius: 15, backgroundColor: colors.primary, alignItems: "center", justifyContent: "center" },
  avatarText: { color: "#FFF", fontSize: 11.5, fontWeight: "700" },
  profileNames: { alignItems: "flex-start" },
  profileName: { fontSize: 12.5, fontWeight: "700", color: colors.ink, lineHeight: 15 },
  profileRole: { fontSize: 10.5, color: colors.inkMuted, lineHeight: 13 },
  profileMenu: {
    position: "absolute", top: 44, right: 0, width: 220, zIndex: 100,
    backgroundColor: colors.bg, borderWidth: 1, borderColor: colors.border, borderRadius: radii.md,
    padding: spacing.md,
  },
  roleTag: { marginTop: 6, alignSelf: "flex-start", backgroundColor: colors.bgTint, paddingHorizontal: 8, paddingVertical: 2, borderRadius: radii.sm },
  roleText: { fontSize: 10, fontWeight: "700", letterSpacing: 0.4, textTransform: "uppercase", color: colors.inkSecondary },
  menuDivider: { height: 1, backgroundColor: colors.border, marginVertical: spacing.sm },
  menuItem: { flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 6 },
});
